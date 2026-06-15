-- =============================================================================
-- 20260615_vw_purchase_suggestions.sql
--
-- Fase 6: Compras Inteligentes
--
-- O que esta migration faz:
--   1. Semente em parameters: purchase_target_stock_days (padrão 60 dias)
--   2. View vw_purchase_suggestions: sugestões de reposição por variação
--
-- O que esta migration NÃO faz:
--   - Não altera dados de estoque, vendas ou lotes
--   - Não cria RPCs nem triggers
--   - Não altera tabelas existentes
--
-- Dependências:
--   stock_balances, sale_items, sales, stock_lots, suppliers,
--   products, product_variations, parameters
--
-- Limitações documentadas:
--   - lead_time_days: derivado do intervalo entre lotes consecutivos (proxy).
--     Default 30 dias para variações com < 2 lotes.
--   - Fornecedor recomendado: baseado nos últimos 180 dias de compras.
--     NULL quando não há lotes no período.
--   - target_stock_days: padrão 60 dias (configurável via parameters).
-- =============================================================================


-- =============================================================================
-- 1. Parâmetro padrão
-- =============================================================================

INSERT INTO public.parameters (key, value, description)
VALUES (
  'purchase_target_stock_days',
  '60',
  'Dias de cobertura alvo para cálculo de reposição (vw_purchase_suggestions). Padrão: 60.'
)
ON CONFLICT (key) DO NOTHING;


-- =============================================================================
-- 2. View principal
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_purchase_suggestions AS

WITH

-- ── Estoque consolidado por variação (soma multi-local) ───────────────────────
-- Fonte de verdade: stock_balances (desde 20260610_multi_estoque.sql)
stock_current AS (
  SELECT
    product_variation_id,
    SUM(quantity)::int                                              AS current_qty,
    SUM(quantity * avg_cost) / NULLIF(SUM(quantity)::numeric, 0)   AS weighted_avg_cost
  FROM public.stock_balances
  GROUP BY product_variation_id
),

-- ── Vendas nos últimos 30 dias ────────────────────────────────────────────────
sales_30d AS (
  SELECT
    si.product_variation_id,
    SUM(si.quantity)::int                                           AS qty_sold_30d
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.status NOT IN ('cancelled', 'returned')
    AND s.sale_date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY si.product_variation_id
),

-- ── Vendas nos últimos 90 dias ────────────────────────────────────────────────
sales_90d AS (
  SELECT
    si.product_variation_id,
    SUM(si.quantity)::int                                           AS qty_sold_90d
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.status NOT IN ('cancelled', 'returned')
    AND s.sale_date >= CURRENT_DATE - INTERVAL '90 days'
  GROUP BY si.product_variation_id
),

-- ── Lead time estimado (intervalo médio entre lotes consecutivos) ─────────────
-- Proxy: não há campo lead_time_days no banco.
-- Usa LAG() sobre entry_dates de stock_lots por variação.
-- Filtra gaps entre 1–180 dias (exclui lotes muito espaçados que seriam outliers).
-- Variações com < 2 lotes retornam NULL aqui → fallback de 30 dias na query final.
lead_time_estimate AS (
  SELECT
    product_variation_id,
    ROUND(AVG(gap_days))::int                                       AS estimated_lead_time_days
  FROM (
    SELECT
      product_variation_id,
      (entry_date - LAG(entry_date) OVER (
        PARTITION BY product_variation_id ORDER BY entry_date
      ))                                                            AS gap_days
    FROM public.stock_lots
    WHERE supplier_id IS NOT NULL
  ) gaps
  WHERE gap_days IS NOT NULL
    AND gap_days BETWEEN 1 AND 180
  GROUP BY product_variation_id
),

