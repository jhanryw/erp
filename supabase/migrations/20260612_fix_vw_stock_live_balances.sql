-- =============================================================================
-- 20260612_fix_vw_stock_live_balances.sql
--
-- PROBLEMA:
--   rpc_stock_adjust grava em stock_balances, mas vw_stock_live lia de stock
--   (tabela antiga). Resultado: ajustes de estoque não apareciam na tela.
--
-- CORREÇÃO:
--   Recria vw_stock_live lendo de stock_balances (Estoque Loja = is_main_store).
--   Mantém cor/tamanho via product_variation_attributes (não pv.color/pv.size,
--   que não existem no schema real).
-- =============================================================================

DROP VIEW IF EXISTS public.vw_stock_live CASCADE;

CREATE VIEW public.vw_stock_live AS
SELECT
  sb.product_variation_id,
  p.id                                                                        AS product_id,
  p.name                                                                      AS product_name,
  pv.sku_variation,
  p.sku                                                                       AS sku_parent,
  pv.sku_variation                                                            AS sku,

  MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS cor,
  MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS tamanho,

  sb.quantity                                                                 AS current_qty,
  sb.avg_cost,
  ROUND(sb.quantity * sb.avg_cost, 2)                                         AS stock_value_at_cost,
  ROUND(sb.quantity * COALESCE(pv.price_override, p.base_price), 2)          AS stock_value_at_price,
  (
    SELECT MAX(sl2.entry_date)
    FROM stock_lots sl2
    WHERE sl2.product_variation_id = sb.product_variation_id
  )                                                                           AS last_entry_date,
  (sb.quantity = 0)                                                           AS out_of_stock,
  (sb.quantity > 0 AND sb.quantity <= 3)                                      AS low_stock

FROM stock_balances sb
JOIN stock_locations loc ON loc.id = sb.stock_location_id AND loc.is_main_store = true
JOIN product_variations pv  ON pv.id = sb.product_variation_id
JOIN products           p   ON p.id  = pv.product_id
LEFT JOIN product_variation_attributes pva ON pva.product_variation_id = pv.id
LEFT JOIN variation_types  vt ON vt.id = pva.variation_type_id
LEFT JOIN variation_values vv ON vv.id = pva.variation_value_id

GROUP BY
  sb.product_variation_id,
  p.id,
  p.name,
  pv.sku_variation,
  p.sku,
  sb.quantity,
  sb.avg_cost,
  pv.price_override,
  p.base_price;

GRANT SELECT ON public.vw_stock_live TO authenticated, service_role;
