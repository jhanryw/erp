-- =============================================================================
-- 013_stock_company_id.sql
-- Santtorini ERP
--
-- Problema: todos os INSERT INTO stock omitiam company_id, violando o NOT NULL.
-- O v_company_id já era derivado corretamente nas RPCs mas nunca era passado
-- para a linha de estoque.
--
-- Corrige:
--   1. rpc_stock_initialize — principal causa do erro no cadastro de produto
--   2. rpc_cancel_sale     — edge case: stock row inexistente na restauração
--   3. rpc_return_sale     — idem
--   4. rpc_stock_entry     — adiciona v_company_id e inclui no INSERT
--   5. rpc_stock_adjust    — idem
--
-- EXECUTAR APÓS 001–012.
-- =============================================================================

-- =============================================================================
-- 1. rpc_stock_initialize — adiciona company_id ao INSERT INTO stock
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

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
  VALUES (p_product_variation_id, p_quantity, COALESCE(p_avg_cost, 0), NOW(), v_company_id)
  ON CONFLICT (product_variation_id) DO NOTHING;

  -- Registrar movimento SOMENTE se o INSERT criou uma nova linha.
  IF FOUND AND p_quantity > 0 THEN
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
-- 2. rpc_cancel_sale — adiciona company_id ao INSERT INTO stock
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
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW(), v_sale.company_id)
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
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
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 3. rpc_return_sale — adiciona company_id ao INSERT INTO stock
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
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW(), v_sale.company_id)
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
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
-- 4. rpc_stock_entry — adiciona v_company_id e inclui no INSERT INTO stock
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

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

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
    p_unit_cost,
    COALESCE(p_freight_cost, 0),
    COALESCE(p_tax_cost, 0),
    v_total_lot_cost,
    v_cost_per_unit,
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;

  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
  VALUES (p_product_variation_id, v_new_qty, ROUND(v_new_avg_cost, 6), NOW(), v_company_id)
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

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
    ROUND(v_total_lot_cost, 2),
    p_entry_date,
    v_lot_id,
    p_system_user_id,
    v_company_id
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
-- 5. rpc_stock_adjust — adiciona v_company_id e inclui no INSERT INTO stock
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

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

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

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
  VALUES (p_product_variation_id, v_new_qty, v_current_avg_cost, NOW(), v_company_id)
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
-- Grants (reafirmar após CREATE OR REPLACE)
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust     TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO 013
-- =============================================================================
