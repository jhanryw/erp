-- =============================================================================
-- 006_sales_flow_consistency.sql — Consistência total do fluxo de vendas
-- Santtorini ERP
--
-- Problemas corrigidos:
--   1. stock_movements não tinha company_id → filtros no extrato falhavam
--   2. sales não tinha updated_at → rpc_cancel_sale e rpc_return_sale falhavam
--   3. RPCs inseriam em stock_movements sem company_id (NOT NULL violation)
--   4. rpc_create_sale não validava que itens pertencem à empresa do vendedor
--
-- EXECUTAR APÓS 001–005.
-- Idempotente: usa IF NOT EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- =============================================================================
-- 1. Adicionar updated_at a sales (resolvido antes dos RPCs para evitar erro)
-- =============================================================================

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Backfill: usar created_at como valor inicial para registros existentes
UPDATE public.sales
SET updated_at = created_at
WHERE updated_at IS NULL;

ALTER TABLE public.sales
  ALTER COLUMN updated_at SET DEFAULT NOW();

-- =============================================================================
-- 2. Adicionar company_id a stock_movements
-- =============================================================================

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);

-- Backfill: derivar via product_id → products.company_id
UPDATE public.stock_movements sm
SET company_id = p.company_id
FROM public.products p
WHERE p.id = sm.product_id
  AND sm.company_id IS NULL;

-- Após backfill, tornar obrigatório
ALTER TABLE public.stock_movements
  ALTER COLUMN company_id SET NOT NULL;

-- Índice para queries filtradas por empresa
CREATE INDEX IF NOT EXISTS idx_stock_mv_company
  ON public.stock_movements (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_mv_company_type
  ON public.stock_movements (company_id, type, created_at DESC);

-- =============================================================================
-- 3. Atualizar RLS de stock_movements para incluir company_id
-- =============================================================================

DROP POLICY IF EXISTS "stock_movements_select" ON public.stock_movements;
CREATE POLICY "stock_movements_select"
  ON public.stock_movements FOR SELECT
  TO authenticated
  USING (
    company_id = public.current_company_id()
    AND public.get_user_role() IN ('admin', 'gerente')
  );

-- =============================================================================
-- 4. rpc_create_sale — inclui:
--    a) company_id nos stock_movements
--    b) validação que cada item pertence à empresa do vendedor
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
  v_company_id    int;
  v_item_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do vendedor — não confiamos em valor vindo do cliente
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor não está associado a uma empresa.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Calcular subtotal + validar que cada item pertence à empresa do vendedor
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
      RAISE EXCEPTION
        'Variação #% não pertence à empresa do vendedor.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;

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
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, p_cashback_used, p_shipping_charged,
    ROUND(v_total, 2), p_payment_method, p_sale_origin, p_notes,
    CURRENT_DATE, v_company_id
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

    -- FOR UPDATE: serializa vendas concorrentes do mesmo produto
    SELECT quantity INTO v_current_qty
    FROM stock
    WHERE product_variation_id = v_pvid
    FOR UPDATE;

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

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    ROUND(v_total, 2), CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- 5. rpc_cancel_sale — inclui company_id nos stock_movements
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
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
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
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 6. rpc_return_sale — inclui company_id nos stock_movements
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
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
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
-- 7. rpc_stock_entry — inclui company_id nos stock_movements
-- (mesma lógica de 005, apenas adiciona company_id ao INSERT de stock_movements)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_entry(
  p_product_variation_id int,
  p_supplier_id          int,
  p_entry_type           text,
  p_quantity_original    int,
  p_unit_cost            numeric,
  p_freight_cost         numeric,
  p_tax_cost             numeric,
  p_entry_date           date,
  p_notes                text,
  p_system_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_lot_cost  numeric;
  v_cost_per_unit   numeric;
  v_lot_id          uuid;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
  v_company_id      int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do produto
  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Variação de produto #% não encontrada.', p_product_variation_id
      USING ERRCODE = 'P0001';
  END IF;

  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

  INSERT INTO stock_lots (
    product_variation_id, supplier_id, entry_type,
    quantity_original, quantity_remaining,
    unit_cost, freight_cost, tax_cost,
    total_lot_cost, cost_per_unit,
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
    v_total_lot_cost, v_cost_per_unit,
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;

  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, ROUND(v_new_avg_cost, 6), NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity = v_new_qty, avg_cost = ROUND(v_new_avg_cost, 6), last_updated = NOW();

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, notes, created_by, company_id
  )
  SELECT p_product_variation_id, pv.product_id, 'entry', p_quantity_original,
         v_prev_qty::int, v_new_qty::int,
         v_cost_per_unit, v_lot_id::text, p_notes, p_system_user_id, v_company_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2), p_entry_date, v_lot_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object(
    'lot_id',         v_lot_id,
    'new_quantity',   v_new_qty,
    'new_avg_cost',   ROUND(v_new_avg_cost, 6),
    'total_lot_cost', ROUND(v_total_lot_cost, 2),
    'cost_per_unit',  ROUND(v_cost_per_unit, 6)
  );
END;
$$;

-- =============================================================================
-- 8. rpc_stock_adjust — inclui company_id nos stock_movements
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_adjust(
  p_product_variation_id int,
  p_delta                int,
  p_reason               text,
  p_notes                text,
  p_system_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty      int     := 0;
  v_current_avg_cost numeric := 0;
  v_new_qty          int;
  v_movement_notes   text;
  v_company_id       int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  -- Derivar company_id do produto
  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Variação de produto #% não encontrada.', p_product_variation_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT quantity, avg_cost INTO v_current_qty, v_current_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION
      'Estoque insuficiente. Atual: %, ajuste: %.', v_current_qty, p_delta
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  v_movement_notes := p_reason
    || CASE WHEN p_notes IS NOT NULL AND p_notes != ''
            THEN ': ' || p_notes ELSE '' END;

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, notes, created_by, company_id
  )
  SELECT p_product_variation_id, pv.product_id, 'adjust', p_delta,
         v_current_qty, v_new_qty,
         v_current_avg_cost, v_movement_notes, p_system_user_id, v_company_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  IF p_delta < 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, notes, created_by, company_id
    )
    VALUES (
      'expense', 'other_expense',
      'Ajuste de estoque (' || p_reason || '): '
        || ABS(p_delta)::text || ' un. — var. #'
        || p_product_variation_id::text,
      ROUND(ABS(p_delta) * v_current_avg_cost, 2),
      CURRENT_DATE, p_notes, p_system_user_id, v_company_id
    );
  END IF;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta
  );
END;
$$;

-- =============================================================================
-- 9. rpc_stock_initialize — inclui company_id nos stock_movements
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_initialize(
  p_product_variation_id int,
  p_quantity             int,
  p_avg_cost             numeric,
  p_system_user_id       uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do produto
  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, p_quantity, COALESCE(p_avg_cost, 0), NOW())
  ON CONFLICT (product_variation_id) DO NOTHING;

  IF p_quantity > 0 THEN
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, notes, created_by, company_id
    )
    SELECT p_product_variation_id, pv.product_id, 'initial', p_quantity,
           0, p_quantity, p_avg_cost, 'Saldo inicial de carga', p_system_user_id, v_company_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;
  END IF;
END;
$$;

-- =============================================================================
-- 10. Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust     TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO 006
-- =============================================================================
