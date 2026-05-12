-- =============================================================================
-- 008_finance_stock_alignment.sql — Alinhamento estoque ↔ financeiro
-- Santtorini ERP
--
-- Problemas corrigidos:
--
--   Bug 1 — avg_cost não recalculado no cancelamento/devolução
--     rpc_cancel_sale e rpc_return_sale restauravam stock.quantity mas deixavam
--     avg_cost inalterado. Isso corrompeu a valorização de estoque e os lançamentos
--     futuros de rpc_stock_adjust (que usa avg_cost para calcular a despesa).
--     Fix: ON CONFLICT DO UPDATE agora recalcula avg_cost com média ponderada
--          usando unit_cost do item devolvido.
--
--   Bug 2 — income:cashback_used nunca criado; P&L mostra R$0 permanentemente
--     O resumo financeiro (GET /api/financeiro/resumo) foi desenhado para:
--       gross_revenue = income:sale + income:cashback_used + income:other_income
--     Onde income:sale = valor bruto da venda (antes do cashback) e
--           income:cashback_used = valor negativo (cashback descontado).
--     Porém rpc_create_sale armazenava income:sale = v_total (já líquido de
--     cashback) e nunca criava income:cashback_used. Resultado: o P&L não
--     mostrava quanto cashback foi resgatado, e a linha cashback_used estava
--     sempre zerada.
--     Fix: income:sale passa a ser o valor bruto (subtotal − desconto + frete),
--          e income:cashback_used = −effective_cashback (valor negativo) quando
--          cashback foi utilizado.
--     Impacto no cancelamento: NÃO há alteração. rpc_cancel_sale e
--          rpc_return_sale usam v_sale.total (valor líquido armazenado na venda)
--          como expense:other_expense. Como gross_revenue = bruto − cashback =
--          líquido = v_sale.total, o net_result permanece zero após cancelamento.
--
-- NOTA IMPORTANTE SOBRE DADOS HISTÓRICOS:
--   Vendas registradas antes desta migração têm income:sale = valor líquido (sem
--   cashback separado). Esses registros permanecerão consistentes em si mesmos
--   (net_result correto), mas o campo cashback_used no P&L histórico mostrará 0
--   para essas vendas — o que reflete o dado real gravado à época.
--
-- EXECUTAR APÓS 001–007.
-- Idempotente: usa CREATE OR REPLACE.
-- =============================================================================

