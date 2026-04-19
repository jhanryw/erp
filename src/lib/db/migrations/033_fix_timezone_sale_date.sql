-- =============================================================================
-- Migration 033: Corrigir timezone nas funções de venda
--
-- Causa raiz: o Supabase roda em UTC. CURRENT_DATE retorna a data UTC, então
-- vendas criadas às 22h de Fortaleza (-03h) eram salvas com a data do dia
-- seguinte (já que UTC já virou meia-noite).
--
-- Solução: substituir CURRENT_DATE por
--   (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date
-- em todas as funções que gravam sale_date e reference_date.
--
-- Também corrige registros históricos onde sale_date ficou errado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Corrigir dados históricos
--    Atualiza apenas as vendas cujo sale_date diverge da data correta em Fortaleza.
--    Usa created_at (timestamptz) como fonte da verdade.
-- -----------------------------------------------------------------------------
UPDATE sales
SET sale_date = (created_at AT TIME ZONE 'America/Fortaleza')::date
WHERE sale_date <> (created_at AT TIME ZONE 'America/Fortaleza')::date;

-- Corrige o reference_date dos lançamentos financeiros gerados por vendas
-- (finance_entries com sale_id não nulo).
UPDATE finance_entries
SET reference_date = (created_at AT TIME ZONE 'America/Fortaleza')::date
WHERE sale_id IS NOT NULL
  AND reference_date <> (created_at AT TIME ZONE 'America/Fortaleza')::date;

-- -----------------------------------------------------------------------------
-- 2. rpc_create_sale — substitui CURRENT_DATE por data brasileira
-- -----------------------------------------------------------------------------
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
  v_sale_id       int;
  v_sale_number   text;
  v_subtotal      numeric := 0;
  v_total         numeric;
  v_item          jsonb;
  v_pvid          int;
  v_qty           int;
  v_unit_price    numeric;
  v_unit_cost     numeric;
  v_discount      numeric;
  v_current_qty   int;
  v_item_total    numeric;
  v_brazil_date   date;
BEGIN
  -- Data no fuso de Fortaleza (UTC-3, sem DST)
  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;

  -- Calcular subtotal iterando sobre os itens
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_total := GREATEST(0,
    v_subtotal - p_discount_amount - p_cashback_used + p_shipping_charged
  );

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2),
    p_discount_amount,
    p_cashback_used,
    p_shipping_charged,
    ROUND(v_total, 2),
    p_payment_method,
    p_sale_origin,
    p_notes,
    v_brazil_date
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

    SELECT quantity INTO v_current_qty
    FROM stock
    WHERE product_variation_id = v_pvid
    FOR UPDATE;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Disponível: %, solicitado: %.',
        v_pvid,
        COALESCE(v_current_qty, 0),
        v_qty
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'income', 'sale',
    'Venda ' || v_sale_number,
    ROUND(v_total, 2),
    v_brazil_date,
    v_sale_id,
    p_system_user_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. rpc_cancel_sale — substitui CURRENT_DATE por data brasileira
-- -----------------------------------------------------------------------------
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
  v_sale record;
  v_item record;
BEGIN
  SELECT id, status, total, sale_number INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
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
    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id,
    p_system_user_id
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. rpc_return_sale — substitui CURRENT_DATE por data brasileira
-- -----------------------------------------------------------------------------
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
  v_sale record;
  v_item record;
BEGIN
  SELECT id, status, total, sale_number INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
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
    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id,
    p_system_user_id
  );
END;
$$;
