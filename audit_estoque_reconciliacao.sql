-- =============================================================================
-- AUDITORIA: RECONCILIAÇÃO ESTOQUE INICIAL vs ESTOQUE ATUAL
--
-- Fórmula:
-- ESTOQUE_ESPERADO = INICIAL + ENTRADAS - VENDAS + DEVOLUCOES + AJUSTES
--
-- Se ESTOQUE_ESPERADO ≠ ESTOQUE_ATUAL → há discrepância
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- RESUMO GLOBAL
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  SUM(CASE WHEN type = 'initial' THEN quantity ELSE 0 END) AS total_importacao,
  SUM(CASE WHEN type = 'entry'   THEN quantity ELSE 0 END) AS total_entradas_apos,
  SUM(CASE WHEN type = 'sale'    THEN ABS(quantity) ELSE 0 END) AS total_vendas,
  SUM(CASE WHEN type = 'return'  THEN quantity ELSE 0 END) AS total_devolucoes,
  SUM(CASE WHEN type = 'adjust'  THEN quantity ELSE 0 END) AS total_ajustes,
  SUM(quantity) AS total_net_movimentos
FROM stock_movements;

-- ─────────────────────────────────────────────────────────────────────────────
-- RECONCILIAÇÃO POR SKU — ENCONTRA DISCREPÂNCIAS
--
-- A coluna 'diferenca' deve ser ZERO para todos os SKUs
-- Se não for zero, é onde está o erro
-- ─────────────────────────────────────────────────────────────────────────────
WITH mov_resumo AS (
  SELECT
    product_variation_id,
    SUM(CASE WHEN type = 'initial' THEN quantity ELSE 0 END) AS inicial,
    SUM(CASE WHEN type = 'entry'   THEN quantity ELSE 0 END) AS entradas,
    SUM(CASE WHEN type = 'sale'    THEN quantity ELSE 0 END) AS vendas,
    SUM(CASE WHEN type = 'return'  THEN quantity ELSE 0 END) AS devolucoes,
    SUM(CASE WHEN type = 'adjust'  THEN quantity ELSE 0 END) AS ajustes,
    SUM(quantity) AS total
  FROM stock_movements
  GROUP BY product_variation_id
)
SELECT
  pv.sku_variation,
  p.name AS produto,
  COALESCE(m.inicial, 0) AS importado,
  COALESCE(m.entradas, 0) AS entradas_pos_importacao,
  COALESCE(ABS(m.vendas), 0) AS vendido,
  COALESCE(m.devolucoes, 0) AS devolvido,
  COALESCE(m.ajustes, 0) AS ajustes,
  -- Cálculo esperado
  (COALESCE(m.inicial, 0)
   + COALESCE(m.entradas, 0)
   - COALESCE(ABS(m.vendas), 0)
   + COALESCE(m.devolucoes, 0)
   + COALESCE(m.ajustes, 0)) AS estoque_esperado,
  -- Estoque atual
  COALESCE(s.quantity, 0) AS estoque_atual,
  -- A DISCREPÂNCIA
  COALESCE(s.quantity, 0)
    - (COALESCE(m.inicial, 0)
       + COALESCE(m.entradas, 0)
       - COALESCE(ABS(m.vendas), 0)
       + COALESCE(m.devolucoes, 0)
       + COALESCE(m.ajustes, 0)) AS diferenca,
  -- Status
  CASE
    WHEN COALESCE(s.quantity, 0) =
         (COALESCE(m.inicial, 0)
          + COALESCE(m.entradas, 0)
          - COALESCE(ABS(m.vendas), 0)
          + COALESCE(m.devolucoes, 0)
          + COALESCE(m.ajustes, 0))
    THEN '✅ OK'
    ELSE '❌ ERRO'
  END AS status
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock s ON s.product_variation_id = pv.id
LEFT JOIN mov_resumo m ON m.product_variation_id = pv.id
ORDER BY status DESC, p.name, pv.sku_variation;


-- ─────────────────────────────────────────────────────────────────────────────
-- APENAS OS COM ERRO (diferença <> 0)
-- ─────────────────────────────────────────────────────────────────────────────
WITH mov_resumo AS (
  SELECT
    product_variation_id,
    SUM(CASE WHEN type = 'initial' THEN quantity ELSE 0 END) AS inicial,
    SUM(CASE WHEN type = 'entry'   THEN quantity ELSE 0 END) AS entradas,
    SUM(CASE WHEN type = 'sale'    THEN quantity ELSE 0 END) AS vendas,
    SUM(CASE WHEN type = 'return'  THEN quantity ELSE 0 END) AS devolucoes,
    SUM(CASE WHEN type = 'adjust'  THEN quantity ELSE 0 END) AS ajustes
  FROM stock_movements
  GROUP BY product_variation_id
)
SELECT
  pv.id,
  pv.sku_variation,
  p.name AS produto,
  COALESCE(m.inicial, 0) AS importado,
  COALESCE(m.entradas, 0) AS entradas,
  COALESCE(ABS(m.vendas), 0) AS vendido,
  COALESCE(m.devolucoes, 0) AS devolvido,
  COALESCE(m.ajustes, 0) AS ajustes,
  (COALESCE(m.inicial, 0)
   + COALESCE(m.entradas, 0)
   - COALESCE(ABS(m.vendas), 0)
   + COALESCE(m.devolucoes, 0)
   + COALESCE(m.ajustes, 0)) AS esperado,
  COALESCE(s.quantity, 0) AS atual,
  COALESCE(s.quantity, 0)
    - (COALESCE(m.inicial, 0)
       + COALESCE(m.entradas, 0)
       - COALESCE(ABS(m.vendas), 0)
       + COALESCE(m.devolucoes, 0)
       + COALESCE(m.ajustes, 0)) AS diferenca
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock s ON s.product_variation_id = pv.id
LEFT JOIN mov_resumo m ON m.product_variation_id = pv.id
WHERE COALESCE(s.quantity, 0)
    <> (COALESCE(m.inicial, 0)
        + COALESCE(m.entradas, 0)
        - COALESCE(ABS(m.vendas), 0)
        + COALESCE(m.devolucoes, 0)
        + COALESCE(m.ajustes, 0))
ORDER BY ABS(COALESCE(s.quantity, 0)
    - (COALESCE(m.inicial, 0)
       + COALESCE(m.entradas, 0)
       - COALESCE(ABS(m.vendas), 0)
       + COALESCE(m.devolucoes, 0)
       + COALESCE(m.ajustes, 0))) DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- HISTÓRICO DE MOVIMENTOS POR SKU (para debug)
-- Descomente a SKU que precisa investigar
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  sm.id,
  pv.sku_variation,
  sm.type,
  sm.quantity,
  sm.previous_stock,
  sm.new_stock,
  sm.reference_id,
  sm.notes,
  sm.created_at
FROM stock_movements sm
JOIN product_variations pv ON pv.id = sm.product_variation_id
WHERE pv.sku_variation = 'COLOCA_SKU_AQUI'  -- ← EDITE COM A SKU QUE TEM ERRO
ORDER BY sm.created_at;
