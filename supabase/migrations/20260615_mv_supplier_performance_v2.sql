-- =============================================================================
-- 20260615_mv_supplier_performance_v2.sql
--
-- Parte 1: reescreve mv_supplier_performance
--   Mantém todas as colunas existentes para compatibilidade com telas atuais.
--   Adiciona: supplier_state, total_units_purchased, total_freight_cost,
--             total_tax_cost, avg_real_cost_per_unit, avg_freight_pct,
--             avg_tax_pct, e os campos estimated_* documentados como estimativa.
--   Corrige: product_count (agora via stock_lots, não products.supplier_id).
--   Corrige: JOIN sales filtrado corretamente (não LEFT JOIN) para excluir
--            itens de vendas canceladas/devolvidas em ambos os CTEs de venda.
--
-- Parte 2: cria vw_supplier_cost_by_product (VIEW regular, somente compras)
--
-- Segurança:
--   DROP sem CASCADE — nenhum objeto SQL depende desta view (confirmado via grep).
--   Os indexes são descartados automaticamente com a materialized view.
-- =============================================================================


-- ─── Parte 1: mv_supplier_performance ────────────────────────────────────────

DROP MATERIALIZED VIEW IF EXISTS public.mv_supplier_performance;

CREATE MATERIALIZED VIEW public.mv_supplier_performance AS

  -- CTE 1: dados de compra — precisos, direto de stock_lots.
  WITH purchase_agg AS (
    SELECT
      sl.supplier_id,
      COUNT(DISTINCT sl.id)         AS total_lots,
      SUM(sl.quantity_original)     AS total_units_purchased,
      SUM(sl.total_lot_cost)        AS total_purchased_value,
      SUM(sl.freight_cost)          AS total_freight_cost,
      SUM(sl.tax_cost)              AS total_tax_cost,
      COUNT(DISTINCT pv.product_id) AS product_count
    FROM stock_lots sl
    JOIN product_variations pv ON pv.id = sl.product_variation_id
    WHERE sl.supplier_id IS NOT NULL
    GROUP BY sl.supplier_id
  ),

  -- CTE 2: vendas com lógica ANTIGA mantida para backward compat com telas.
  -- Atenção: pode sobrecontar total_units_sold se o mesmo fornecedor tem
  -- múltiplos lotes para a mesma variação (cada lote duplica os sale_items
  -- no produto cartesiano antes do GROUP BY). Mantido intencional para
  -- não alterar o que as telas já exibem.
  -- JOIN sales (não LEFT JOIN) para excluir itens de vendas canceladas/devolvidas.
  -- sale_items.sale_id tem FK para sales.id — não há sale_item órfão.
  old_sales AS (
    SELECT
      sl.supplier_id,
      COALESCE(SUM(si.quantity),     0) AS total_units_sold,
      COALESCE(SUM(si.total_price),  0) AS total_revenue,
      COALESCE(SUM(si.gross_profit), 0) AS total_gross_profit
    FROM stock_lots sl
    JOIN product_variations pv ON pv.id = sl.product_variation_id
    LEFT JOIN sale_items si     ON si.product_variation_id = pv.id
    JOIN sales s                ON s.id = si.sale_id
                               AND s.status NOT IN ('cancelled', 'returned')
    WHERE sl.supplier_id IS NOT NULL
    GROUP BY sl.supplier_id
  ),

  -- CTE 3: estimativa de vendas por fornecedor.
  -- Usa DISTINCT supplier × product_variation para evitar a multiplicação
  -- por número de lotes. Ainda assim é uma ESTIMATIVA: cada venda de uma
  -- variação é atribuída a TODOS os fornecedores que já a forneceram.
  -- O ERP não tem rastreio lote → venda, portanto estes valores não
  -- representam margem real por fornecedor — usar apenas para comparação
  -- relativa entre fornecedores.
  -- JOIN sales (não LEFT JOIN) para excluir itens de vendas canceladas/devolvidas.
  estimated_sales AS (
    SELECT
      sv.supplier_id,
      COALESCE(SUM(si.quantity),     0) AS est_units_sold,
      COALESCE(SUM(si.total_price),  0) AS est_revenue,
      COALESCE(SUM(si.gross_profit), 0) AS est_gross_profit
    FROM (
      SELECT DISTINCT supplier_id, product_variation_id
      FROM   stock_lots
      WHERE  supplier_id IS NOT NULL
    ) sv
    LEFT JOIN sale_items si ON si.product_variation_id = sv.product_variation_id
    JOIN sales s            ON s.id = si.sale_id
                           AND s.status NOT IN ('cancelled', 'returned')
    GROUP BY sv.supplier_id
  )

