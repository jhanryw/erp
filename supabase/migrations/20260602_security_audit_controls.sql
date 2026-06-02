-- =============================================================================
-- Migration 20260602 — Controles de Segurança, Auditoria e Anti-Fraude
--
-- DEPENDE DE:
--   001_rls_and_audit.sql  (tabela audit_logs, função get_user_role)
--   20260522_cash_register.sql (cash_register_sessions, cash_movements)
--   20260522_cash_register_rpcs.sql (rpc_cancel_cash_movement)
--
-- O QUE FAZ:
--   1. Trigger de auditoria em cash_register_sessions e cash_movements
--   2. Trigger de auditoria em users (mudança de role/active)
--   3. rpc_cancel_cash_movement atualizado: sangria/suprimento exigem gerente/admin
--   4. rpc_reopen_cash_session novo: apenas admin, com log obrigatório
--   5. RLS bloqueando UPDATE/DELETE direto em cash_register_sessions e cash_movements
--   6. View v_audit_report para relatório de auditoria
--   7. RLS garantindo imutabilidade de audit_logs (sem UPDATE/DELETE)
--
-- IDEMPOTENTE: sim (CREATE OR REPLACE / DROP IF EXISTS / IF NOT EXISTS)
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Função de trigger para tabelas de caixa
--
-- Insere em audit_logs (plural, tabela enriquecida da migration 001).
-- Deriva user_id dos campos do próprio registro para não depender de
-- auth.uid() que pode ser NULL dentro de RPCs SECURITY DEFINER.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.audit_cash_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record_id text;
  v_action    text;
  v_user_id   uuid;
BEGIN
  v_record_id := COALESCE(NEW.id::text, OLD.id::text);

  v_action := CASE TG_OP
    WHEN 'INSERT' THEN 'create'
    WHEN 'UPDATE' THEN 'update'
    WHEN 'DELETE' THEN 'delete'
    ELSE TG_OP
  END;

  -- Derivar user_id do campo do registro (não depende de auth.uid())
  IF TG_TABLE_NAME = 'cash_register_sessions' THEN
    v_user_id := CASE
      WHEN TG_OP = 'DELETE'                           THEN OLD.opened_by
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'closed' THEN NEW.closed_by
      ELSE NEW.opened_by
    END;
  ELSIF TG_TABLE_NAME = 'cash_movements' THEN
    v_user_id := CASE
      WHEN TG_OP = 'UPDATE' AND NEW.cancelled_at IS NOT NULL THEN NEW.cancelled_by
      WHEN TG_OP = 'DELETE'                                  THEN OLD.created_by
      ELSE NEW.created_by
    END;
  ELSIF TG_TABLE_NAME = 'users' THEN
    v_user_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_user_id := auth.uid();
  END IF;

  INSERT INTO public.audit_logs (
    ts,
    user_id,
    user_role,
    action,
    resource,
    resource_id,
    before_data,
    after_data
  )
  VALUES (
    NOW(),
    v_user_id,
    (SELECT role::text FROM public.users WHERE id = v_user_id),
    v_action,
    TG_TABLE_NAME,
    v_record_id,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );

  RETURN COALESCE(NEW, OLD);

EXCEPTION WHEN OTHERS THEN
  -- Log de auditoria nunca deve bloquear a operação principal
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Triggers em cash_register_sessions
DROP TRIGGER IF EXISTS trg_audit_cash_sessions ON public.cash_register_sessions;
CREATE TRIGGER trg_audit_cash_sessions
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION public.audit_cash_trigger();

-- Triggers em cash_movements
DROP TRIGGER IF EXISTS trg_audit_cash_movements ON public.cash_movements;
CREATE TRIGGER trg_audit_cash_movements
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.audit_cash_trigger();

-- Trigger em users — mudança crítica de role ou desativação
DROP TRIGGER IF EXISTS trg_audit_users_role ON public.users;
CREATE TRIGGER trg_audit_users_role
  AFTER UPDATE ON public.users
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.active IS DISTINCT FROM NEW.active
  )
  EXECUTE FUNCTION public.audit_cash_trigger();

-- =============================================================================
-- PARTE 2 — rpc_cancel_cash_movement ATUALIZADO
--
-- sangria/suprimento → apenas gerente/admin (movimentação física de dinheiro)
-- expense            → criador OU gerente/admin
--
-- Motivo: sangria representa saída de dinheiro do caixa; permitir que qualquer
-- usuário cancele seria um vetor de manipulação. Apenas gestores respondem.
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

  -- Empresa e role do usuário
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

  IF v_movement.session_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.session_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível cancelar movimentos.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimento #% já foi cancelado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- Autorização por tipo:
  -- sangria/suprimento exigem gerente ou admin (movimentação física de numerário)
  IF v_movement.type IN ('sangria', 'suprimento') THEN
    IF v_user_role NOT IN ('gerente', 'admin') THEN
      RAISE EXCEPTION 'Cancelamento de sangria/suprimento exige gerente ou administrador.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- expense: criador OU gerente/admin
    IF v_movement.created_by != p_user_id AND v_user_role NOT IN ('gerente', 'admin') THEN
      RAISE EXCEPTION 'Apenas o criador da despesa ou gerente/admin podem cancelar.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

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

