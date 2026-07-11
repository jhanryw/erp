-- =============================================================================
-- 20260719_fix_rpc_regularizar_payment_method_cast.sql
--
-- Corrige rpc_regularizar_despesa_caixa (20260718): cash_movements.method é
-- TEXT, finance_entries.payment_method é o enum public.payment_method.
-- Postgres não faz cast implícito de TEXT para enum em INSERT/UPDATE — a RPC
-- falhava em tempo de execução (não na criação da função, por isso passou
-- pela migration anterior sem erro) com:
--   "column "payment_method" is of type payment_method but expression is of
--    type text"
--
-- Fix: cast explícito v_cm.method::payment_method nos dois pontos de escrita
-- (UPDATE do Fluxo B, INSERT do Fluxo A). Seguro porque cash_movements.method
-- já tem CHECK (method IN ('cash','pix','credit_card','debit_card')) — todos
-- os 4 valores possíveis são labels válidos do enum payment_method.
--
-- Único ajuste desta migration: os dois casts. Nenhuma outra alteração de
-- schema, constraint, índice ou coluna. audit_logs não é tocada de novo
-- (já aplicada pela migration anterior).
--
-- IDEMPOTENTE: sim — CREATE OR REPLACE FUNCTION.
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

    -- FIX: cast explícito TEXT -> payment_method (v_cm.method é TEXT)
    UPDATE finance_entries
    SET payment_method   = v_cm.method::payment_method,
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

    -- FIX: cast explícito TEXT -> payment_method (v_cm.method é TEXT)
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date,
      payment_method, paid_at, cash_movement_id,
      company_id, created_by, notes
    ) VALUES (
      'expense', p_category, v_cm.description, v_cm.amount, p_reference_date,
      v_cm.method::payment_method, v_cm.created_at::date, v_cm.id,
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

GRANT EXECUTE ON FUNCTION public.rpc_regularizar_despesa_caixa(bigint, int, finance_category, date, text)
  TO authenticated, service_role;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

-- Confirma que o cast está presente no código-fonte da função
SELECT
  CASE
    WHEN prosrc LIKE '%v_cm.method::payment_method%' THEN 'OK: cast explícito presente'
    ELSE 'FALHA: cast não encontrado — migration não aplicada corretamente'
  END AS smoke_test
FROM pg_proc
WHERE proname = 'rpc_regularizar_despesa_caixa';

-- =============================================================================
-- FIM DA MIGRATION 20260719
-- =============================================================================
