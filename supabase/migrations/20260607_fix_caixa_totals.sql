-- =============================================================================
-- 20260607_fix_caixa_totals.sql
--
-- PROBLEMAS CORRIGIDOS:
--
-- 1. DOUBLE-COUNT em total_sales
--    A query anterior fazia FROM sales JOIN sale_payments numa única instrução
--    SELECT. Para uma venda com 2 pagamentos, SUM(s.total) é somado 2 vezes.
--    Resultado: total_sales inflado exatamente pela soma de vendas multi-método.
--    Fix: separar em duas queries — total_sales direto de `sales`, totais por
--    método direto de `sale_payments JOIN sales`.
--
-- 2. Fechamento sem conferência
--    O RPC fechava mesmo com diferença entre contado e esperado.
--    Fix: se ABS(cash_difference) > 0.01, RAISE EXCEPTION com mensagem clara.
--    O operador vê o valor esperado e pode corrigir o que digitou.
--
-- IDEMPOTENTE: CREATE OR REPLACE.
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
  v_total_cash        numeric := 0;   -- net_amount method='cash'
  v_total_pix         numeric := 0;
  v_total_credit      numeric := 0;
  v_total_debit       numeric := 0;
  v_total_card_fees   numeric := 0;
  v_total_cash_change numeric := 0;   -- troco em dinheiro
  v_total_pix_change  numeric := 0;   -- troco via PIX

  -- Para fórmula expected_cash (valores físicos, sem taxa de maquininha)
  v_cash_tendered     numeric := 0;   -- amount_tendered cash (bruto recebido)
  v_expense_cash      numeric := 0;   -- despesas pagas em dinheiro

  -- Movimentos
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

  -- ─── Lock pessimista ───────────────────────────────────────────────────────
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

  -- ─── 1. Total de vendas (query separada — evita double-count do JOIN) ───────
  -- Conta cada venda uma única vez, independente de quantos pagamentos tem.
  SELECT COALESCE(SUM(total), 0)
  INTO   v_total_sales
  FROM   sales
  WHERE  cash_session_id = p_session_id
    AND  status NOT IN ('cancelled', 'returned');

  -- ─── 2. Totais por método (sale_payments JOIN sales) ─────────────────────
  -- Cada linha de sale_payments é um pagamento → sem double-count aqui.
  SELECT
    -- net_amount = valor bruto cobrado por método (sem taxa de maquininha deduzida)
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'pix'),          0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'cash'),         0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'credit_card'),  0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'debit_card'),   0),
    -- Taxas de cartão (separadas; não afetam o dinheiro físico no caixa)
    COALESCE(SUM(sp.fee_amount) FILTER (
      WHERE sp.method IN ('credit_card', 'debit_card')
    ), 0),
    -- Troco: cash → sai do caixa; pix → dinheiro fica no caixa
    COALESCE(SUM(sp.change_amount) FILTER (
      WHERE sp.method = 'cash' AND sp.change_method = 'cash'
    ), 0),
    COALESCE(SUM(sp.change_amount) FILTER (
      WHERE sp.method = 'cash' AND sp.change_method = 'pix'
    ), 0),
    -- Dinheiro bruto recebido dos clientes (amount_tendered, para expected_cash)
    COALESCE(SUM(sp.amount_tendered) FILTER (WHERE sp.method = 'cash'), 0)
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

  -- ─── 3. Totais dos movimentos ativos ──────────────────────────────────────
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

  -- ─── 4. Dinheiro esperado no caixa ────────────────────────────────────────
  --
  -- Usa valores BRUTOS (sem deduzir taxa de maquininha — card fees não afetam
  -- o dinheiro físico em gaveta):
  --
  --   opening_amount_cash           fundo inicial
  -- + v_cash_tendered               dinheiro bruto recebido dos clientes
  -- - v_total_cash_change           troco devolvido em papel (change_method='cash')
  --   (troco via PIX não sai do caixa físico — dinheiro permanece na gaveta)
  -- + v_total_suprimento            reforços manuais em dinheiro
  -- - v_total_sangria               retiradas em dinheiro
  -- - v_expense_cash                despesas pagas em dinheiro
  --
  v_expected_cash := ROUND(
    v_sess.opening_amount_cash
    + v_cash_tendered
    - v_total_cash_change
    + v_total_suprimento
    - v_total_sangria
    - v_expense_cash
  , 2);

  v_cash_difference := ROUND(p_counted_cash - v_expected_cash, 2);

  -- ─── 5. Bloquear fechamento com diferença ─────────────────────────────────
  --
  -- O caixa só fecha quando o valor contado fisicamente bate com o calculado.
  -- Mensagem inclui o valor esperado para que o operador possa conferir.
  --
  IF ABS(v_cash_difference) > 0.01 THEN
    RAISE EXCEPTION
      'Diferença de caixa detectada: você contou % mas o esperado é %. '
      'Corrija o valor ou verifique os movimentos do caixa.',
      ROUND(p_counted_cash, 2), v_expected_cash
      USING ERRCODE = 'P0001';
  END IF;

  -- ─── 6. Snapshot imutável ─────────────────────────────────────────────────
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