-- =============================================================================
-- PARTE 3 — rpc_reopen_cash_session (NOVO)
--
-- Reabre uma sessão fechada. Apenas admin.
-- Motivo obrigatório. Gera log em audit_logs ANTES de reabrir.
-- Impede reabertura se já houver outra sessão aberta.
-- Limpa o snapshot de fechamento para que o novo fechamento seja calculado fresh.
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

  IF v_user_role != 'admin' THEN
    RAISE EXCEPTION 'Apenas administradores podem reabrir um caixa fechado.'
      USING ERRCODE = 'P0001';
  END IF;

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

GRANT EXECUTE ON FUNCTION public.rpc_reopen_cash_session(bigint, uuid, text)
  TO service_role, authenticated;

-- =============================================================================
-- PARTE 4 — RLS: bloquear escrita direta em tabelas de caixa
--
-- Todas as escritas legítimas passam por RPCs SECURITY DEFINER (equivale a
-- service_role e bypassa RLS). Bloquear INSERT/UPDATE/DELETE via authenticated
-- previne edição direta pelo painel Supabase, anon key ou integrações externas.
-- =============================================================================

-- cash_register_sessions: apenas leitura para authenticated
DROP POLICY IF EXISTS "cash_sessions_insert"       ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_update"       ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_delete"       ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_company_write" ON public.cash_register_sessions;
-- (sem policies de INSERT/UPDATE/DELETE = bloqueado para authenticated)

-- cash_movements: apenas leitura para authenticated
DROP POLICY IF EXISTS "cash_movements_insert"       ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_update"       ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_delete"       ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_company_write" ON public.cash_movements;
-- (sem policies de INSERT/UPDATE/DELETE = bloqueado para authenticated)

-- =============================================================================
-- PARTE 5 — RLS imutabilidade de audit_logs
--
-- audit_logs nunca pode ser alterado ou deletado via authenticated.
-- INSERT somente via service_role (RPCs SECURITY DEFINER + app server-side).
-- =============================================================================

-- Remover qualquer policy de escrita que possa existir
DROP POLICY IF EXISTS "audit_logs_insert"    ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_update"    ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_delete"    ON public.audit_logs;
-- Sem INSERT/UPDATE/DELETE policy para authenticated = operações bloqueadas.
-- Leitura: policy "audit_logs_select" (admin only) já criada na migration 001.

-- =============================================================================
-- PARTE 6 — View de relatório de auditoria
--
-- Consultada pelo endpoint GET /api/relatorios/auditoria.
-- Inclui nome do usuário e filtra ações sensíveis para exibição.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_audit_report AS
SELECT
  al.id,
  al.ts,
  al.user_id,
  u.name          AS user_name,
  al.user_role,
  al.action,
  al.resource,
  al.resource_id,
  al.before_data,
  al.after_data,
  al.detail,
  al.ip_address,
  al.request_id
FROM  public.audit_logs al
LEFT  JOIN public.users u ON u.id = al.user_id
ORDER BY al.ts DESC;

-- Apenas gerente e admin podem consultar
DROP POLICY IF EXISTS "v_audit_report_read" ON public.audit_logs;
-- (a view herda a RLS da tabela base audit_logs; a API route valida role)

GRANT SELECT ON public.v_audit_report TO authenticated;

-- =============================================================================
-- PARTE 7 — Grant para funções de caixa existentes (idempotente)
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_cancel_cash_movement(bigint, uuid, text)
  TO service_role, authenticated;

-- =============================================================================
-- PARTE 8 — Smoke tests
-- =============================================================================

-- Triggers criados?
SELECT tgname, tgrelid::regclass AS tabela
FROM   pg_trigger
WHERE  tgname IN (
  'trg_audit_cash_sessions',
  'trg_audit_cash_movements',
  'trg_audit_users_role'
);
-- Esperado: 3 linhas

-- rpc_reopen_cash_session existe?
SELECT routine_name
FROM   information_schema.routines
WHERE  routine_schema = 'public'
  AND  routine_name   = 'rpc_reopen_cash_session';
-- Esperado: 1 linha

-- View v_audit_report existe?
SELECT viewname
FROM   pg_views
WHERE  schemaname = 'public'
  AND  viewname   = 'v_audit_report';
-- Esperado: 1 linha

-- =============================================================================
-- FIM DA MIGRATION 20260602
-- =============================================================================
