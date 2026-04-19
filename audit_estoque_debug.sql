-- =============================================================================
-- DEBUG DETALHADO DE DISCREPÂNCIAS DE ESTOQUE
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. LISTA INICIAL DE IMPORTS (por data)
-- Mostra tudo que foi importado no começo
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  'IMPORTAÇÃO INICIAL' AS fase,
  pv.sku_variation,
  p.name AS produto,
  sm.quantity AS unidades,
  sm.created_at AS data_importacao
FROM stock_movements sm
JOIN product_variations pv ON pv.id = sm.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE sm.type = 'initial'
ORDER BY sm.created_at, p.name;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. TODAS AS VENDAS COM QUANTIDADE
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  s.sale_number,
  s.status,
  s.sale_date,
  pv.sku_variation,
  p.name AS produto,
  si.quantity AS qtd_vendida,
  s.id AS sale_id
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE s.status IN ('paid', 'cancelled', 'returned')
ORDER BY s.sale_date, s.sale_number, pv.sku_variation;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RESUMO DE VENDAS POR SKU
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  pv.sku_variation,
  p.name AS produto,
  COUNT(DISTINCT si.sale_id) AS num_vendas,
  SUM(CASE WHEN s.status = 'paid' THEN si.quantity ELSE 0 END) AS qtd_vendas_pagas,
  SUM(CASE WHEN s.status = 'cancelled' THEN si.quantity ELSE 0 END) AS qtd_vendas_canceladas,
  SUM(CASE WHEN s.status = 'returned' THEN si.quantity ELSE 0 END) AS qtd_vendas_devolvidas,
  SUM(si.quantity) AS qtd_total_vendas
FROM sale_items si
JOIN sales s ON s.id = si.sale_id
JOIN product_variations pv ON pv.id = si.product_variation_id
JOIN products p ON p.id = pv.product_id
GROUP BY pv.id, pv.sku_variation, p.name
ORDER BY p.name, pv.sku_variation;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CRONOLOGIA COMPLETA DE MOVIMENTOS (para um SKU)
-- Descomente a linha WHERE e coloque a SKU
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  sm.id,
  sm.created_at,
  sm.type,
  CASE sm.type
    WHEN 'initial' THEN '📥 Importação'
    WHEN 'entry' THEN '📦 Entrada'
    WHEN 'sale' THEN '💰 Venda'
    WHEN 'return' THEN '↩️ Devolução'
    WHEN 'adjust' THEN '⚙️ Ajuste'
    ELSE sm.type
  END AS tipo_legivel,
  sm.quantity AS qtd,
  sm.previous_stock AS estoque_antes,
  sm.new_stock AS estoque_depois,
  sm.reference_id
FROM stock_movements sm
JOIN product_variations pv ON pv.id = sm.product_variation_id
-- WHERE pv.sku_variation = 'COLOCA_SKU_AQUI'  ← DESCOMENTE E EDITE
ORDER BY sm.created_at;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. VERIFICAÇÃO: VENDA PAGA TEM MOVIMENTO 'sale'?
-- Se não tiver, é uma discrepância
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  s.sale_number,
  si.product_variation_id,
  pv.sku_variation,
  si.quantity AS qtd_venda,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM stock_movements sm
      WHERE sm.reference_id = s.id::text
        AND sm.product_variation_id = si.product_variation_id
        AND sm.type = 'sale'
    ) THEN '✅ Movimento existe'
    ELSE '❌ MOVIMENTO FALTANDO'
  END AS status_movimento
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
WHERE s.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.product_variation_id = si.product_variation_id
      AND sm.type = 'sale'
  )
ORDER BY s.sale_date DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CANCELAMENTOS/DEVOLUÇÕES: ESTOQUE FOI RESTAURADO MAS SEM MOVIMENTO?
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  s.sale_number,
  s.status,
  pv.sku_variation,
  p.name,
  si.quantity AS qtd,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM stock_movements sm
      WHERE sm.reference_id = s.id::text
        AND sm.product_variation_id = si.product_variation_id
        AND sm.type IN ('return', 'adjust')
    ) THEN '✅ Movimento retorno existe'
    ELSE '⚠️ ESTOQUE RESTAURADO MAS SEM MOVIMENTO REGISTRADO'
  END AS status
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE s.status IN ('cancelled', 'returned')
ORDER BY s.sale_date DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. STOCK_MOVEMENTS com referência quebrada (reference_id aponta pra nada)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  sm.id,
  sm.type,
  sm.product_variation_id,
  pv.sku_variation,
  sm.quantity,
  sm.reference_id,
  sm.created_at
FROM stock_movements sm
JOIN product_variations pv ON pv.id = sm.product_variation_id
WHERE sm.type = 'sale' AND sm.reference_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.id::text = sm.reference_id
  )
ORDER BY sm.created_at;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. DIAGRAMA: ESTOQUE POR VARIAÇÃO (antes e depois)
-- ─────────────────────────────────────────────────────────────────────────────
WITH primeira_mov AS (
  SELECT
    product_variation_id,
    previous_stock AS estoque_antes_primeiro_mov
  FROM stock_movements
  WHERE id = (
    SELECT MIN(id) FROM stock_movements sm2
    WHERE sm2.product_variation_id = stock_movements.product_variation_id
  )
),
ultima_mov AS (
  SELECT
    product_variation_id,
    new_stock AS estoque_apos_ultimo_mov
  FROM stock_movements
  WHERE id = (
    SELECT MAX(id) FROM stock_movements sm2
    WHERE sm2.product_variation_id = stock_movements.product_variation_id
  )
)
SELECT
  pv.sku_variation,
  p.name,
  COALESCE(pm.estoque_antes_primeiro_mov, 0) AS estoque_antes_ops,
  COALESCE(um.estoque_apos_ultimo_mov, 0) AS estoque_esperado_final,
  COALESCE(s.quantity, 0) AS estoque_atual,
  COALESCE(s.quantity, 0) - COALESCE(um.estoque_apos_ultimo_mov, 0) AS diferenca
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN primeira_mov pm ON pm.product_variation_id = pv.id
LEFT JOIN ultima_mov um ON um.product_variation_id = pv.id
LEFT JOIN stock s ON s.product_variation_id = pv.id
ORDER BY ABS(COALESCE(s.quantity, 0) - COALESCE(um.estoque_apos_ultimo_mov, 0)) DESC;
