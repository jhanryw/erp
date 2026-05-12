-- Migration 018: Atualiza mv_stock_status com novas colunas
--
-- Mudanças:
--   - Mantém como VIEW normal (já está, não MATERIALIZED)
--   - Adiciona pv.sku_variation (SKU único da variação)
--   - Adiciona coluna "tamanho": valor do atributo de tipo 'tamanho'
--   - Adiciona coluna "cor":     valor do atributo de tipo 'cor'

DROP VIEW IF EXISTS mv_stock_status CASCADE;

CREATE VIEW mv_stock_status AS
SELECT
  s.product_variation_id,
  p.id                              AS product_id,
  p.name                            AS product_name,
  pv.sku_variation,
  p.sku                             AS sku_parent,
  s.quantity                        AS current_qty,
  s.avg_cost,
  ROUND(s.quantity * s.avg_cost, 2) AS stock_value_at_cost,
  ROUND(s.quantity * COALESCE(pv.price_override, p.base_price), 2) AS stock_value_at_price,
  p.base_price,
  p.margin_pct,
  (
    SELECT vv.value
    FROM product_variation_attributes pva
    JOIN variation_values vv ON vv.id = pva.variation_value_id
    JOIN variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'tamanho'
    WHERE pva.product_variation_id = s.product_variation_id
    LIMIT 1
  ) AS tamanho,
  (
    SELECT vv.value
    FROM product_variation_attributes pva
    JOIN variation_values vv ON vv.id = pva.variation_value_id
    JOIN variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'cor'
    WHERE pva.product_variation_id = s.product_variation_id
    LIMIT 1
  ) AS cor,
  (
    SELECT MAX(sl.entry_date)
    FROM stock_lots sl
    WHERE sl.product_variation_id = s.product_variation_id
  ) AS last_entry_date,
  (
    SELECT MAX(s2.sale_date)
    FROM sales s2
    JOIN sale_items si2 ON si2.sale_id = s2.id
    WHERE si2.product_variation_id = s.product_variation_id
    AND s2.status NOT IN ('cancelled', 'returned')
  ) AS last_sale_date
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id;

GRANT SELECT ON mv_stock_status TO authenticated, service_role;
