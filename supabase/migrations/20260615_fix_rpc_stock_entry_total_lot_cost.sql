-- =============================================================================
-- 20260615_fix_rpc_stock_entry_total_lot_cost.sql
--
-- Problema: rpc_stock_entry calculava v_total_lot_cost e v_cost_per_unit
--   localmente mas não os gravava em stock_lots. As colunas total_lot_cost e
--   cost_per_unit ficavam no DEFAULT 0, tornando a view mv_supplier_performance
--   incapaz de calcular custo real por fornecedor.
--   440 lotes antigos foram corrigidos manualmente (R$ 14.363,94 recuperados).
--
-- Correção: adicionar total_lot_cost e cost_per_unit ao INSERT em stock_lots.
--   Nenhuma outra lógica alterada: stock_balances, stock_movements,
--   finance_entries e o RETURN jsonb permanecem idênticos.
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
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja da empresa
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_lot_cost  numeric;
  v_cost_per_unit   numeric;
  v_lot_id          int;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
  v_company_id      int;
  v_location_id     int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

  -- Lote (imutável, sem FK para location — rastreabilidade por nota fiscal)
  INSERT INTO stock_lots (
    product_variation_id, supplier_id, entry_type,
    quantity_original, quantity_remaining,
    unit_cost, freight_cost, tax_cost,
    total_lot_cost, cost_per_unit,
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type::stock_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
    ROUND(v_total_lot_cost, 2), ROUND(v_cost_per_unit, 6),
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  -- Saldo anterior no local escolhido (lock para concorrência)
  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = v_location_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;
  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  -- Upsert em stock_balances (fonte de verdade)
  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (
    p_product_variation_id, v_location_id,
    v_new_qty, ROUND(v_new_avg_cost, 6), NOW()
  )
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  -- Ledger
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    destination_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    'entry', p_quantity_original,
    v_prev_qty::int, v_new_qty::int,
    v_cost_per_unit, v_lot_id::text, v_company_id,
    v_location_id, 'entry', 'lot',
    p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  -- Finance entry (compra de estoque)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2), p_entry_date, v_lot_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object(
    'lot_id',          v_lot_id,
    'new_quantity',    v_new_qty,
    'new_avg_cost',    ROUND(v_new_avg_cost, 6),
    'total_lot_cost',  ROUND(v_total_lot_cost, 2),
    'cost_per_unit',   ROUND(v_cost_per_unit, 6),
    'location_id',     v_location_id
  );
END;
$$;