-- ── Fornecedor recomendado = menor avg_cost_per_unit nos últimos 180 dias ─────
-- Fórmula idêntica à vw_supplier_cost_by_product (média ponderada por quantidade),
-- mas com filtro de janela entry_date >= hoje - 180 para refletir preços recentes.
-- DISTINCT ON (pv_id) com ORDER BY avg_cost_per_unit ASC = o mais barato vence.
-- Retorna NULL para variações sem lote com fornecedor nos últimos 180 dias.
recommended_supplier AS (
  SELECT DISTINCT ON (pv_id)
    pv_id                                                           AS product_variation_id,
    supplier_id,
    supplier_name,
    avg_cost_per_unit
  FROM (
    SELECT
      sl.product_variation_id                                       AS pv_id,
      sup.id                                                        AS supplier_id,
      sup.name                                                      AS supplier_name,
      ROUND(
        SUM(sl.total_lot_cost)
        / NULLIF(SUM(sl.quantity_original)::numeric, 0)
      , 4)                                                          AS avg_cost_per_unit
    FROM public.stock_lots sl
    JOIN public.suppliers sup ON sup.id = sl.supplier_id
    WHERE sl.supplier_id IS NOT NULL
      AND sl.entry_date >= CURRENT_DATE - INTERVAL '180 days'
    GROUP BY sl.product_variation_id, sup.id, sup.name
    HAVING SUM(sl.quantity_original) > 0
  ) agg
  ORDER BY pv_id, avg_cost_per_unit ASC NULLS LAST
),

-- ── Configuração: dias de cobertura alvo ──────────────────────────────────────
-- Lê parameters['purchase_target_stock_days'].
-- Duplo fallback:
--   (a) parâmetro ausente → subquery retorna NULL → COALESCE → 60
--   (b) valor não-inteiro  → CASE retorna NULL    → COALESCE → 60
config AS (
  SELECT
    COALESCE(
      (
        SELECT
          CASE WHEN value ~ '^\d+$' THEN value::int END
        FROM public.parameters
        WHERE key = 'purchase_target_stock_days'
        LIMIT 1
      ),
      60
    ) AS target_stock_days
),

-- ── Base: junta todos os CTEs antes dos cálculos derivados ───────────────────
base AS (
  SELECT
    p.id                                                            AS product_id,
    p.name                                                          AS product_name,
    p.sku,
    pv.id                                                           AS product_variation_id,
    pv.sku_variation,
    pv.color,
    pv.size,

    COALESCE(sc.current_qty, 0)                                     AS current_qty,
    COALESCE(s30.qty_sold_30d, 0)                                   AS qty_sold_30d,
    COALESCE(s90.qty_sold_90d, 0)                                   AS qty_sold_90d,

    -- Velocidade diária: prefere janela 30d (mais recente).
    -- Fallback: 90d / 3 (normaliza para o mesmo intervalo mensal).
    -- Sem histórico de venda → 0.000.
    ROUND(
      COALESCE(
        s30.qty_sold_30d,
        s90.qty_sold_90d::numeric / 3.0,
        0
      ) / 30.0,
    3)                                                              AS daily_velocity,

    COALESCE(lt.estimated_lead_time_days, 30)                       AS estimated_lead_time_days,

    rs.supplier_id                                                  AS recommended_supplier_id,
    rs.supplier_name                                                AS recommended_supplier_name,
    rs.avg_cost_per_unit                                            AS recommended_avg_cost_per_unit,

    -- Custo unitário para reposição: fornecedor recomendado → avg_cost atual → base_cost
    COALESCE(rs.avg_cost_per_unit, sc.weighted_avg_cost, p.base_cost) AS unit_cost_estimate,

    cfg.target_stock_days,

    p.margin_pct,
    COALESCE(pv.price_override, p.base_price)                       AS selling_price

  FROM public.products p
  JOIN public.product_variations pv
    ON pv.product_id = p.id AND pv.active = true
  CROSS JOIN config cfg
  LEFT JOIN stock_current        sc  ON sc.product_variation_id = pv.id
  LEFT JOIN sales_30d            s30 ON s30.product_variation_id = pv.id
  LEFT JOIN sales_90d            s90 ON s90.product_variation_id = pv.id
  LEFT JOIN lead_time_estimate   lt  ON lt.product_variation_id  = pv.id
  LEFT JOIN recommended_supplier rs  ON rs.product_variation_id  = pv.id
  WHERE p.active = true
)

