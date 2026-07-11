-- =============================================================================
-- 20260718_rpc_regularizar_despesa_caixa.sql
--
-- Entrega 3 do plano de correção Caixa × Financeiro — regularização histórica.
--
-- O QUE FAZ:
--   1. Estende audit_logs com 4 colunas nullable (flow, operation,
--      cash_movement_id, finance_entry_id) — genéricas o bastante para
--      reaproveitar em fluxos futuros semelhantes, populadas só por esta RPC
--      por enquanto. Facilita consultas de auditoria sem parsear JSON/texto.
--   2. Cria rpc_regularizar_despesa_caixa — a única escrita desta entrega.
--
-- IDENTIFICAÇÃO DO EXECUTOR — SEM p_user_id:
--   Esta RPC usa auth.uid() para identificar quem a está chamando, em vez de
--   receber um p_user_id como parâmetro. Isso só funciona porque a rota da
--   API chama esta RPC através do client de sessão (createClient(), que
--   encaminha o JWT do próprio usuário autenticado via cookies), NÃO do
--   client admin/service_role — igual ao mecanismo que current_company_id()
--   já usa em toda RLS do projeto (auth.uid() só resolve de verdade quando a
--   requisição carrega o JWT real do usuário). Se alguém chamar esta RPC via
--   service_role (sem JWT de usuário), auth.uid() vem NULL e a função rejeita
--   com "Não autenticado" — nunca executa sem identidade real.
--
-- Não cria financial_payments/allocations. Não cria heurística de duplicidade
-- — o único caso tratado nesta entrega (cash_movement #10 → finance_entry
-- #1382) foi confirmado manualmente e é operado via Fluxo B (link), com o
-- finance_entry_id informado explicitamente pelo operador na tela, não
-- descoberto automaticamente por valor/data/descrição.
--
-- IDEMPOTENTE: sim — ALTER TABLE ... ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION.
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Colunas estruturadas em audit_logs
-- =============================================================================

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS flow              TEXT,
  ADD COLUMN IF NOT EXISTS operation         TEXT,
  ADD COLUMN IF NOT EXISTS cash_movement_id  BIGINT,
  ADD COLUMN IF NOT EXISTS finance_entry_id  INT;

COMMENT ON COLUMN public.audit_logs.flow IS
  'Fluxo da regularização Caixa→Financeiro: A (criação de novo finance_entry) ou B (vínculo a finance_entry existente). NULL para eventos de outros domínios.';
COMMENT ON COLUMN public.audit_logs.operation IS
  'create ou link — mesma semântica de flow, em vocabulário de operação. NULL para eventos de outros domínios.';

-- =============================================================================
-- PARTE 2 — RPC rpc_regularizar_despesa_caixa
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_regularizar_despesa_caixa(
  p_cash_movement_id  bigint,
  p_finance_entry_id  int              DEFAULT NULL,
  p_category          finance_category DEFAULT NULL,
  p_reference_date    date             DEFAULT NULL,
  p_notes             text             DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id          uuid := auth.uid();
  v_user_role        text;
  v_company_id       int;
  v_cm               record;
  v_fe                record;
  v_flow             text;
  v_operation        text;
  v_finance_entry_id int;
  v_before           jsonb;
  v_after            jsonb;
BEGIN
  -- ─── Identidade do executor (auth.uid(), nunca parâmetro) ───────────────────
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado.' USING ERRCODE = 'P0001';
  END IF;

  SELECT role, company_id INTO v_user_role, v_company_id
  FROM users WHERE id = v_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Autorização: só admin (checado aqui dentro, não só na rota) ───────────
  IF v_user_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Apenas administradores podem regularizar despesas do Caixa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Trava e valida o movimento de caixa ────────────────────────────────────
  SELECT * INTO v_cm FROM cash_movements WHERE id = p_cash_movement_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimento de caixa #% não encontrado.', p_cash_movement_id USING ERRCODE = 'P0001';
  END IF;
  IF v_cm.company_id != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado ao movimento de caixa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_cm.type != 'expense' THEN
    RAISE EXCEPTION 'Movimento #% não é uma despesa (type=%).', p_cash_movement_id, v_cm.type USING ERRCODE = 'P0001';
  END IF;
  IF v_cm.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimento #% está cancelado e não pode ser regularizado.', p_cash_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- ─── Idempotência (camada RPC) — backstop final é a UNIQUE em finance_entries.cash_movement_id ───
  IF EXISTS (SELECT 1 FROM finance_entries WHERE cash_movement_id = p_cash_movement_id) THEN
    RAISE EXCEPTION 'Movimento #% já foi regularizado.', p_cash_movement_id USING ERRCODE = 'P0001';
  END IF;

  v_before := to_jsonb(v_cm);

  IF p_finance_entry_id IS NOT NULL THEN
    -- ═══════════════════════════ FLUXO B — vincular ═══════════════════════════
    v_flow      := 'B';
    v_operation := 'link';

    SELECT * INTO v_fe FROM finance_entries WHERE id = p_finance_entry_id FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lançamento financeiro #% não encontrado.', p_finance_entry_id USING ERRCODE = 'P0001';
    END IF;
    IF v_fe.company_id != v_company_id THEN
      RAISE EXCEPTION 'Acesso negado ao lançamento financeiro #%.', p_finance_entry_id USING ERRCODE = 'P0001';
    END IF;

    -- Proteção obrigatória: nunca sobrescrever um vínculo já existente.
    -- (a UNIQUE em finance_entries.cash_movement_id é a segunda proteção,
    -- redundante de propósito — esta checagem dá o erro claro antes de
    -- chegar a violar a constraint.)
    IF v_fe.cash_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'Lançamento #% já está vinculado a outro movimento de caixa (#%). Não é possível transferir o vínculo.',
        p_finance_entry_id, v_fe.cash_movement_id USING ERRCODE = 'P0001';
    END IF;

    UPDATE finance_entries
    SET payment_method   = v_cm.method,
        paid_at          = v_cm.created_at::date,
        cash_movement_id = v_cm.id
    WHERE id = p_finance_entry_id
    RETURNING id, to_jsonb(finance_entries.*) INTO v_finance_entry_id, v_after;

  ELSE
    -- ═══════════════════════════ FLUXO A — criar ══════════════════════════════
    v_flow      := 'A';
    v_operation := 'create';

    IF p_category IS NULL OR p_reference_date IS NULL THEN
      RAISE EXCEPTION 'Categoria e competência são obrigatórias para criar um novo lançamento.' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO finance_entries (
      type, category, description, amount, reference_date,
      payment_method, paid_at, cash_movement_id,
      company_id, created_by, notes
    ) VALUES (
      'expense', p_category, v_cm.description, v_cm.amount, p_reference_date,
      v_cm.method, v_cm.created_at::date, v_cm.id,
      v_company_id, v_user_id, p_notes
    )
    RETURNING id, to_jsonb(finance_entries.*) INTO v_finance_entry_id, v_after;
  END IF;

  -- ─── Auditoria (mesma transação — se falhar, tudo dá rollback) ─────────────
  INSERT INTO audit_logs (
    ts, user_id, user_role, action, resource, resource_id,
    before_data, after_data, detail,
    flow, operation, cash_movement_id, finance_entry_id
  ) VALUES (
    NOW(), v_user_id, v_user_role, v_operation, 'finance_entry_regularization',
    v_finance_entry_id::text,
    v_before, v_after,
    format('Regularização Caixa→Financeiro (fluxo %s): cash_movement #%s → finance_entry #%s',
           v_flow, p_cash_movement_id, v_finance_entry_id),
    v_flow, v_operation, p_cash_movement_id, v_finance_entry_id
  );

  RETURN jsonb_build_object(
    'flow',              v_flow,
    'operation',         v_operation,
    'cash_movement_id',  p_cash_movement_id,
    'finance_entry_id',  v_finance_entry_id
  );
END;
$$;

-- Executável só por quem tem sessão autenticada real (auth.uid() precisa
-- resolver) — service_role também recebe o grant, mas nunca vai satisfazer
-- a checagem de v_user_id IS NULL, então nunca executa sem identidade.
GRANT EXECUTE ON FUNCTION public.rpc_regularizar_despesa_caixa(bigint, int, finance_category, date, text)
  TO authenticated, service_role;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'audit_logs'
  AND column_name IN ('flow', 'operation', 'cash_movement_id', 'finance_entry_id')
ORDER BY column_name;
-- Esperado: 4 linhas

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'rpc_regularizar_despesa_caixa';
-- Esperado: 1 linha

-- =============================================================================
-- FIM DA MIGRATION 20260718
-- =============================================================================
