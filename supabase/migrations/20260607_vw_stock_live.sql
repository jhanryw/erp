-- View ao vivo para a página operacional de estoque.
-- mv_stock_status é materializada e só atualiza com refresh explícito,
-- causando divergência visível sempre que há venda ou entrada de estoque.
-- Esta view lê diretamente da tabela stock e sempre reflete o estado atual.

CREATE OR REPLACE VIEW public.vw_stock_live AS
SELECT
  s.product_variation_id,
  p.id                                                                        AS product_id,
  p.name                                                                       AS product_name,
  pv.sku_variation,
  p.sku                                                                        AS sku_parent,
  pv.size                                                                      AS tamanho,
  pv.color                                                                     AS cor,
  pv.sku_variation                                                             AS sku,
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
JOIN products p           ON p.id   = pv.product_id;

GRANT SELECT ON public.vw_stock_live TO authenticated, service_role;