-- ── Projeção final ────────────────────────────────────────────────────────────
SELECT
  product_id,
  product_name,
  sku,
  product_variation_id,
  sku_variation,
  color,
  size,

  current_qty,
  qty_sold_30d,
  qty_sold_90d,
  daily_velocity,
  estimated_lead_time_days,

  -- Cobertura em dias (NULL = sem histórico de venda)
  CASE
    WHEN daily_velocity = 0 THEN NULL
    ELSE ROUND(current_qty::numeric / daily_velocity)::int
  END                                                               AS coverage_days,

  -- Estoque mínimo de segurança = velocity × lead_time × fator 1.5
  CEIL(daily_velocity * estimated_lead_time_days * 1.5)::int        AS min_stock_suggested,

  -- Quantidade sugerida para compra = repor até target_stock_days de cobertura
  GREATEST(
    0,
    CEIL(daily_velocity * target_stock_days) - current_qty
  )::int                                                            AS suggested_purchase_qty,

  recommended_supplier_id,
  recommended_supplier_name,
  recommended_avg_cost_per_unit,

  -- Custo estimado da reposição
  ROUND(
    GREATEST(0, CEIL(daily_velocity * target_stock_days) - current_qty)
    * unit_cost_estimate
  , 2)                                                              AS estimated_restock_cost,

  -- Urgência baseada em cobertura vs lead_time
  -- CASE é short-circuit: divisão por daily_velocity só ocorre quando > 0
  CASE
    WHEN daily_velocity > 0 AND current_qty = 0
      THEN 'critica'
    WHEN daily_velocity > 0
      AND (current_qty::numeric / daily_velocity) < estimated_lead_time_days
      THEN 'alta'
    WHEN daily_velocity > 0
      AND (current_qty::numeric / daily_velocity) < estimated_lead_time_days * 2
      THEN 'media'
    ELSE 'baixa'
  END                                                               AS urgency,

  -- Classificadores de situação
  (daily_velocity > 0 AND current_qty = 0)                         AS is_rupture,
  (qty_sold_90d = 0 AND current_qty > 0)                           AS is_dead_stock,
  (daily_velocity > 0 AND current_qty > daily_velocity * 180)      AS is_overstock,

  target_stock_days,
  margin_pct,
  selling_price,
  unit_cost_estimate

FROM base;

GRANT SELECT ON public.vw_purchase_suggestions TO authenticated, service_role;

-- =============================================================================
-- Queries de validação (rodar após aplicar no Supabase):
--
-- 1. Sanidade: total de linhas
--    SELECT COUNT(*) FROM vw_purchase_suggestions;
--
-- 2. Parâmetro lido corretamente
--    SELECT DISTINCT target_stock_days FROM vw_purchase_suggestions;
--    → esperado: 60
--
-- 3. Distribuição de urgência
--    SELECT urgency, COUNT(*) AS total
--    FROM vw_purchase_suggestions
--    GROUP BY urgency ORDER BY urgency;
--
-- 4. Fornecedores recomendados (valida CTE recommended_supplier)
--    SELECT product_name, sku_variation, recommended_supplier_name,
--           recommended_avg_cost_per_unit
--    FROM vw_purchase_suggestions
--    WHERE recommended_supplier_id IS NOT NULL
--    LIMIT 10;
--
-- 5. Rupturas ativas
--    SELECT product_name, sku_variation, qty_sold_30d, urgency
--    FROM vw_purchase_suggestions
--    WHERE is_rupture = true
--    ORDER BY qty_sold_30d DESC;
--
-- 6. Top 20 por urgência (validação geral da ordenação)
--    SELECT product_name, sku_variation, current_qty, daily_velocity,
--           coverage_days, estimated_lead_time_days, min_stock_suggested,
--           suggested_purchase_qty, estimated_restock_cost,
--           recommended_supplier_name, urgency
--    FROM vw_purchase_suggestions
--    ORDER BY
--      CASE urgency WHEN 'critica' THEN 0 WHEN 'alta' THEN 1
--                   WHEN 'media'  THEN 2 ELSE 3 END,
--      coverage_days ASC NULLS LAST
--    LIMIT 20;
--
-- 7. Produtos parados e exagerados
--    SELECT COUNT(*) FILTER (WHERE is_dead_stock) AS dead_stock,
--           COUNT(*) FILTER (WHERE is_overstock)  AS overstock,
--           COUNT(*) FILTER (WHERE is_rupture)    AS rupture
--    FROM vw_purchase_suggestions;
--
-- 8. Custo total estimado de reposição (urgentes apenas)
--    SELECT SUM(estimated_restock_cost) AS total_restock_cost
--    FROM vw_purchase_suggestions
--    WHERE urgency IN ('critica', 'alta');
-- =============================================================================
