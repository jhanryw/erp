-- =============================================================================
-- 20260812_open_cash_rpcs_to_usuario.sql
--
-- Ajuste final de política de acesso: `usuario` = `admin` dentro do próprio
-- tenant, exceto nos 9 módulos explicitamente bloqueados (Financeiro,
-- Inteligência, Relatórios, Comissões, Metas, Fiscal, Configurações,
-- Usuários, Administração do sistema). Caixa NÃO está nessa lista.
--
-- `rpc_reopen_cash_session` e `rpc_cancel_cash_movement` tinham checagem de
-- ROLE embutida na própria função (não só na API route) — reabrir sessão
-- exigia `admin`; cancelar sangria/suprimento exigia `gerente`/`admin`. Com
-- as APIs (`POST /api/caixa/reabrir`, `POST /api/caixa/movimentos/cancelar`)
-- já rebaixadas para `usuario`, deixar o check interno da RPC em
-- 'admin'/'gerente' faria a operação passar pela API e falhar dentro do
-- banco — exatamente o "página aparece, ação falha" que a política pede
-- para evitar.
--
-- NÃO ALTERADO: derivação de identidade (ainda por parâmetro, não
-- auth.uid() — decisão arquitetural registrada na Fase 1, fora do escopo
-- desta mudança), validação de tenant (company_id da sessão/movimento
-- comparado à empresa do usuário), auditoria (audit_logs), qualquer outra
-- regra de negócio. Apenas o piso de ROLE dentro da função foi removido.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. rpc_cancel_cash_movement — remove restrição de role por tipo de movimento
-- Base: 20260602_security_audit_controls.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cancel_cash_movement(
  p_movement_id         bigint,
  p_user_id             uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id  int;
  v_user_role   text;
  v_movement    record;
BEGIN
  -- Motivo obrigatório
  IF TRIM(COALESCE(p_cancellation_reason, '')) = '' THEN
    RAISE EXCEPTION 'Motivo de cancelamento obrigatório.' USING ERRCODE = 'P0001';
  END IF;

  -- Empresa do usuário (v_user_role permanece resolvido, mas não é mais
  -- usado para bloquear — usuario = admin dentro do tenant para Caixa)
  SELECT company_id, role
  INTO   v_company_id, v_user_role
  FROM   users
  WHERE  id = p_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Buscar movimento + dados da sessão
  SELECT
    cm.id,
    cm.type,
    cm.created_by,
    cm.cancelled_at,
    crs.status     AS session_status,
    crs.company_id AS session_company
  INTO v_movement
  FROM cash_movements cm
  JOIN cash_register_sessions crs ON crs.id = cm.cash_session_id
  WHERE cm.id = p_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimento #% não encontrado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- Validação de tenant (preservada — nunca removida)
  IF v_movement.session_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.session_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível cancelar movimentos.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimento #% já foi cancelado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- Autorização: qualquer usuário autenticado da própria empresa pode
  -- cancelar (Caixa não está entre os 9 módulos bloqueados — usuario = admin
  -- aqui). Antes: sangria/suprimento exigia gerente/admin; expense exigia
  -- criador ou gerente/admin.

  UPDATE cash_movements
  SET
    cancelled_at        = NOW(),
    cancelled_by        = p_user_id,
    cancellation_reason = TRIM(p_cancellation_reason)
  WHERE id = p_movement_id;

  RETURN jsonb_build_object(
    'id',                  p_movement_id,
    'type',                v_movement.type,
    'cancelled_at',        NOW(),
    'cancellation_reason', TRIM(p_cancellation_reason)
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. rpc_reopen_cash_session — remove restrição de role 'admin'
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_reopen_cash_session(
  p_session_id bigint,
  p_user_id    uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id int;
  v_user_role  text;
  v_sess       record;
BEGIN
  IF TRIM(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Motivo de reabertura obrigatório.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id, role
  INTO   v_company_id, v_user_role
  FROM   users
  WHERE  id = p_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Autorização: qualquer usuário autenticado da própria empresa pode
  -- reabrir (Caixa não está entre os 9 módulos bloqueados — usuario = admin
  -- aqui). Antes: exigia role = 'admin'.

  -- Verificar se já existe outro caixa aberto para esta empresa
  IF EXISTS (
    SELECT 1 FROM cash_register_sessions
    WHERE  company_id = v_company_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa. Feche-o antes de reabrir outro.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock pessimista
  SELECT * INTO v_sess
  FROM cash_register_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;

  -- Validação de tenant (preservada — nunca removida)
  IF v_sess.company_id != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sess.status = 'open' THEN
    RAISE EXCEPTION 'Esta sessão de caixa já está aberta.' USING ERRCODE = 'P0001';
  END IF;

  -- Log de auditoria com snapshot do estado fechado (antes de limpar)
  INSERT INTO public.audit_logs (
    ts,
    user_id,
    user_role,
    action,
    resource,
    resource_id,
    before_data,
    after_data,
    detail
  )
  VALUES (
    NOW(),
    p_user_id,
    v_user_role,
    'reopen_cash',
    'cash_register_sessions',
    p_session_id::text,
    to_jsonb(v_sess),
    NULL,
    TRIM(p_reason)
  );

  -- Reabrir: limpar snapshot de fechamento, restaurar status open
  UPDATE cash_register_sessions
  SET
    status               = 'open',
    closed_by            = NULL,
    closed_at            = NULL,
    counted_cash         = NULL,
    notes_close          = NULL,
    closing_confirmed_by = NULL,
    total_sales          = NULL,
    total_cash           = NULL,
    total_pix            = NULL,
    total_credit_card    = NULL,
    total_debit_card     = NULL,
    total_card_fees      = NULL,
    total_cash_change    = NULL,
    total_pix_change     = NULL,
    total_sangria        = NULL,
    total_suprimento     = NULL,
    total_expenses       = NULL,
    expected_cash        = NULL,
    cash_difference      = NULL,
    updated_at           = NOW()
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'id',          p_session_id,
    'status',      'open',
    'reopened_at', NOW(),
    'reopened_by', p_user_id,
    'reason',      TRIM(p_reason)
  );
END;
$$;

-- GRANTs não mudam — já eram service_role apenas desde a Fase 1
-- (20260811_fix_rpc_identity_grants_tenant.sql), continuam assim.

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplicar supabase/migrations/20260602_security_audit_controls.sql
-- (PARTE 2 e PARTE 3) para restaurar as checagens de role originais.
-- Não há rollback de dados: esta migration não altera nenhuma linha
-- existente, só o comportamento de autorização de chamadas futuras.
*/
-- =============================================================================
-- FIM DA MIGRATION 20260812
-- =============================================================================
