-- =============================================================================
-- 20260812_add_company_id_dashboard_mvs.sql
--
-- Correção de tenant isolation no Dashboard (`/`), agora usado por todos os
-- roles (usuario passou a usar o mesmo dashboard de gerente/admin).
--
-- CAUSA RAIZ: src/services/dashboard.ts consulta mv_product_performance
-- (top produtos) e mv_stock_status (alertas de estoque) sem nenhum filtro
-- de company_id — porque NENHUMA das duas tem essa coluna. São agregados
-- globais desde a criação (20260611_create_analytics_views.sql), de antes
-- da fundação multi-tenant. Não dá para "filtrar" o que a view não expõe —
-- por isso esta migration RECRIA as duas views com company_id, em vez de
-- inventar um filtro que não filtraria nada.
--
-- mv_product_performance já faz JOIN com products p — company_id só
-- precisa ser adicionado ao SELECT/GROUP BY, o JOIN já existe.
-- mv_stock_status já faz JOIN com products p (via product_variations) —
-- mesma situação.
--
-- Índice único preservado sem mudança: product_id (mv_product_performance)
-- e product_variation_id (mv_stock_status) já são globalmente únicos
-- (products.id e product_variations.id são SERIAL globais, não compostos
-- por empresa) — adicionar company_id não quebra a unicidade nem exige
-- recriar o índice como composto.
--
-- DEPENDENTES (CASCADE ao dropar, recriados abaixo sem nenhuma alteração
-- de lógica — só existem aqui porque o DROP CASCADE os derruba):
--   mv_product_performance → mv_abc_by_revenue, mv_abc_by_profit,
--     mv_abc_by_volume (usadas só por /inteligencia/abc — módulo
--     bloqueado, fora de escopo; recriadas idênticas, sem tenant filter,
--     mesmo comportamento de antes desta migration)
--   mv_stock_status → vw_data_quality_issues (usada só por
--     /inteligencia/auditoria — módulo bloqueado, fora de escopo;
--     recriada idêntica à versão de
--     202608101300_fix_mv_stock_status_stock_balances.sql)
--
-- refresh_analytics_views() (20260611_create_analytics_views.sql) não
-- precisa mudar — só chama REFRESH MATERIALIZED VIEW CONCURRENTLY por
-- nome, indiferente a colunas novas.
--
-- IDEMPOTENTE: DROP ... IF EXISTS CASCADE + CREATE.
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. mv_product_performance — + company_id
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS public.mv_product_performance CASCADE;

CREATE MATERIALIZED VIEW public.mv_product_performance AS
SELECT
  p.id                        AS product_id,
  p.company_id,
  p.name                      AS product_name,
  p.sku,
  p.category_id,
  p.supplier_id,
  p.base_cost,
  p.base_price,
  p.margin_pct,
  COALESCE(SUM(si.quantity), 0)                AS total_units_sold,
  COALESCE(SUM(si.total_price), 0)             AS total_revenue,
  COALESCE(SUM(si.gross_profit), 0)            AS total_gross_profit,
  COALESCE(SUM(si.quantity * si.unit_cost), 0) AS total_cost,
  AVG(si.unit_price)                           AS avg_selling_price,
  ROUND(
    CASE WHEN COALESCE(SUM(si.total_price), 0) > 0
    THEN COALESCE(SUM(si.gross_profit), 0) / SUM(si.total_price) * 100
    ELSE 0 END, 2
  )                                            AS realized_margin_pct,
  MIN(s.sale_date)                             AS first_sale_date,
  MAX(s.sale_date)                             AS last_sale_date
FROM public.products p
JOIN public.product_variations pv ON pv.product_id = p.id
LEFT JOIN public.sale_items si ON si.product_variation_id = pv.id
LEFT JOIN public.sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
GROUP BY p.id, p.company_id, p.name, p.sku, p.category_id, p.supplier_id, p.base_cost, p.base_price, p.margin_pct;

CREATE UNIQUE INDEX mv_product_performance_pkey ON public.mv_product_performance(product_id);
CREATE INDEX mv_product_performance_company_idx ON public.mv_product_performance(company_id);

GRANT SELECT ON public.mv_product_performance TO authenticated, service_role;

REFRESH MATERIALIZED VIEW public.mv_product_performance;

-- ─── Dependentes de mv_product_performance — recriados idênticos ───────────
-- (só existem aqui por causa do CASCADE acima; nenhuma coluna/lógica mudou)

