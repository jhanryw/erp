-- =============================================================================
-- 20260627_rpc_create_sale_v4.sql
--
-- Adiciona p_responsible_seller_id (16º parâmetro) à rpc_create_sale.
--
-- BASE: 20260626_fix_cashback_balance.sql (versão com 15 params + cashback fix).
-- ÚNICA MUDANÇA: novo parâmetro + validação + INSERT em sales.
--
-- Estratégia: DROP da assinatura 15-params + CREATE da assinatura 16-params.
--   CREATE OR REPLACE com lista de parâmetros diferente criaria um overload
--   em vez de substituir — por isso usamos DROP antes.
-- =============================================================================

-- Remove a assinatura de 15 parâmetros
DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text
);

-- Cria a nova assinatura de 16 parâmetros
CREATE FUNCTION public.rpc_create_sale(
  p_customer_id           int,
  p_seller_id             uuid,
  p_payment_method        payment_method,
  p_sale_origin           text,
  p_discount_amount       numeric,
  p_cashback_used         numeric,
  p_shipping_charged      numeric,
  p_notes                 text,
  p_items                 jsonb,
  p_system_user_id        uuid,
  p_card_fee              numeric  DEFAULT 0,
  p_surcharge_amount      numeric  DEFAULT 0,
  p_payments              jsonb    DEFAULT NULL,
  p_cash_session_id       bigint   DEFAULT NULL,
  p_stock_mode            text     DEFAULT 'main_store',
  p_responsible_seller_id int      DEFAULT NULL
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
  v_avail_credit    numeric;
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

  v_online_loc      record;
  v_loc_qty         int;
  v_debit           int;
  v_remaining       int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_stock_mode NOT IN ('main_store', 'online_priority') THEN
    RAISE EXCEPTION 'p_stock_mode inválido: %. Aceitos: main_store, online_priority.', p_stock_mode
      USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Verificar que o seller pertence à empresa (apenas quando informado)
  IF p_responsible_seller_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sellers
    WHERE id = p_responsible_seller_id
      AND company_id = v_company_id
      AND active = TRUE
  ) THEN
    RAISE EXCEPTION 'Vendedor responsável inválido ou inativo.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  IF p_stock_mode = 'main_store' THEN
    v_main_store_id := public.fn_main_store_id(v_company_id);
    IF v_main_store_id IS NULL THEN
      RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
        v_company_id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nenhum item na venda.' USING ERRCODE = 'P0001';
  END IF;

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

  v_card_fee     := COALESCE(p_card_fee, 0);
  v_surcharge    := COALESCE(p_surcharge_amount, 0);
  v_eff_cashback := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_gross        := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total        := ROUND(v_gross - v_eff_cashback, 2);

  -- ─── Validar saldo de crédito ─────────────────────────────────────────────
  IF v_eff_cashback > 0 THEN
    IF p_customer_id IS NULL THEN
      RAISE EXCEPTION 'Não é possível usar crédito em venda sem cliente identificado.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT GREATEST(0,
      COALESCE(SUM(CASE WHEN type = 'earn' AND status = 'available' THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'use'                            THEN amount ELSE 0 END), 0)
    ) INTO v_avail_credit
    FROM cashback_transactions
    WHERE customer_id = p_customer_id;

    IF v_avail_credit < v_eff_cashback THEN
      RAISE EXCEPTION
        'Saldo de crédito insuficiente. Disponível: R$ %, solicitado: R$ %.',
        v_avail_credit, v_eff_cashback
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  IF p_stock_mode = 'main_store' THEN
    FOR v_pvid IN
      SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
      FROM jsonb_array_elements(p_items) ORDER BY pvid
    LOOP
      PERFORM 1
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id
      FOR UPDATE;
    END LOOP;
  ELSE
    PERFORM 1
    FROM stock_balances sb
    JOIN stock_locations sl ON sl.id = sb.stock_location_id
    WHERE sb.product_variation_id IN (
      SELECT DISTINCT (value->>'product_variation_id')::int
      FROM jsonb_array_elements(p_items)
    )
      AND sl.company_id = v_company_id
      AND sl.active     = true
    ORDER BY sb.product_variation_id ASC, sb.stock_location_id ASC
    FOR UPDATE OF sb;
  END IF;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id,
    responsible_seller_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id,
    p_responsible_seller_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Registrar consumo de crédito ────────────────────────────────────────
  IF v_eff_cashback > 0 AND p_customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      used_at, used_in_sale_id
    )
    VALUES (
      p_customer_id, v_company_id, v_sale_id,
      'use', v_eff_cashback, 'used',
      NOW(), v_sale_id
    );
  END IF;

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

    IF p_stock_mode = 'main_store' THEN

      SELECT COALESCE(quantity, 0) INTO v_current_qty
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

      IF COALESCE(v_current_qty, 0) < v_qty THEN
        RAISE EXCEPTION
          'Produto sem saldo no Estoque Loja (variação #%). '
          'Disponível: %, solicitado: %. Transfira antes de vender.',
          v_pvid, COALESCE(v_current_qty, 0), v_qty
          USING ERRCODE = 'P0001';
      END IF;

      UPDATE stock_balances
      SET quantity     = quantity - v_qty,
          last_updated = NOW()
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

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
        v_main_store_id, 'sale', 'sale', p_system_user_id
      FROM product_variations pv WHERE pv.id = v_pvid;

    ELSE

      SELECT COALESCE(SUM(sb.quantity), 0) INTO v_current_qty
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      WHERE sb.product_variation_id = v_pvid
        AND sl.company_id = v_company_id
        AND sl.active     = true;

      IF v_current_qty < v_qty THEN
        RAISE EXCEPTION
          'Estoque total insuficiente para venda online (variação #%). '
          'Disponível: %, solicitado: %.',
          v_pvid, v_current_qty, v_qty
          USING ERRCODE = 'P0001';
      END IF;

      v_remaining := v_qty;

      FOR v_online_loc IN
        SELECT sl.id AS location_id, sl.priority
        FROM stock_locations sl
        JOIN stock_balances sb ON sb.stock_location_id = sl.id
                              AND sb.product_variation_id = v_pvid
        WHERE sl.company_id = v_company_id
          AND sl.active     = true
          AND sb.quantity   > 0
        ORDER BY sl.priority ASC, sl.id ASC
      LOOP
        EXIT WHEN v_remaining = 0;

        SELECT COALESCE(quantity, 0) INTO v_loc_qty
        FROM stock_balances
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        v_debit     := LEAST(v_remaining, v_loc_qty);
        v_remaining := v_remaining - v_debit;

        UPDATE stock_balances
        SET quantity     = quantity - v_debit,
            last_updated = NOW()
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        INSERT INTO stock_movements (
          product_variation_id, product_id, type, quantity,
          previous_stock, new_stock, unit_cost, reference_id, company_id,
          source_location_id, movement_type, reference_type, created_by
        )
        SELECT
          v_pvid, pv.product_id,
          'sale', -v_debit,
          v_loc_qty, v_loc_qty - v_debit,
          v_unit_cost, v_sale_id::text, v_company_id,
          v_online_loc.location_id, 'sale', 'online_order', p_system_user_id
        FROM product_variations pv WHERE pv.id = v_pvid;

      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION
          'Erro interno: não foi possível debitar % unidades restantes da variação #%.',
          v_remaining, v_pvid
          USING ERRCODE = 'P0001';
      END IF;

    END IF;

  END LOOP;

  -- ─── Finance entries ──────────────────────────────────────────────────────
  IF v_total > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'sale', 'Venda ' || v_sale_number,
      v_total, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- ─── Pagamentos ──────────────────────────────────────────────────────────
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

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int
) TO service_role, authenticated;
