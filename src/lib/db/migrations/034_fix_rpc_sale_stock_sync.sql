-- =============================================================================
-- Migration 034: Corrigir timezone nas RPCs de venda + remover overloads órfãos
--
-- Problema identificado em auditoria (2026-04-19):
--   Existem 3 versões sobrecarregadas de rpc_create_sale no banco:
--     1. (10 params) — criada pela migration 033 com timezone fix, mas SEM
--        set_config e SEM stock_movements (bug grave)
--     2. (12 params, ordem alfabética) — wrapper que delega para versão 3
--     3. (12 params, com p_card_fee) — versão real da migration 026,
--        com set_config + FOR UPDATE + stock_movements corretos,
--        mas ainda usa CURRENT_DATE (timezone UTC, bug de data)
--
--   Fluxo atual: app → versão 2 (wrapper) → versão 3 (lógica real)
--
-- Solução:
--   1. Dropar as 3 versões existentes
--   2. Recriar versão 3 (lógica real) com timezone Fortaleza
--   3. Recriar versão 2 (wrapper) para compatibilidade com o frontend
--   4. Corrigir rpc_cancel_sale e rpc_return_sale com timezone fix
-- =============================================================================

-- =============================================================================
-- 1. DROP das 3 versões sobrecarregadas de rpc_create_sale
-- =============================================================================
DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid
);
DROP FUNCTION IF EXISTS public.rpc_create_sale(
  boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid
);
DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric
);

-- =============================================================================
-- 2. rpc_create_sale — versão real (lógica completa + timezone Fortaleza)
-- =============================================================================
CREATE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    text,
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric DEFAULT 0,
  p_surcharge_amount  numeric DEFAULT 0
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Data no fuso de Fortaleza (UTC-3, sem DST)
  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;

  v_card_fee  := GREATEST(0, COALESCE(p_card_fee, 0));
  v_surcharge := GREATEST(0, COALESCE(p_surcharge_amount, 0));

  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor nao esta associado a uma empresa.'
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid := (v_item->>'product_variation_id')::int;

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS NULL THEN
      RAISE EXCEPTION 'Variacao #% nao encontrada.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;
    IF v_item_company != v_company_id THEN
      RAISE EXCEPTION 'Variacao #% nao pertence a empresa do vendedor.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_gross        := GREATEST(0, ROUND(v_subtotal - p_discount_amount + p_shipping_charged + v_surcharge, 2));
  v_total        := GREATEST(0, v_gross - p_cashback_used);
  v_eff_cashback := v_gross - v_total;

  -- Pré-lock ordenado por pvid para evitar deadlock em vendas concorrentes
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items)
    ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    p_payment_method::payment_method,
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

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

    -- Lê estoque atual (row já bloqueada pelo pré-lock acima)
    SELECT quantity INTO v_current_qty
    FROM stock WHERE product_variation_id = v_pvid;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Estoque insuficiente para variacao #%. Disponivel: %, solicitado: %.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty USING ERRCODE = 'P0001';
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

  -- Receita bruta
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
  );

  -- Cashback como dedutor de receita
  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'cashback_used', 'Cashback — Venda ' || v_sale_number,
      v_eff_cashback, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- Taxa de cartão como despesa operacional
  IF v_card_fee > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'expense', 'operational', 'Taxa de cartao — Venda ' || v_sale_number,
      v_card_fee, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- 3. rpc_create_sale — wrapper para compatibilidade com frontend
--    (p_accumulate_cashback ignorado por ora; p_card_fee fixo em 0)
-- =============================================================================
CREATE FUNCTION public.rpc_create_sale(
  p_accumulate_cashback boolean,
  p_cashback_used       numeric,
  p_customer_id         int,
  p_discount_amount     numeric,
  p_items               jsonb,
  p_notes               text,
  p_payment_method      text,
  p_sale_origin         text,
  p_seller_id           uuid,
  p_shipping_charged    numeric,
  p_surcharge_amount    numeric,
  p_system_user_id      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.rpc_create_sale(
    p_customer_id,
    p_seller_id,
    p_payment_method,
    p_sale_origin,
    p_discount_amount,
    p_cashback_used,
    p_shipping_charged,
    p_notes,
    p_items,
    p_system_user_id,
    0,               -- p_card_fee
    p_surcharge_amount
  );
END;
$$;

-- =============================================================================
-- 4. rpc_cancel_sale — timezone Fortaleza + set_config + stock_movements
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

  UPDATE sales SET status = 'cancelled' WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock
    WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id,
    p_system_user_id,
    v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 5. rpc_return_sale — timezone Fortaleza + set_config + stock_movements
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

  UPDATE sales SET status = 'returned' WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock
    WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id,
    p_system_user_id,
    v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 6. Grants
-- =============================================================================
GRANT EXECUTE ON FUNCTION public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_sale(boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale(int, uuid) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale(int, uuid) TO service_role, authenticated;
