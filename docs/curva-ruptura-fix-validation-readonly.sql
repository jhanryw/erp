-- =============================================================================
-- curva-ruptura-fix-validation-readonly.sql
--
-- Validação das duas correções aplicadas:
--   202608101300_fix_mv_stock_status_stock_balances.sql
--   202608101400_fix_vw_purchase_suggestions_color_size.sql
--
-- 100% read-only. Nada aqui altera dados. Não executado nesta sessão —
-- sem acesso ao banco real (mesma limitação já registrada em toda esta
-- conversa). Rode manualmente após aplicar as duas migrations acima.
-- =============================================================================


-- =============================================================================
-- A. mv_stock_status — reconciliação contra stock_balances
-- =============================================================================

-- A.1 — 20 SKUs reais, comparação direta
WITH amostra AS (
  SELECT DISTINCT product_variation_id FROM public.stock_balances ORDER BY product_variation_id LIMIT 20
)
SELECT
  am.product_variation_id,
  ms.current_qty                                                     AS mv_stock_status_qty,
  sb.qty_stock_balances,
  (COALESCE(ms.current_qty, 0) - COALESCE(sb.qty_stock_balances, 0)) AS diferenca
FROM amostra am
LEFT JOIN public.mv_stock_status ms ON ms.product_variation_id = am.product_variation_id
LEFT JOIN (
  SELECT product_variation_id, SUM(quantity) AS qty_stock_balances
  FROM public.stock_balances GROUP BY product_variation_id
) sb ON sb.product_variation_id = am.product_variation_id
ORDER BY am.product_variation_id;
-- Esperado: diferenca = 0 em 100% das linhas.

-- A.2 — 10 SKUs criados DEPOIS de 10/06/2026 (o caso que a versão antiga
-- provavelmente não cobria, por não existirem na tabela `stock` congelada)
SELECT
  pv.id                    AS product_variation_id,
  pv.sku_variation,
  pv.created_at,
  ms.current_qty            AS mv_stock_status_qty,
  sb.qty_stock_balances
FROM public.product_variations pv
LEFT JOIN public.mv_stock_status ms ON ms.product_variation_id = pv.id
LEFT JOIN (
  SELECT product_variation_id, SUM(quantity) AS qty_stock_balances
  FROM public.stock_balances GROUP BY product_variation_id
) sb ON sb.product_variation_id = pv.id
WHERE pv.created_at > '2026-06-10'
ORDER BY pv.created_at
LIMIT 10;
-- Esperado: mv_stock_status_qty presente (não NULL) e igual a
-- qty_stock_balances para toda variação que tenha linha em stock_balances.


-- =============================================================================
-- B. vw_purchase_suggestions — cor/tamanho e ausência de regressão
-- =============================================================================

-- B.1 — 20 SKUs com atributo real cadastrado: view vs. fonte primária
WITH atributos_reais AS (
  SELECT
    pva.product_variation_id,
    MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS cor_real,
    MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS tamanho_real
  FROM public.product_variation_attributes pva
  JOIN public.variation_types  vt ON vt.id = pva.variation_type_id
  JOIN public.variation_values vv ON vv.id = pva.variation_value_id
  GROUP BY pva.product_variation_id
)
SELECT
  v.product_variation_id,
  v.sku_variation,
  v.color,
  v.size,
  ar.cor_real,
  ar.tamanho_real,
  (v.color IS DISTINCT FROM ar.cor_real)     AS cor_diverge,
  (v.size  IS DISTINCT FROM ar.tamanho_real) AS tamanho_diverge
FROM public.vw_purchase_suggestions v
JOIN atributos_reais ar ON ar.product_variation_id = v.product_variation_id
WHERE ar.cor_real IS NOT NULL OR ar.tamanho_real IS NOT NULL
ORDER BY v.product_variation_id
LIMIT 20;
-- Esperado: cor_diverge = false E tamanho_diverge = false em 100% das linhas.

-- B.1b — contagem geral (antes desta correção, as duas colunas abaixo eram 0)
SELECT
  COUNT(*)        AS total_linhas,
  COUNT(color)    AS com_cor,
  COUNT(size)     AS com_tamanho
FROM public.vw_purchase_suggestions;

-- B.2 — Sem regressão: current_qty, qty_sold_30d, daily_velocity, coverage_days,
-- suggested_purchase_qty continuam batendo com as mesmas fontes primárias de antes
SELECT
  v.product_variation_id,
  v.current_qty,
  sb.qty_real                                                        AS current_qty_esperado,
  v.qty_sold_30d,
  s30.qty_real_30d                                                   AS qty_sold_30d_esperado,
  v.daily_velocity,
  v.coverage_days,
  v.suggested_purchase_qty
FROM public.vw_purchase_suggestions v
LEFT JOIN (
  SELECT product_variation_id, SUM(quantity) AS qty_real
  FROM public.stock_balances GROUP BY product_variation_id
) sb ON sb.product_variation_id = v.product_variation_id
LEFT JOIN (
  SELECT si.product_variation_id, SUM(si.quantity) AS qty_real_30d
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.status NOT IN ('cancelled', 'returned')
    AND s.sale_date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY si.product_variation_id
) s30 ON s30.product_variation_id = v.product_variation_id
ORDER BY v.product_variation_id
LIMIT 20;
-- Esperado: v.current_qty = COALESCE(sb.qty_real, 0) e
-- v.qty_sold_30d = COALESCE(s30.qty_real_30d, 0) em 100% das linhas
-- (essas duas fontes não foram tocadas por nenhuma das duas correções).
