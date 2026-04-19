-- =============================================================================
-- CORREÇÃO DE DISCREPÂNCIAS DE ESTOQUE
--
-- ⚠️  EXECUTE PRIMEIRO A AUDITORIA PARA ENTENDER OS PROBLEMAS
-- ⚠️  FAÇA BACKUP ANTES DE EXECUTAR ESTAS CORREÇÕES
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- CORREÇÃO 1: ADICIONAR MOVIMENTOS 'return' PARA VENDAS CANCELADAS/DEVOLVIDAS
--
-- Problema identificado: funções rpc_cancel_sale e rpc_return_sale não registram
-- stock_movements do tipo 'return', causando discrepância stock vs movimentos.
--
-- Solução: Registrar retroativamente os movimentos faltantes.
-- ─────────────────────────────────────────────────────────────────────────────

-- Primeiro, visualize o que será corrigido (não modifica nada):
SELECT
  s.id,
  s.sale_number,
  s.status,
  si.product_variation_id,
  pv.sku_variation,
  si.quantity,
  s.updated_at
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
WHERE s.status IN ('cancelled', 'returned')
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.product_variation_id = si.product_variation_id
      AND sm.type = 'return'
  )
ORDER BY s.updated_at DESC;


-- Agora, executar a correção (descomente para executar):
/*
INSERT INTO stock_movements (
  product_variation_id, type, quantity, previous_stock, new_stock,
  reference_id, notes, created_at
)
SELECT
  si.product_variation_id,
  'return' AS type,
  si.quantity AS quantity,
  (SELECT quantity FROM stock WHERE product_variation_id = si.product_variation_id) - si.quantity AS previous_stock,
  (SELECT quantity FROM stock WHERE product_variation_id = si.product_variation_id) AS new_stock,
  s.id::text AS reference_id,
  'Devolução/Cancelamento: ' || s.sale_number AS notes,
  s.updated_at AS created_at
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
WHERE s.status IN ('cancelled', 'returned')
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.product_variation_id = si.product_variation_id
      AND sm.type = 'return'
  )
ON CONFLICT DO NOTHING;
*/


-- ─────────────────────────────────────────────────────────────────────────────
-- CORREÇÃO 2: REAJUSTAR ESTOQUE PARA VALORES ESPERADOS
--
-- Se uma SKU foi calculada como 0 mas deveria ser X (por movimentos),
-- aplicar ajuste manual
--
-- ⚠️  CUIDADO: Use apenas se TIVER CERTEZA da discrepância
-- ─────────────────────────────────────────────────────────────────────────────

-- Visualizar o que seria ajustado:
WITH mov_resumo AS (
  SELECT
    product_variation_id,
    SUM(quantity) AS saldo_esperado
  FROM stock_movements
  GROUP BY product_variation_id
)
SELECT
  pv.id,
  pv.sku_variation,
  p.name,
  COALESCE(m.saldo_esperado, 0) AS esperado,
  COALESCE(s.quantity, 0) AS atual,
  COALESCE(m.saldo_esperado, 0) - COALESCE(s.quantity, 0) AS delta_ajuste
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock s ON s.product_variation_id = pv.id
LEFT JOIN mov_resumo m ON m.product_variation_id = pv.id
WHERE COALESCE(s.quantity, 0) <> COALESCE(m.saldo_esperado, 0)
ORDER BY ABS(COALESCE(m.saldo_esperado, 0) - COALESCE(s.quantity, 0)) DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- CORREÇÃO 3: FIX PARA MOVIMENTOS COM PREVIOUS_STOCK <> NEW_STOCK ANTERIOR
--
-- Se a cadeia de movimentos ficou quebrada, detectar onde
-- ─────────────────────────────────────────────────────────────────────────────

-- Diagnóstico (não modifica):
WITH mov_sequencia AS (
  SELECT
    product_variation_id,
    id,
    LAG(new_stock) OVER (
      PARTITION BY product_variation_id
      ORDER BY created_at, id
    ) AS new_stock_anterior,
    previous_stock,
    quantity,
    new_stock,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY product_variation_id
      ORDER BY created_at, id
    ) AS seq
  FROM stock_movements
)
SELECT
  product_variation_id,
  seq,
  new_stock_anterior,
  previous_stock,
  CASE
    WHEN seq = 1 THEN 'Primeira (OK se new_stock_anterior IS NULL)'
    WHEN new_stock_anterior <> previous_stock
    THEN '❌ QUEBRA AQUI: anterior terminou em ' || new_stock_anterior || ' mas essa começou em ' || previous_stock
    ELSE '✅ OK'
  END AS status,
  quantity,
  new_stock,
  created_at
FROM mov_sequencia
WHERE new_stock_anterior IS NOT NULL AND new_stock_anterior <> previous_stock
ORDER BY product_variation_id, seq;


-- ─────────────────────────────────────────────────────────────────────────────
-- COMANDO AUXILIAR: LIMPAR MOVIMENTOS DUPLICADOS (se existirem)
-- ─────────────────────────────────────────────────────────────────────────────

-- Encontrar duplicados:
SELECT
  reference_id,
  product_variation_id,
  type,
  COUNT(*) as vezes
FROM stock_movements
WHERE reference_id IS NOT NULL
GROUP BY reference_id, product_variation_id, type
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC;

-- Deletar apenas se TIVER CERTEZA (descomente):
/*
DELETE FROM stock_movements
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY reference_id, product_variation_id, type
        ORDER BY created_at DESC
      ) as rn
    FROM stock_movements
    WHERE reference_id IS NOT NULL
  ) t
  WHERE rn > 1
);
*/


-- ─────────────────────────────────────────────────────────────────────────────
-- VALIDAÇÃO FINAL: Depois de aplicar as correções, rodar esta query
-- ─────────────────────────────────────────────────────────────────────────────

SELECT
  '🔍 PÓS-CORREÇÃO' as fase,
  COUNT(*) AS total_skus,
  SUM(CASE WHEN diff = 0 THEN 1 ELSE 0 END) AS skus_ok,
  SUM(CASE WHEN diff <> 0 THEN 1 ELSE 0 END) AS skus_com_erro,
  MAX(ABS(diff)) AS maior_discrepancia
FROM (
  WITH mov_resumo AS (
    SELECT
      product_variation_id,
      SUM(quantity) AS total
    FROM stock_movements
    GROUP BY product_variation_id
  )
  SELECT
    s.product_variation_id,
    COALESCE(s.quantity, 0) - COALESCE(m.total, 0) AS diff
  FROM stock s
  LEFT JOIN mov_resumo m ON m.product_variation_id = s.product_variation_id
) resultado;