SELECT
  sup.id                                             AS supplier_id,
  sup.name                                           AS supplier_name,
  sup.state                                          AS supplier_state,

  -- ── Compras (precisos) ────────────────────────────────────────────────────
  COALESCE(pa.total_lots,              0)            AS total_lots,
  COALESCE(pa.total_units_purchased,   0)            AS total_units_purchased,
  COALESCE(pa.total_purchased_value,   0)            AS total_purchased_value,
  COALESCE(pa.total_freight_cost,      0)            AS total_freight_cost,
  COALESCE(pa.total_tax_cost,          0)            AS total_tax_cost,
  ROUND(
    CASE WHEN COALESCE(pa.total_units_purchased, 0) > 0
    THEN pa.total_purchased_value / pa.total_units_purchased
    ELSE 0 END, 4
  )                                                  AS avg_real_cost_per_unit,
  ROUND(
    CASE WHEN COALESCE(pa.total_purchased_value, 0) > 0
    THEN pa.total_freight_cost / pa.total_purchased_value * 100
    ELSE 0 END, 2
  )                                                  AS avg_freight_pct,
  ROUND(
    CASE WHEN COALESCE(pa.total_purchased_value, 0) > 0
    THEN pa.total_tax_cost / pa.total_purchased_value * 100
    ELSE 0 END, 2
  )                                                  AS avg_tax_pct,
  COALESCE(pa.product_count,           0)            AS product_count,

  -- ── Vendas legadas (lógica antiga, pode sobrecontar — ver CTE 2) ──────────
  COALESCE(os.total_units_sold,        0)            AS total_units_sold,
  COALESCE(os.total_revenue,           0)            AS total_revenue,
  COALESCE(os.total_gross_profit,      0)            AS total_gross_profit,
  ROUND(
    CASE WHEN COALESCE(os.total_revenue, 0) > 0
    THEN os.total_gross_profit / os.total_revenue * 100
    ELSE 0 END, 2
  )                                                  AS avg_margin_pct,

  -- ── Estimativas de venda (ver CTE 3 — NÃO é margem real por fornecedor) ──
  COALESCE(es.est_units_sold,          0)            AS estimated_total_units_sold,
  COALESCE(es.est_revenue,             0)            AS estimated_total_revenue,
  COALESCE(es.est_gross_profit,        0)            AS estimated_gross_profit,
  ROUND(
    CASE WHEN COALESCE(es.est_revenue, 0) > 0
    THEN es.est_gross_profit / es.est_revenue * 100
    ELSE 0 END, 2
  )                                                  AS estimated_margin_pct

FROM suppliers sup
JOIN  purchase_agg    pa ON pa.supplier_id = sup.id
LEFT JOIN old_sales   os ON os.supplier_id = sup.id
LEFT JOIN estimated_sales es ON es.supplier_id = sup.id;

-- Índice único obrigatório para REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX mv_supplier_performance_pkey
  ON public.mv_supplier_performance (supplier_id);

-- Primeiro refresh sem CONCURRENTLY (index recém-criado em view vazia)
REFRESH MATERIALIZED VIEW public.mv_supplier_performance;


-- ─── Parte 2: vw_supplier_cost_by_product ────────────────────────────────────
-- VIEW regular (não materialized) — stock_lots é pequeno, dados sempre frescos.
-- Analisa SOMENTE compras e custo real. Não toca em vendas.
-- Médias ponderadas pela quantidade — mais correto que média simples
-- quando lotes têm tamanhos diferentes.
-- Responde: qual fornecedor é mais barato por produto/variação,
-- e quanto frete + imposto pesam no custo real.

DROP VIEW IF EXISTS public.vw_supplier_cost_by_product;

CREATE VIEW public.vw_supplier_cost_by_product AS
SELECT
  sup.id                                                   AS supplier_id,
  sup.name                                                 AS supplier_name,
  sup.state                                                AS supplier_state,
  p.id                                                     AS product_id,
  p.name                                                   AS product_name,
  pv.id                                                    AS product_variation_id,
  pv.sku_variation,

  COUNT(sl.id)                                             AS total_lots,
  SUM(sl.quantity_original)                                AS total_qty_purchased,

  -- custo puro médio ponderado pela quantidade (sem frete / imposto)
  ROUND(
    SUM(sl.unit_cost * sl.quantity_original)
    / NULLIF(SUM(sl.quantity_original), 0)
  , 4)                                                     AS avg_unit_cost,

  -- custo real médio ponderado (com frete + imposto incluídos)
  ROUND(
    SUM(sl.total_lot_cost)
    / NULLIF(SUM(sl.quantity_original), 0)
  , 4)                                                     AS avg_cost_per_unit,

  -- frete por unidade ponderado pela quantidade
  ROUND(
    SUM(sl.freight_cost)
    / NULLIF(SUM(sl.quantity_original)::numeric, 0)
  , 4)                                                     AS avg_freight_per_unit,

  -- imposto por unidade ponderado pela quantidade
  ROUND(
    SUM(sl.tax_cost)
    / NULLIF(SUM(sl.quantity_original)::numeric, 0)
  , 4)                                                     AS avg_tax_per_unit,

  -- frete como % do custo real total por unidade
  ROUND(
    SUM(sl.freight_cost)
    / NULLIF(SUM(sl.total_lot_cost), 0) * 100
  , 2)                                                     AS freight_impact_pct,

  -- imposto como % do custo real total por unidade
  ROUND(
    SUM(sl.tax_cost)
    / NULLIF(SUM(sl.total_lot_cost), 0) * 100
  , 2)                                                     AS tax_impact_pct,

  -- quanto frete + imposto encarecem o produto além do preço puro (%)
  -- ex: 15.0 → o produto custa 15% a mais depois de frete + imposto
  ROUND(
    (SUM(sl.total_lot_cost) - SUM(sl.unit_cost * sl.quantity_original))
    / NULLIF(SUM(sl.unit_cost * sl.quantity_original), 0) * 100
  , 2)                                                     AS real_cost_impact_pct,

  MAX(sl.entry_date)                                       AS last_purchase_date

FROM stock_lots sl
JOIN suppliers           sup ON sup.id = sl.supplier_id
JOIN product_variations   pv ON pv.id  = sl.product_variation_id
JOIN products              p ON p.id   = pv.product_id
WHERE sl.supplier_id IS NOT NULL
GROUP BY
  sup.id, sup.name, sup.state,
  p.id,   p.name,
  pv.id,  pv.sku_variation;