-- =============================================================================
-- 1. rpc_cancel_sale — Bug 1: recalcular avg_cost na restauração do estoque
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cancel_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale     record;
  v_item     record;
  v_prev_qty int := 0;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, status, total, sale_number, company_id INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida e não pode ser cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status     = 'cancelled',
      updated_at = NOW()
  WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items
    WHERE sale_id = p_sale_id
    ORDER BY product_variation_id  -- lock ordering consistente com rpc_create_sale
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          -- Bug 1 Fix: recalcular avg_cost com média ponderada dos itens devolvidos.
          -- Antes: avg_cost ficava inalterado → valorização de estoque incorreta e
          -- rpc_stock_adjust calcularia despesa com custo errado.
          avg_cost     = ROUND(
                           (stock.quantity * stock.avg_cost
                            + v_item.quantity * v_item.unit_cost)
                           / (stock.quantity + v_item.quantity),
                           6),
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  -- expense = v_sale.total (líquido). Compensa exatamente o income:sale gravado na venda.
  -- Funcionamento: gross_revenue = income:sale(bruto) + income:cashback_used(−cashback)
  --   = v_total. Expense = v_total → net_result = 0. ✓
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 2. rpc_return_sale — Bug 1: mesma correção de avg_cost
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_return_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale     record;
  v_item     record;
  v_prev_qty int := 0;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, status, total, sale_number, company_id INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% está cancelada e não pode ser devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status     = 'returned',
      updated_at = NOW()
  WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items
    WHERE sale_id = p_sale_id
    ORDER BY product_variation_id  -- lock ordering consistente com rpc_create_sale
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          -- Bug 1 Fix: recalcular avg_cost com média ponderada.
          avg_cost     = ROUND(
                           (stock.quantity * stock.avg_cost
                            + v_item.quantity * v_item.unit_cost)
                           / (stock.quantity + v_item.quantity),
                           6),
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 3. rpc_create_sale — Bug 2: separar income:sale (bruto) de income:cashback_used
-- =============================================================================
--
-- Design adotado:
--   v_gross    = GREATEST(0, subtotal − desconto + frete)   ← valor bruto da venda
--   v_total    = GREATEST(0, v_gross − cashback_usado)      ← valor líquido cobrado
--   v_eff_cbu  = v_gross − v_total                          ← cashback efetivamente usado
--
--   income:sale           = v_gross  (valor bruto gravado em finance_entries)
--   income:cashback_used  = −v_eff_cbu (negativo → reduz gross_revenue para v_total)
--
-- O cancelamento NÃO precisa de alteração: usa v_sale.total (= v_total = líquido)
-- como expense:other_expense. Como gross_revenue = v_gross − v_eff_cbu = v_total:
--   net_result após cancelamento = v_total − v_total = 0 ✓
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id      int,
  p_seller_id        uuid,
  p_payment_method   text,
  p_sale_origin      text,
  p_discount_amount  numeric,
  p_cashback_used    numeric,
  p_shipping_charged numeric,
  p_notes            text,
  p_items            jsonb,
  p_system_user_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id         int;
  v_sale_number     text;
  v_subtotal        numeric := 0;
  v_gross           numeric;   -- valor bruto antes do cashback
  v_total           numeric;   -- valor líquido cobrado do cliente
  v_eff_cashback    numeric;   -- cashback efetivamente descontado (≥ 0)
  v_item            jsonb;
  v_pvid            int;
  v_qty             int;
  v_unit_price      numeric;
  v_unit_cost       numeric;
  v_discount        numeric;
  v_current_qty     int;
  v_item_total      numeric;
  v_company_id      int;
  v_item_company    int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do vendedor
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor não está associado a uma empresa.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validar empresa de cada item + calcular subtotal
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid := (v_item->>'product_variation_id')::int;

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS NULL THEN
      RAISE EXCEPTION 'Variação #% não encontrada.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;
    IF v_item_company != v_company_id THEN
      RAISE EXCEPTION 'Variação #% não pertence à empresa do vendedor.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  -- Bug 2 Fix: separar valor bruto de cashback
  v_gross        := GREATEST(0, ROUND(v_subtotal - p_discount_amount + p_shipping_charged, 2));
  v_total        := GREATEST(0, v_gross - p_cashback_used);
  v_eff_cashback := v_gross - v_total;  -- sempre ≥ 0, nunca excede v_gross

  -- PRE-LOCK: adquirir FOR UPDATE em todos os rows de stock em ordem crescente (007)
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items)
    ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, p_cashback_used, p_shipping_charged,
    -- sales.total = v_total (líquido): base do cancelamento
    ROUND(v_total, 2), p_payment_method, p_sale_origin, p_notes,
    CURRENT_DATE, v_company_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Processar itens (lock já mantido)
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid       := (v_item->>'product_variation_id')::int;
    v_qty        := (v_item->>'quantity')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_unit_cost  := (v_item->>'unit_cost')::numeric;
    v_discount   := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_total := ROUND(v_unit_price * v_qty - v_discount, 2);

    INSERT INTO sale_items (
      sale_id, product_variation_id, quantity,
      unit_price, unit_cost, discount_amount, total_price
    )
    VALUES (v_sale_id, v_pvid, v_qty, v_unit_price, v_unit_cost, v_discount, v_item_total);

    SELECT quantity INTO v_current_qty
    FROM stock WHERE product_variation_id = v_pvid;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Disponível: %, solicitado: %.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, p_system_user_id, v_company_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- Bug 2 Fix: registrar valor BRUTO em income:sale
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
  );

  -- Bug 2 Fix: registrar cashback como dedutor negativo de income:cashback_used
  -- gross_revenue no P&L = income:sale + income:cashback_used = v_gross − v_eff_cashback = v_total ✓
  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'cashback_used',
      'Cashback utilizado — Venda ' || v_sale_number,
      -v_eff_cashback, CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale  TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale  TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale  TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO 008
-- =============================================================================
