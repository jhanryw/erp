-- =============================================================================
-- 20260611_fix_caixa_close.sql
--
-- CORREÇÕES:
-- 1. Remove bloqueio de fechamento com diferença — caixa agora fecha sempre,
--    registrando a diferença como informação (não mais RAISE EXCEPTION).
-- 2. Remove o expected_cash da mensagem de warning (só informa que não bate).
-- 3. Formula de expected_cash usa COALESCE(amount_tendered, net_amount) para
--    não zerar quando amount_tendered não foi preenchido no pagamento.
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

  v_total_sales       numeric := 0;
  v_total_cash        numeric := 0;
  v_total_pix         numeric := 0;
  v_total_credit      numeric := 0;
  v_total_debit       numeric := 0;
  v_total_card_fees   numeric := 0;
  v_total_cash_change numeric := 0;
  v_total_pix_change  numeric := 0;

  v_cash_tendered     numeric := 0;
  v_expense_cash      numeric := 0;

  v_total_sangria     numeric := 0;
  v_total_suprimento  numeric := 0;
  v_total_expenses    numeric := 0;

  v_expected_cash     numeric;
  v_cash_difference   numeric;
BEGIN
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

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

  -- Total de vendas (uma linha por venda, sem double-count)
  SELECT COALESCE(SUM(total), 0)
  INTO   v_total_sales
  FROM   sales
  WHERE  cash_session_id = p_session_id
    AND  status NOT IN ('cancelled', 'returned');

  -- Totais por método de pagamento
  SELECT
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'pix'),         0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'cash'),        0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'credit_card'), 0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'debit_card'),  0),
    COALESCE(SUM(sp.fee_amount) FILTER (WHERE sp.method IN ('credit_card','debit_card')), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method = 'cash' AND sp.change_method = 'cash'), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method = 'cash' AND sp.change_method = 'pix'),  0),
    -- COALESCE: usa amount_tendered se preenchido, senão net_amount (evita zerado)
    COALESCE(
      SUM(COALESCE(sp.amount_tendered, sp.net_amount)) FILTER (WHERE sp.method = 'cash'),
    0)
  INTO
    v_total_pix,
    v_total_cash,
    v_total_credit,
    v_total_debit,
    v_total_card_fees,
    v_total_cash_change,
    v_total_pix_change,
    v_cash_tendered
  FROM sale_payments sp
  JOIN sales s ON s.id = sp.sale_id
  WHERE s.cash_session_id = p_session_id
    AND s.status NOT IN ('cancelled', 'returned');

  -- Movimentos do caixa (sangria, suprimento, despesa)
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'sangria'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'suprimento'),                  0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND method = 'cash'), 0)
  INTO
    v_total_sangria,
    v_total_suprimento,
    v_total_expenses,
    v_expense_cash
  FROM cash_movements
  WHERE cash_session_id = p_session_id
    AND cancelled_at IS NULL;

  v_expected_cash := ROUND(
    v_sess.opening_amount_cash
    + v_cash_tendered
    - v_total_cash_change
    + v_total_suprimento
    - v_total_sangria
    - v_expense_cash
  , 2);

  v_cash_difference := ROUND(p_counted_cash - v_expected_cash, 2);

  -- Fecha sempre — registra a diferença sem bloquear
  UPDATE cash_register_sessions
  SET
    status            = 'closed',
    closed_by         = p_user_id,
    closed_at         = NOW(),
    counted_cash      = p_counted_cash,
    notes_close       = NULLIF(TRIM(COALESCE(p_notes, '')), ''),
    updated_at        = NOW(),
    total_sales       = ROUND(v_total_sales,       2),
    total_cash        = ROUND(v_total_cash,        2),
    total_pix         = ROUND(v_total_pix,         2),
    total_credit_card = ROUND(v_total_credit,      2),
    total_debit_card  = ROUND(v_total_debit,       2),
    total_card_fees   = ROUND(v_total_card_fees,   2),
    total_cash_change = ROUND(v_total_cash_change, 2),
    total_pix_change  = ROUND(v_total_pix_change,  2),
    total_sangria     = ROUND(v_total_sangria,     2),
    total_suprimento  = ROUND(v_total_suprimento,  2),
    total_expenses    = ROUND(v_total_expenses,    2),
    expected_cash     = v_expected_cash,
    cash_difference   = v_cash_difference
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
    'total_sangria',    ROUND(v_total_sangria,     2),
    'total_suprimento', ROUND(v_total_suprimento,  2),
    'total_expenses',   ROUND(v_total_expenses,    2),
    'expected_cash',    v_expected_cash,
    'counted_cash',     p_counted_cash,
    'cash_difference',  v_cash_difference
  );
END;
$$;
