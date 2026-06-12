-- =============================================================================
-- 20260612_fix_cashback_earn.sql
--
-- PROBLEMA:
--   Cashback earn era gerado externamente (n8n) sobre valor errado quando havia
--   desconto — usava subtotal ou gross em vez do total que o cliente realmente pagou.
--
-- CORREÇÃO:
--   Move a geração do cashback earn para dentro de rpc_create_sale.
--   Base de cálculo: v_total (o que o cliente efetivamente pagou, pós-desconto e
--   pós-cashback_used). Assim o earn nunca usa o preço cheio.
--
--   Regras:
--     - Só gera earn se p_cashback_used = 0 (modo acumular, não usar)
--     - Só gera se o cliente não for anônimo
--     - Só gera se existir cashback_config ativa para a empresa
--     - Só gera se v_total >= min_order_value da config
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    payment_method,
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric  DEFAULT 0,
  p_surcharge_amount  numeric  DEFAULT 0,
  p_payments          jsonb    DEFAULT NULL,
  p_cash_session_id   bigint   DEFAULT NULL
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
  v_gross           numeric;
  v_total           numeric;
  v_eff_cashback    numeric;
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
  v_card_fee        numeric;
  v_surcharge       numeric;
  v_brazil_date     date;
  v_main_store_id   int;
  v_debit_location  int;

  v_pmt             jsonb;
  v_pmt_method      payment_method;
  v_pmt_tendered    numeric;
  v_pmt_change      numeric;
  v_pmt_change_mth  text;
  v_pmt_net         numeric;
  v_pmt_install     int;
  v_pmt_brand       text;
  v_pmt_acquirer    text;
  v_pmt_fee         numeric;
  v_dominant_method payment_method;
  v_max_net         numeric := -1;

  -- cashback earn
  v_is_anon         boolean;
  v_rate_pct        numeric;
  v_release_days    int;
  v_expiry_days     int;
  v_min_order       numeric;
  v_earn_amount     numeric;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- ─── Empresa e data ──────────────────────────────────────────────────────────
  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_main_store_id := public.fn_main_store_id(v_company_id);

  -- ─── Validação de itens ──────────────────────────────────────────────────────
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nenhum item na venda.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Cálculo de totais ───────────────────────────────────────────────────────
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid       := (v_item->>'product_variation_id')::int;
    v_qty        := (v_item->>'quantity')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_discount   := COALESCE((v_item->>'discount_amount')::numeric, 0);

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS DISTINCT FROM v_company_id THEN
      RAISE EXCEPTION 'Produto não pertence à empresa.' USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount, 2);
  END LOOP;

  v_card_fee  := COALESCE(p_card_fee, 0);
  v_surcharge := COALESCE(p_surcharge_amount, 0);
  v_eff_cashback := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_gross  := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total  := ROUND(v_gross - v_eff_cashback, 2);

  -- ─── Método dominante ────────────────────────────────────────────────────────
  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  -- ─── Lock pessimista ─────────────────────────────────────────────────────────
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1
    FROM stock_balances
    WHERE product_variation_id = v_pvid
    FOR UPDATE;
  END LOOP;

  -- ─── INSERT sales ────────────────────────────────────────────────────────────
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Itens: debita do primeiro local com saldo suficiente ───────────────────
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

    -- Preferência: Estoque Loja. Fallback: qualquer local com saldo.
    SELECT id INTO v_debit_location
    FROM stock_locations
    WHERE company_id = v_company_id AND active = true
      AND id IN (
        SELECT stock_location_id FROM stock_balances
        WHERE product_variation_id = v_pvid AND quantity >= v_qty
      )
    ORDER BY (id = v_main_store_id) DESC, priority ASC
    LIMIT 1;

    IF v_debit_location IS NULL THEN
      SELECT COALESCE(SUM(quantity), 0) INTO v_current_qty
      FROM stock_balances WHERE product_variation_id = v_pvid;

      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Total disponível: %, solicitado: %.',
        v_pvid, v_current_qty, v_qty USING ERRCODE = 'P0001';
    END IF;

    SELECT quantity INTO v_current_qty
    FROM stock_balances
    WHERE product_variation_id = v_pvid AND stock_location_id = v_debit_location;

    UPDATE stock_balances
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_debit_location;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id,
      source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_pvid, pv.product_id,
      'sale', -v_qty,
      v_current_qty, v_current_qty - v_qty,
      v_unit_cost, v_sale_id::text, v_company_id,
      v_debit_location, 'sale', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- ─── Finance entries ─────────────────────────────────────────────────────────
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
  );

  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'cashback_used', 'Cashback — Venda ' || v_sale_number,
      v_eff_cashback, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- ─── Pagamentos ──────────────────────────────────────────────────────────────
  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method     := (v_pmt->>'method')::payment_method;
      v_pmt_tendered   := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change     := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net        := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install    := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand      := v_pmt->>'card_brand';
      v_pmt_acquirer   := v_pmt->>'acquirer';
      v_pmt_fee        := COALESCE((v_pmt->>'fee_amount')::numeric, ROUND(v_pmt_net * v_card_fee / 100, 2));

      INSERT INTO sale_payments (
        sale_id, company_id, method,
        amount_tendered, change_amount, change_method,
        net_amount, installments, card_brand, acquirer, fee_amount
      )
      VALUES (
        v_sale_id, v_company_id, v_pmt_method,
        v_pmt_tendered, v_pmt_change,
        v_pmt_change_mth::payment_method,
        v_pmt_net, v_pmt_install, v_pmt_brand, v_pmt_acquirer, v_pmt_fee
      );
    END LOOP;
  END IF;

  -- ─── Cashback earn ───────────────────────────────────────────────────────────
  -- Só gera earn se:
  --   1. Cliente não usou cashback nesta venda (modo acumular)
  --   2. Cliente não é anônimo
  --   3. Existe config ativa para a empresa
  --   4. v_total >= min_order_value
  IF COALESCE(p_cashback_used, 0) = 0 AND p_customer_id IS NOT NULL THEN
    SELECT is_anonymous INTO v_is_anon
    FROM customers WHERE id = p_customer_id;

    IF NOT COALESCE(v_is_anon, false) THEN
      SELECT rate_pct, release_days, expiry_days, min_order_value
      INTO v_rate_pct, v_release_days, v_expiry_days, v_min_order
      FROM cashback_config
      WHERE company_id = v_company_id AND active = true
      LIMIT 1;

      IF FOUND AND v_total >= COALESCE(v_min_order, 0) THEN
        v_earn_amount := ROUND(v_total * v_rate_pct / 100.0, 2);

        IF v_earn_amount > 0 THEN
          INSERT INTO cashback_transactions (
            customer_id, company_id, sale_id,
            type, amount, status,
            release_date, expiry_date
          )
          VALUES (
            p_customer_id, v_company_id, v_sale_id,
            'earn', v_earn_amount, 'pending',
            v_brazil_date + v_release_days,
            v_brazil_date + v_release_days + v_expiry_days
          );
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;