CREATE MATERIALIZED VIEW public.mv_abc_by_revenue AS
WITH ranked AS (
  SELECT
    product_id,
    total_revenue,
    SUM(total_revenue) OVER ()                                                       AS grand_total,
    SUM(total_revenue) OVER (ORDER BY total_revenue DESC ROWS UNBOUNDED PRECEDING)   AS cumulative_revenue
  FROM public.mv_product_performance
  WHERE total_revenue > 0
),
pct AS (
  SELECT
    product_id,
    total_revenue,
    ROUND(total_revenue / grand_total * 100, 2) AS revenue_pct,
    ROUND(cumulative_revenue / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_revenue,
  revenue_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX mv_abc_by_revenue_pkey ON public.mv_abc_by_revenue(product_id);
GRANT SELECT ON public.mv_abc_by_revenue TO authenticated, service_role;

CREATE MATERIALIZED VIEW public.mv_abc_by_profit AS
WITH ranked AS (
  SELECT
    product_id,
    total_gross_profit,
    SUM(total_gross_profit) OVER ()                                                          AS grand_total,
    SUM(total_gross_profit) OVER (ORDER BY total_gross_profit DESC ROWS UNBOUNDED PRECEDING) AS cumulative_profit
  FROM public.mv_product_performance
  WHERE total_gross_profit > 0
),
pct AS (
  SELECT
    product_id,
    total_gross_profit,
    ROUND(total_gross_profit / grand_total * 100, 2) AS profit_pct,
    ROUND(cumulative_profit / grand_total * 100, 2)  AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_gross_profit,
  profit_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX mv_abc_by_profit_pkey ON public.mv_abc_by_profit(product_id);
GRANT SELECT ON public.mv_abc_by_profit TO authenticated, service_role;

CREATE MATERIALIZED VIEW public.mv_abc_by_volume AS
WITH ranked AS (
  SELECT
    product_id,
    total_units_sold,
    SUM(total_units_sold) OVER ()                                                        AS grand_total,
    SUM(total_units_sold) OVER (ORDER BY total_units_sold DESC ROWS UNBOUNDED PRECEDING) AS cumulative_units
  FROM public.mv_product_performance
  WHERE total_units_sold > 0
),
pct AS (
  SELECT
    product_id,
    total_units_sold,
    ROUND(total_units_sold::NUMERIC / grand_total * 100, 2) AS volume_pct,
    ROUND(cumulative_units::NUMERIC / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_units_sold,
  volume_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX mv_abc_by_volume_pkey ON public.mv_abc_by_volume(product_id);
GRANT SELECT ON public.mv_abc_by_volume TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. mv_stock_status — + company_id
-- Base: 202608101300_fix_mv_stock_status_stock_balances.sql
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS public.mv_stock_status CASCADE;

CREATE MATERIALIZED VIEW public.mv_stock_status AS
SELECT
  sb.product_variation_id,
  p.id                                                                AS product_id,
  p.company_id,
  p.name                                                              AS product_name,
  p.sku,
  sb.quantity                                                         AS current_qty,
  sb.avg_cost,
  ROUND(sb.quantity * sb.avg_cost, 2)                                 AS stock_value_at_cost,
  ROUND(sb.quantity * COALESCE(pv.price_override, p.base_price), 2)   AS stock_value_at_price,
  p.base_price,
  p.margin_pct,
  (SELECT MAX(sl.entry_date) FROM public.stock_lots sl
   WHERE sl.product_variation_id = sb.product_variation_id)           AS last_entry_date,
  (SELECT MAX(s2.sale_date) FROM public.sales s2
   JOIN public.sale_items si2 ON si2.sale_id = s2.id
   WHERE si2.product_variation_id = sb.product_variation_id
   AND s2.status NOT IN ('cancelled', 'returned'))                     AS last_sale_date
FROM public.stock_balances sb
JOIN public.stock_locations loc ON loc.id = sb.stock_location_id AND loc.is_main_store = true
JOIN public.product_variations pv ON pv.id = sb.product_variation_id
JOIN public.products p ON p.id = pv.product_id;

CREATE UNIQUE INDEX mv_stock_status_pkey ON public.mv_stock_status(product_variation_id);
CREATE INDEX mv_stock_status_company_idx ON public.mv_stock_status(company_id);

GRANT SELECT ON public.mv_stock_status TO authenticated, service_role;

REFRESH MATERIALIZED VIEW public.mv_stock_status;

-- ─── Dependente de mv_stock_status — recriado idêntico ─────────────────────
-- (só existe aqui por causa do CASCADE acima; cópia exata de
-- 202608101300_fix_mv_stock_status_stock_balances.sql — nenhuma coluna,
-- filtro ou lógica alterada)

CREATE OR REPLACE VIEW public.vw_data_quality_issues AS

SELECT
  'lot_cost_zero'                                                        AS issue_type,
  'critical'                                                             AS severity,
  'stock_lot'                                                            AS entity_type,
  sl.id::text                                                            AS entity_id,
  p.name || ' — ' || pv.sku_variation                                   AS entity_label,
  'unit_cost=' || sl.unit_cost
    || ' mas total_lot_cost=0. Custo real não contabilizado.'            AS description,
  'UPDATE stock_lots SET total_lot_cost = unit_cost * quantity_original'
    || ' + freight_cost + tax_cost WHERE id = ' || sl.id                AS suggested_action,
  sl.entry_date                                                          AS reference_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.unit_cost > 0 AND sl.total_lot_cost = 0

UNION ALL

SELECT
  'stock_divergence', 'critical', 'variation',
  total_sb.product_variation_id::text,
  p.name || ' — ' || pv.sku_variation,
  'Saldo em stock_balances=' || total_sb.qty
    || ' diverge do ledger (movimentos=' || COALESCE(total_mv.qty, 0)
    || ', delta=' || (total_sb.qty - COALESCE(total_mv.qty, 0)) || ').',
  'Verificar movimentos do produto. Executar reconciliação manual após inventário físico.',
  total_sb.last_updated::date
FROM (
  SELECT product_variation_id, SUM(quantity)::int AS qty, MAX(last_updated) AS last_updated
  FROM stock_balances
  GROUP BY product_variation_id
) total_sb
JOIN product_variations pv ON pv.id = total_sb.product_variation_id
JOIN products p             ON p.id  = pv.product_id
LEFT JOIN (
  SELECT product_variation_id, SUM(quantity)::int AS qty
  FROM stock_movements
  GROUP BY product_variation_id
) total_mv ON total_mv.product_variation_id = total_sb.product_variation_id
WHERE total_sb.qty != COALESCE(total_mv.qty, 0)

UNION ALL

SELECT
  'sale_no_payment', 'critical', 'sale',
  s.id::text,
  'Venda #' || s.id || COALESCE(' — ' || c.name, ''),
  'Venda com status "' || s.status || '" sem linha em sale_payments. Caixa pode estar incorreto.',
  'Verificar e registrar pagamento manualmente em /vendas/' || s.id,
  s.created_at::date
FROM sales s
LEFT JOIN customers c ON c.id = s.customer_id
WHERE s.status IN ('paid', 'shipped', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)

UNION ALL

SELECT
  'lot_freight_no_total_cost', 'high', 'stock_lot',
  sl.id::text,
  p.name || ' — ' || pv.sku_variation,
  'freight_cost=R$' || sl.freight_cost || ' mas total_lot_cost=0. Frete não incorporado ao custo.',
  'Verificar se unit_cost está preenchido e recalcular total_lot_cost para lote #' || sl.id,
  sl.entry_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.freight_cost > 0 AND sl.total_lot_cost = 0

UNION ALL

SELECT
  'lot_remaining_negative', 'high', 'stock_lot',
  sl.id::text,
  p.name || ' — ' || pv.sku_variation,
  'quantity_remaining=' || sl.quantity_remaining
    || ' (negativo). Lote vendido além do recebido.',
  'Investigar movimentos do lote #' || sl.id || '. Possível bypass do RPC ou bug em cancelamento.',
  sl.entry_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.quantity_remaining < 0

UNION ALL

SELECT
  'product_negative_margin', 'high', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Margem negativa: custo R$' || p.base_cost
    || ' > preço R$' || p.base_price
    || ' (' || ROUND(p.margin_pct, 1) || '%). Cada venda gera prejuízo.',
  'Corrigir base_cost ou base_price em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true AND p.margin_pct < 0

UNION ALL

SELECT
  'product_no_price', 'high', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'base_price=0. Produto não pode ser vendido com valor correto.',
  'Preencher preço de venda em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true AND COALESCE(p.base_price, 0) = 0

UNION ALL

SELECT
  'variation_no_sku', 'high', 'variation',
  pv.id::text,
  p.name || ' — variação #' || pv.id,
  'sku_variation ausente. Quebra rastreabilidade de lotes e integrações.',
  'Preencher sku_variation em /produtos/' || p.id,
  pv.created_at::date
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
WHERE pv.active = true
  AND (pv.sku_variation IS NULL OR TRIM(pv.sku_variation) = '')

UNION ALL

SELECT
  'dead_stock', 'high', 'variation',
  ms.product_variation_id::text,
  ms.product_name || ' — ' || pv.sku_variation,
  'Estoque=' || ms.current_qty || ' un. (R$' || ms.stock_value_at_cost
    || ' em custo), entrada em ' || ms.last_entry_date
    || ', nunca vendido.',
  'Avaliar promoção, transferência ou descarte do estoque parado.',
  ms.last_entry_date
FROM mv_stock_status ms
JOIN product_variations pv ON pv.id = ms.product_variation_id
WHERE ms.current_qty > 0
  AND ms.last_sale_date IS NULL
  AND ms.last_entry_date < CURRENT_DATE - INTERVAL '30 days'

UNION ALL

SELECT
  'product_no_supplier', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Produto de terceiro sem fornecedor. Custo não rastreável por fornecedor.',
  'Vincular fornecedor em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true
  AND p.supplier_id IS NULL
  AND p.origin = 'third_party'

UNION ALL

SELECT
  'product_no_ncm', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'NCM ausente. Obrigatório para emissão de NF-e e classificação fiscal.',
  'Preencher NCM em /produtos/' || p.id || '/editar → Dados Fiscais.',
  p.created_at::date
FROM products p
WHERE p.active = true AND p.ncm IS NULL

UNION ALL

SELECT
  'product_no_sale_90d', 'medium', 'variation',
  ms.product_variation_id::text,
  ms.product_name || ' — ' || pv.sku_variation,
  'Estoque=' || ms.current_qty || ' un., última venda em '
    || ms.last_sale_date || ' ('
    || (CURRENT_DATE - ms.last_sale_date) || ' dias atrás).',
  'Avaliar desconto pontual ou redistribuição do estoque parado.',
  ms.last_sale_date
FROM mv_stock_status ms
JOIN product_variations pv ON pv.id = ms.product_variation_id
WHERE ms.current_qty > 0
  AND ms.last_sale_date IS NOT NULL
  AND ms.last_sale_date < CURRENT_DATE - INTERVAL '90 days'

UNION ALL

SELECT
  'margin_below_target', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Margem ' || ROUND(p.margin_pct, 1) || '% abaixo do alvo de 20%.'
    || ' Custo R$' || p.base_cost || ', preço R$' || p.base_price || '.',
  'Renegociar custo com fornecedor ou revisar preço de venda.',
  p.created_at::date
FROM products p
WHERE p.active = true
  AND p.margin_pct >= 0
  AND p.margin_pct < 20

UNION ALL

SELECT
  'supplier_inactive', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ') — Forn: ' || sup.name,
  'Produto ativo vinculado ao fornecedor "' || sup.name || '" que está inativo.',
  'Reativar fornecedor, vincular outro, ou desativar produto em /produtos/' || p.id,
  p.created_at::date
FROM products p
JOIN suppliers sup ON sup.id = p.supplier_id
WHERE p.active = true AND sup.active = false;

GRANT SELECT ON public.vw_data_quality_issues TO authenticated, service_role;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'mv_product_performance' AND column_name = 'company_id';
-- Esperado: 1 linha

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'mv_stock_status' AND column_name = 'company_id';
-- Esperado: 1 linha

SELECT matviewname FROM pg_matviews
WHERE schemaname = 'public'
  AND matviewname IN ('mv_product_performance','mv_abc_by_revenue','mv_abc_by_profit','mv_abc_by_volume','mv_stock_status');
-- Esperado: 5 linhas

SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = 'vw_data_quality_issues';
-- Esperado: 1 linha

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplicar, nesta ordem:
--   1. supabase/migrations/20260611_create_analytics_views.sql
--      (PARTE mv_product_performance + mv_abc_by_revenue/profit/volume,
--       sem company_id)
--   2. supabase/migrations/202608101300_fix_mv_stock_status_stock_balances.sql
--      (mv_stock_status sem company_id + vw_data_quality_issues)
-- Não há rollback de dados: as duas MVs continuam com as mesmas linhas,
-- só a coluna company_id (e o índice secundário) deixam de existir.
*/
-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
