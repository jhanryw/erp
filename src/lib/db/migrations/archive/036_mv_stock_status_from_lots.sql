-- Migration 036: Refatora mv_stock_status para usar stock_lots como fonte de verdade
--
-- Mudanças:
--   - Remove dependência da tabela stock
--   - Agrega diretamente de stock_lots (quantity_remaining, cost_per_unit)
--   - Custo médio = média ponderada por lote
--   - Adiciona flags: low_stock (qty 1-3), out_of_stock (qty = 0)

DROP VIEW IF EXISTS mv_stock_status CASCADE;

CREATE VIEW mv_stock_status AS
SELECT
  pv.id                                                   AS product_variation_id,
  p.id                                                    AS product_id,
  p.name                                                  AS product_name,
  pv.sku_variation,
  p.sku                                                   AS sku_parent,

  -- Quantidade consolidada dos lotes
  COALESCE(lots.current_qty, 0)::int                      AS current_qty,

  -- Custo médio ponderado
  lots.avg_cost,

  -- Valor em custo = qty * custo médio
  ROUND(COALESCE(lots.current_qty, 0) * COALESCE(lots.avg_cost, 0), 2)
                                                          AS stock_value_at_cost,

  -- Valor em venda = qty * (price_override ?? base_price)
  ROUND(
    COALESCE(lots.current_qty, 0) * COALESCE(pv.price_override, p.base_price),
    2
  )                                                       AS stock_value_at_price,

  p.base_price,
  p.margin_pct,

  -- Flags de alerta
  (COALESCE(lots.current_qty, 0) = 0)                    AS out_of_stock,
  (COALESCE(lots.current_qty, 0) > 0
    AND COALESCE(lots.current_qty, 0) <= 3)              AS low_stock,

  lots.last_entry_date,

  -- Atributo tamanho
  (
    SELECT vv.value
    FROM product_variation_attributes pva
    JOIN variation_values vv ON vv.id = pva.variation_value_id
    JOIN variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'tamanho'
    WHERE pva.product_variation_id = pv.id
    LIMIT 1
  ) AS tamanho,

  -- Atributo cor
  (
    SELECT vv.value
    FROM product_variation_attributes pva
    JOIN variation_values vv ON vv.id = pva.variation_value_id
    JOIN variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'cor'
    WHERE pva.product_variation_id = pv.id
    LIMIT 1
  ) AS cor,

  -- Última venda
  (
    SELECT MAX(s2.sale_date)
    FROM sales s2
    JOIN sale_items si2 ON si2.sale_id = s2.id
    WHERE si2.product_variation_id = pv.id
      AND s2.status NOT IN ('cancelled', 'returned')
  ) AS last_sale_date

FROM product_variations pv
JOIN products p ON p.id = pv.product_id

-- Agrega lotes uma única vez por variação (evita N+1)
LEFT JOIN (
  SELECT
    product_variation_id,
    SUM(quantity_remaining)::int                                      AS current_qty,
    ROUND(
      SUM(quantity_remaining::numeric * cost_per_unit)
        / NULLIF(SUM(quantity_remaining), 0),
      4
    )                                                                 AS avg_cost,
    MAX(entry_date)                                                   AS last_entry_date
  FROM stock_lots
  GROUP BY product_variation_id
) lots ON lots.product_variation_id = pv.id;

GRANT SELECT ON mv_stock_status TO authenticated, service_role;
