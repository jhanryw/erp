-- Migration 017: Corrige tipo de v_lot_id em rpc_stock_entry
--
-- Problema: stock_lots.id é bigint (serial), mas a função declarava
--   v_lot_id uuid → RETURNING id INTO v_lot_id falha com
--   "invalid input syntax for type uuid: '1'"
--
-- Solução: trocar v_lot_id uuid → v_lot_id bigint.
--   - RETURNING id INTO v_lot_id: ✅ bigint → bigint
--   - v_lot_id::text em stock_movements.reference_id: ✅ bigint::text ok
--   - v_lot_id em finance_entries.stock_lot_id: ✅ FK bigint → bigint
--   - RETURN jsonb: usa v_lot_id::text para manter lot_id como string no JSON
--     (preserva compatibilidade com StockEntryResult.lot_id: string no TypeScript)
--
-- CREATE OR REPLACE mantém a mesma assinatura — sem DROP necessário.

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
  v_lot_id          bigint;        -- era uuid; stock_lots.id é bigint/serial
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
    p_product_variation_id,
    p_supplier_id,
    p_entry_type::stock_entry_type,   -- cast text → enum (fix migration 016)
    p_quantity_original,
    p_quantity_original,
    p_unit_cost,
    COALESCE(p_freight_cost, 0),
    COALESCE(p_tax_cost, 0),
    v_total_lot_cost,
    v_cost_per_unit,
    p_entry_date,
    p_notes,
    p_system_user_id
  )
  RETURNING id INTO v_lot_id;       -- bigint → bigint: sem erro de cast

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
  SELECT
    p_product_variation_id, pv.product_id, 'entry', p_quantity_original,
    v_prev_qty::int, v_new_qty::int,
    v_cost_per_unit, v_lot_id::text, p_notes, p_system_user_id, v_company_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense',
    'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2),
    p_entry_date,
    v_lot_id,
    p_system_user_id,
    v_company_id
  );

  RETURN jsonb_build_object(
    'lot_id',         v_lot_id::text,  -- ::text preserva StockEntryResult.lot_id: string
    'new_quantity',   v_new_qty,
    'new_avg_cost',   ROUND(v_new_avg_cost, 6),
    'total_lot_cost', ROUND(v_total_lot_cost, 2),
    'cost_per_unit',  ROUND(v_cost_per_unit, 6)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_stock_entry TO service_role, authenticated;
