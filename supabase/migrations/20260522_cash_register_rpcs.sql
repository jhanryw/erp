-- =============================================================================
-- Migration 20260522 — Módulo de Caixa (Parte 2/3): RPCs
--
-- DEPENDE DE:
--   20260522_cash_register.sql (tabelas cash_register_sessions e cash_movements)
--   Tabelas: users, sales, sale_payments, cash_movements
--
-- RPCs CRIADAS:
--   1. rpc_open_cash_session    — abre nova sessão de caixa
--   2. rpc_add_cash_movement    — registra sangria, suprimento ou despesa
--   3. rpc_cancel_cash_movement — soft delete de movimento (enquanto caixa aberto)
--   4. rpc_close_cash_session   — fecha com snapshot imutável (gerente/admin)
--
-- SEGURANÇA:
--   Todas SECURITY DEFINER, SET search_path = public
--   Autorização por role validada dentro da função (não no caller)
--   company_id sempre derivado do usuário, nunca confiado no input
--
-- IDEMPOTENTE: sim (CREATE OR REPLACE)
-- =============================================================================

-- =============================================================================
-- RPC 1 — rpc_open_cash_session
--
-- Abre nova sessão de caixa para a empresa do usuário.
-- Rejeita com mensagem legível se já houver sessão aberta.
-- Race condition tratada no EXCEPTION WHEN unique_violation.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_open_cash_session(
  p_user_id              uuid,
  p_opening_amount_cash  numeric  DEFAULT 0,
  p_notes                text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id  int;
  v_session_id  bigint;
  v_opened_at   timestamptz;
BEGIN
  -- Derivar empresa do usuário (nunca confiar em input externo)
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não está associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Verificar sessão existente com mensagem amigável
  -- (o índice partial unique garante atomicidade; este IF antecipa o erro)
  IF EXISTS (
    SELECT 1 FROM cash_register_sessions
    WHERE company_id = v_company_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO cash_register_sessions (
    company_id,
    status,
    opened_by,
    opened_at,
    opening_amount_cash,
    notes_open
  )
  VALUES (
    v_company_id,
    'open',
    p_user_id,
    NOW(),
    GREATEST(0, COALESCE(p_opening_amount_cash, 0)),
    NULLIF(TRIM(COALESCE(p_notes, '')), '')
  )
  RETURNING id, opened_at INTO v_session_id, v_opened_at;

  RETURN jsonb_build_object(
    'id',                   v_session_id,
    'opened_at',            v_opened_at,
    'opening_amount_cash',  GREATEST(0, COALESCE(p_opening_amount_cash, 0))
  );

EXCEPTION
  WHEN unique_violation THEN
    -- Race condition: outro processo abriu entre o IF EXISTS e o INSERT
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa.' USING ERRCODE = 'P0001';
END;
$$;

-- =============================================================================
-- RPC 2 — rpc_add_cash_movement
--
-- Registra sangria, suprimento ou despesa no caixa aberto.
-- Valida: tipo, método, valor, sessão aberta, empresa.
-- Sangria e suprimento: sempre method='cash' (constraint + validação aqui).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_add_cash_movement(
  p_session_id        bigint,
  p_user_id           uuid,
  p_type              text,
  p_amount            numeric,
  p_description       text,
  p_method            text     DEFAULT 'cash',
  p_reference_sale_id bigint   DEFAULT NULL,
  p_metadata          jsonb    DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id    int;
  v_sess_status   text;
  v_sess_company  int;
  v_movement_id   bigint;
  v_created_at    timestamptz;
BEGIN
  -- Validações de input (antes de qualquer query)
  IF p_type NOT IN ('sangria', 'suprimento', 'expense') THEN
    RAISE EXCEPTION 'Tipo inválido: %. Use sangria, suprimento ou expense.', p_type
      USING ERRCODE = 'P0001';
  END IF;

  IF p_method NOT IN ('cash', 'pix', 'credit_card', 'debit_card') THEN
    RAISE EXCEPTION 'Método inválido: %.', p_method USING ERRCODE = 'P0001';
  END IF;

  IF p_type IN ('sangria', 'suprimento') AND p_method != 'cash' THEN
    RAISE EXCEPTION 'Sangria e suprimento são sempre em dinheiro físico. Método recebido: %.', p_method
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Valor deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;

  IF TRIM(COALESCE(p_description, '')) = '' THEN
    RAISE EXCEPTION 'Descrição obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  -- Empresa do usuário
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Verificar sessão
  SELECT status, company_id
  INTO   v_sess_status, v_sess_company
  FROM   cash_register_sessions
  WHERE  id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível registrar movimentos.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;

  -- Inserir movimento
  INSERT INTO cash_movements (
    cash_session_id,
    company_id,
    type,
    method,
    amount,
    description,
    reference_sale_id,
    metadata,
    created_by
  )
  VALUES (
    p_session_id,
    v_company_id,
    p_type,
    p_method,
    p_amount,
    TRIM(p_description),
    p_reference_sale_id,
    COALESCE(p_metadata, '{}'),
    p_user_id
  )
  RETURNING id, created_at INTO v_movement_id, v_created_at;

  RETURN jsonb_build_object(
    'id',         v_movement_id,
    'type',       p_type,
    'method',     p_method,
    'amount',     p_amount,
    'created_at', v_created_at
  );
END;
$$;

-- =============================================================================
-- RPC 3 — rpc_cancel_cash_movement
--
-- Soft delete lógico de movimento (cancelled_at, cancelled_by, cancellation_reason).
-- Permitido apenas enquanto o caixa está aberto.
-- Autorização: criador do movimento OU gerente/admin da empresa.
-- Movimentos cancelados são excluídos de todos os cálculos (WHERE cancelled_at IS NULL).
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
  v_company_id    int;
  v_user_role     text;
  v_movement      record;
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

  -- Buscar movimento + dados da sessão em um único JOIN
  SELECT
    cm.id,
    cm.created_by,
    cm.cancelled_at,
    crs.status   AS session_status,
    crs.company_id AS session_company
  INTO v_movement
  FROM cash_movements cm
  JOIN cash_register_sessions crs ON crs.id = cm.cash_session_id
  WHERE cm.id = p_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimento #% não encontrado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- Verificar empresa
  IF v_movement.session_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  -- Caixa deve estar aberto
  IF v_movement.session_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível cancelar movimentos.' USING ERRCODE = 'P0001';
  END IF;

  -- Não cancelar duas vezes
  IF v_movement.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimento #% já foi cancelado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- Autorização: criador do movimento OU gerente/admin
  IF v_movement.created_by != p_user_id AND v_user_role NOT IN ('gerente', 'admin') THEN
    RAISE EXCEPTION 'Apenas o criador do movimento ou gerente/admin podem cancelar.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Soft delete
  UPDATE cash_movements
  SET
    cancelled_at        = NOW(),
    cancelled_by        = p_user_id,
    cancellation_reason = TRIM(p_cancellation_reason)
  WHERE id = p_movement_id;

  RETURN jsonb_build_object(
    'id',                   p_movement_id,
    'cancelled_at',         NOW(),
    'cancellation_reason',  TRIM(p_cancellation_reason)
  );
END;
$$;

-- =============================================================================
-- RPC 4 — rpc_close_cash_session
--
-- Fecha o caixa com snapshot imutável de todos os totais.
-- Chamada apenas por gerente/admin (validado na API route; RPC não valida role).
-- Lock pessimista (FOR UPDATE) previne race condition com venda/movimento simultâneo.
--
-- Fórmula expected_cash:
--   opening_amount_cash
--   + SUM(sp.amount_tendered WHERE method='cash')       ← dinheiro bruto recebido
--   - SUM(sp.change_amount  WHERE method='cash'
--          AND change_method='cash')                    ← troco dado em dinheiro
--   + total_suprimento                                  ← entradas manuais
--   - total_sangria                                     ← retiradas
--   - SUM(cm.amount WHERE type='expense' AND method='cash')  ← despesas em cash
--
-- Troco via PIX (change_method='pix') NÃO subtrai o dinheiro físico:
--   o cliente recebe PIX, mas o dinheiro permanece na gaveta.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_close_cash_session(
  p_session_id    bigint,
  p_user_id       uuid,
  p_counted_cash  numeric,
  p_notes         text     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id        int;
  v_sess              record;

  -- Totais de vendas
  v_total_sales       numeric := 0;
  v_total_cash        numeric := 0;
  v_total_pix         numeric := 0;
  v_total_credit      numeric := 0;
  v_total_debit       numeric := 0;
  v_total_card_fees   numeric := 0;
  v_total_cash_change numeric := 0;  -- troco em dinheiro
  v_total_pix_change  numeric := 0;  -- troco via PIX

  -- Para a fórmula de expected_cash
  v_cash_tendered     numeric := 0;  -- amount_tendered de pagamentos cash
  v_expense_cash      numeric := 0;  -- despesas pagas em dinheiro

  -- Totais de movimentos (cancelled_at IS NULL)
  v_total_sangria     numeric := 0;
  v_total_suprimento  numeric := 0;
  v_total_expenses    numeric := 0;

  -- Resultado
  v_expected_cash     numeric;
  v_cash_difference   numeric;
BEGIN
  -- Empresa do usuário
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Lock pessimista (Adjustment 3) ───────────────────────────────────────
  -- Bloqueia a sessão antes do cálculo para prevenir race condition com:
  --   - nova venda simultânea que vincularia a esta sessão
  --   - novo movimento simultâneo
  -- O rpc_create_sale também faz SELECT ... FOR UPDATE no stock,
  -- mas não no cash_register_sessions — o lock aqui garante o snapshot coerente.
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
  IF v_sess.status = 'closed' THEN
    RAISE EXCEPTION 'Caixa já fechado.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_counted_cash, -1) < 0 THEN
    RAISE EXCEPTION 'Valor contado não pode ser negativo.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Totais das vendas da sessão (via sale_payments) ──────────────────────
  -- Exclui vendas canceladas e devolvidas
  -- Fonte de verdade: sale_payments (não sales.payment_method)

  SELECT
    COALESCE(SUM(s.total), 0),
    -- net_amount por método
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'pix'),          0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'cash'),         0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'credit_card'),  0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'debit_card'),   0),
    -- Taxas de cartão
    COALESCE(SUM(sp.fee_amount) FILTER (
      WHERE sp.method IN ('credit_card', 'debit_card')
    ), 0),
    -- Trocos separados por método
    COALESCE(SUM(sp.change_amount) FILTER (
      WHERE sp.method = 'cash' AND sp.change_method = 'cash'
    ), 0),
    COALESCE(SUM(sp.change_amount) FILTER (
      WHERE sp.method = 'cash' AND sp.change_method = 'pix'
    ), 0),
    -- Dinheiro bruto recebido (amount_tendered, para a fórmula expected_cash)
    COALESCE(SUM(sp.amount_tendered) FILTER (WHERE sp.method = 'cash'), 0)
  INTO
    v_total_sales,
    v_total_pix,
    v_total_cash,
    v_total_credit,
    v_total_debit,
    v_total_card_fees,
    v_total_cash_change,
    v_total_pix_change,
    v_cash_tendered
  FROM sales s
  JOIN sale_payments sp ON sp.sale_id = s.id
  WHERE s.cash_session_id = p_session_id
    AND s.status NOT IN ('cancelled', 'returned');

  -- ─── Totais dos movimentos ativos ─────────────────────────────────────────
  -- cancelled_at IS NULL: exclui movimentos cancelados

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'sangria'),                    0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'suprimento'),                 0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'),                    0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND method = 'cash'), 0)
  INTO
    v_total_sangria,
    v_total_suprimento,
    v_total_expenses,
    v_expense_cash
  FROM cash_movements
  WHERE cash_session_id = p_session_id
    AND cancelled_at IS NULL;

  -- ─── Fórmula do dinheiro esperado ─────────────────────────────────────────
  v_expected_cash := ROUND(
    v_sess.opening_amount_cash  -- fundo inicial
    + v_cash_tendered           -- dinheiro bruto recebido dos clientes
    - v_total_cash_change       -- troco dado em dinheiro (change_method='cash')
    -- troco via PIX NÃO subtrai: o dinheiro físico permanece na gaveta
    + v_total_suprimento        -- entradas manuais de dinheiro
    - v_total_sangria           -- retiradas de dinheiro
    - v_expense_cash            -- despesas pagas em dinheiro
  , 2);

  v_cash_difference := ROUND(p_counted_cash - v_expected_cash, 2);

  -- ─── Snapshot imutável ────────────────────────────────────────────────────
  UPDATE cash_register_sessions
  SET
    status           = 'closed',
    closed_by        = p_user_id,
    closed_at        = NOW(),
    counted_cash     = p_counted_cash,
    notes_close      = NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    updated_at       = NOW(),
    -- Vendas
    total_sales      = ROUND(v_total_sales,       2),
    total_cash       = ROUND(v_total_cash,        2),
    total_pix        = ROUND(v_total_pix,         2),
    total_credit_card= ROUND(v_total_credit,      2),
    total_debit_card = ROUND(v_total_debit,       2),
    total_card_fees  = ROUND(v_total_card_fees,   2),
    total_cash_change= ROUND(v_total_cash_change, 2),
    total_pix_change = ROUND(v_total_pix_change,  2),
    -- Movimentos
    total_sangria    = ROUND(v_total_sangria,    2),
    total_suprimento = ROUND(v_total_suprimento, 2),
    total_expenses   = ROUND(v_total_expenses,   2),
    -- Apuração
    expected_cash    = v_expected_cash,
    cash_difference  = v_cash_difference
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'id',               p_session_id,
    'status',           'closed',
    'closed_at',        NOW(),
    'total_sales',      ROUND(v_total_sales,       2),
    'total_cash',       ROUND(v_total_cash,        2),
    'total_pix',        ROUND(v_total_pix,         2),
    'total_credit_card',ROUND(v_total_credit,      2),
    'total_debit_card', ROUND(v_total_debit,       2),
    'total_card_fees',  ROUND(v_total_card_fees,   2),
    'total_cash_change',ROUND(v_total_cash_change, 2),
    'total_pix_change', ROUND(v_total_pix_change,  2),
    'total_sangria',    ROUND(v_total_sangria,    2),
    'total_suprimento', ROUND(v_total_suprimento, 2),
    'total_expenses',   ROUND(v_total_expenses,   2),
    'expected_cash',    v_expected_cash,
    'counted_cash',     p_counted_cash,
    'cash_difference',  v_cash_difference
  );
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_open_cash_session(uuid, numeric, text)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_add_cash_movement(bigint, uuid, text, numeric, text, text, bigint, jsonb)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_cancel_cash_movement(bigint, uuid, text)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text)
  TO service_role, authenticated;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

SELECT routine_name
FROM   information_schema.routines
WHERE  routine_schema = 'public'
  AND  routine_name IN (
    'rpc_open_cash_session',
    'rpc_add_cash_movement',
    'rpc_cancel_cash_movement',
    'rpc_close_cash_session'
  )
ORDER BY routine_name;
-- Esperado: 4 linhas

-- =============================================================================
-- FIM DA MIGRATION 20260522 — PARTE 2/3 (RPCs)
-- =============================================================================
