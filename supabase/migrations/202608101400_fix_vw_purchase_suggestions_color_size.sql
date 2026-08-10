-- =============================================================================
-- 202608101400_fix_vw_purchase_suggestions_color_size.sql
--
-- CORREÇÃO CONFIRMADA CONTRA O BANCO REAL — vw_purchase_suggestions.color
-- e .size existem como colunas de saída (confirmado via
-- information_schema.columns: data_type text), mas retornam NULL em
-- 100% da amostra real de 20 linhas testada, mesmo para produtos cuja
-- cor está no próprio nome (ex.: "Sutiã V Preto", "Body Rendado
-- Vermelho"). A view original ([20260615_vw_purchase_suggestions.sql])
-- selecionava pv.color/pv.size diretamente — o dado real de cor/tamanho
-- não vive em colunas de product_variations, vive em
-- product_variation_attributes + variation_types + variation_values,
-- exatamente como já corrigido em vw_stock_live
-- (20260612_fix_vw_stock_live_balances.sql, comentário: "Mantém
-- cor/tamanho via product_variation_attributes (não pv.color/pv.size,
-- que não existem no schema real)").
--
-- O QUE MUDA: só a origem de `color` e `size` — troca de pv.color/pv.size
-- por uma nova CTE (variation_attributes) que agrega
-- product_variation_attributes por slug ('cor'/'tamanho'), no mesmo
-- padrão MAX(...) FILTER já validado em vw_stock_live. `color`/`size`
-- continuam com o mesmo nome, mesma posição, mesmo tipo (text) na saída
-- pública da view.
--
-- O QUE NÃO MUDA (verificado linha a linha contra o arquivo original):
--   - stock_current, sales_30d, sales_90d, lead_time_estimate,
--     recommended_supplier, config: nenhuma dessas CTEs foi tocada.
--   - daily_velocity, coverage_days, min_stock_suggested,
--     suggested_purchase_qty, estimated_lead_time_days, urgency,
--     is_rupture, is_dead_stock, is_overstock, recommended_supplier_*,
--     unit_cost_estimate, estimated_restock_cost, margin_pct,
--     selling_price, target_stock_days: fórmulas e fontes idênticas.
--   - current_qty, qty_sold_30d, qty_sold_90d: já vinham corretos de
--     stock_balances/sale_items antes desta correção — não tocados.
--   - Bloco de queries de validação em comentário ao final: preservado.
--
-- CONSUMERS CONFIRMADOS antes desta migration (mesmo contrato,
-- select * ou colunas nominais — nenhum precisa mudar):
--   src/app/(dashboard)/inteligencia/compras/page.tsx:14
--   src/app/(dashboard)/inteligencia/compras/pedido/page.tsx:21
--   src/app/(dashboard)/inteligencia/compras/_components/compras-table.tsx
--     (PurchaseSuggestion.color / .size: string | null — contrato preservado)
--
-- CREATE OR REPLACE VIEW (não DROP+CREATE): válido aqui porque a lista de
-- colunas de saída, nomes, tipos e ordem são idênticos ao original —
-- Postgres permite OR REPLACE nessas condições e preserva GRANTs
-- existentes automaticamente (sem necessidade de novo GRANT).
--
-- ROLLBACK: ver bloco comentado ao final (recria a versão anterior, com
-- pv.color/pv.size).
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

-- ── Cor/Tamanho reais — schema de atributos (correção desta migration) ───────
-- Mesmo padrão já validado em vw_stock_live: product_variation_attributes
-- + variation_types (slug) + variation_values (value), agregados por
-- variação com MAX(...) FILTER para não fazer fan-out.
variation_attributes AS (
  SELECT
    pva.product_variation_id,
    MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS color,
    MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS size
  FROM public.product_variation_attributes pva
  JOIN public.variation_types  vt ON vt.id = pva.variation_type_id
  JOIN public.variation_values vv ON vv.id = pva.variation_value_id
  GROUP BY pva.product_variation_id
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
    va.color,
    va.size,

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
  LEFT JOIN variation_attributes va  ON va.product_variation_id  = pv.id
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
--
-- 9. (NOVO nesta correção) Cor/tamanho realmente preenchidos
--    SELECT COUNT(*) AS total,
--           COUNT(color) AS com_cor,
--           COUNT(size)  AS com_tamanho
--    FROM vw_purchase_suggestions;
--    → esperado: com_cor/com_tamanho > 0 (antes desta correção, ambos eram 0)
-- =============================================================================

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplicar o CREATE OR REPLACE VIEW de 20260615_vw_purchase_suggestions.sql
-- na íntegra (troca va.color/va.size de volta para pv.color/pv.size,
-- remove a CTE variation_attributes e o LEFT JOIN correspondente).
*/
