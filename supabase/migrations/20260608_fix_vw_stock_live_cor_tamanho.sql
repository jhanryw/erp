-- =============================================================================
-- 20260608_fix_vw_stock_live_cor_tamanho.sql
--
-- PROBLEMA:
--   vw_stock_live referenciava pv.size e pv.color, que não existem em
--   product_variations. Tamanho e cor são armazenados em:
--     product_variation_attributes → variation_values → variation_types (slug)
--
--   Resultado: colunas tamanho e cor sempre retornavam NULL na página /estoque.
--
-- CORREÇÃO:
--   LEFT JOIN na tabela de atributos, agregando o valor pelo slug do tipo.
--   Slugs esperados: 'cor' e 'tamanho' (conforme seed do schema).
--
-- IDEMPOTENTE: CREATE OR REPLACE VIEW.
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_stock_live AS
SELECT
  s.product_variation_id,
  p.id                                                                        AS product_id,
  p.name                                                                       AS product_name,
  pv.sku_variation,
  p.sku                                                                        AS sku_parent,
  pv.sku_variation                                                             AS sku,

  -- Cor e tamanho lidos de product_variation_attributes
  MAX(vv.value) FILTER (WHERE vt.slug = 'cor')      AS cor,
  MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho')  AS tamanho,

  s.quantity                                                                   AS current_qty,
  s.avg_cost,
  ROUND(s.quantity * s.avg_cost, 2)                                            AS stock_value_at_cost,
  ROUND(s.quantity * COALESCE(pv.price_override, p.base_price), 2)            AS stock_value_at_price,
  (
    SELECT MAX(sl.entry_date)
    FROM stock_lots sl
    WHERE sl.product_variation_id = s.product_variation_id
  )                                                                            AS last_entry_date,
  (s.quantity = 0)                                                             AS out_of_stock,
  (s.quantity > 0 AND s.quantity <= 3)                                         AS low_stock

FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p             ON p.id = pv.product_id
-- LEFT JOIN para não perder variações sem atributos cadastrados
LEFT JOIN product_variation_attributes pva ON pva.product_variation_id = pv.id
LEFT JOIN variation_types  vt ON vt.id  = pva.variation_type_id
LEFT JOIN variation_values vv ON vv.id  = pva.variation_value_id

GROUP BY
  s.product_variation_id,
  p.id,
  p.name,
  pv.sku_variation,
  p.sku,
  s.quantity,
  s.avg_cost,
  pv.price_override,
  p.base_price;

GRANT SELECT ON public.vw_stock_live TO authenticated, service_role;
