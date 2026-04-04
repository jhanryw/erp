-- Migration 019: Corrige rpc_create_sale
--
-- Problema:
--   sales.payment_method é USER-DEFINED enum (payment_method).
--   p_payment_method é text. PostgreSQL não faz cast implícito text → enum.
--   Erro: "column payment_method is of type payment_method but expression is of type text"
--
-- Fix: p_payment_method::payment_method no INSERT.
--
-- Bônus: adiciona p_card_fee (taxa de cartão repassada pelo cliente).
--   Quando informada, registra um finance_entry de expense/card_fee separado,
--   permitindo rastrear exatamente quanto a operadora reteve.
--
-- NOTA: DROP das versões antigas com assinaturas diferentes para evitar
--   "function name is not unique" ao usar CREATE OR REPLACE com nova assinatura.

DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric);

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
  p_system_user_id   uuid,
  p_card_fee         numeric DEFAULT 0   -- taxa de cartão paga pelo cliente (0 = não se aplica)
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_card_fee := COALESCE(p_card_fee, 0);

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

  v_gross        := GREATEST(0, ROUND(v_subtotal - p_discount_amount + p_shipping_charged, 2));
  v_total        := GREATEST(0, v_gross - p_cashback_used);
  v_eff_cashback := v_gross - v_total;

  -- PRE-LOCK: adquirir FOR UPDATE em todos os rows de stock em ordem crescente
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
    ROUND(v_total, 2),
    p_payment_method::payment_method,   -- ← cast explícito: fix do erro
    p_sale_origin, p_notes,
    CURRENT_DATE, v_company_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Processar itens
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
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, v_company_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- Receita bruta (inclui taxa de cartão paga pelo cliente = faturamento total)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
  );

  -- Cashback como dedutor de receita
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

  -- Taxa de cartão como despesa separada (operadora retém do valor recebido)
  IF v_card_fee > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'expense', 'card_fee',
      'Taxa de cartão — Venda ' || v_sale_number,
      v_card_fee, CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale TO service_role, authenticated;
