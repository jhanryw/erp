-- =============================================================================
-- AUDITORIA DOS 26 SKUs COM DISCREPÂNCIA
--
-- Identifica exatamente ONDE está o erro de cada SKU:
-- A) Cancel/devolução sem movimento de retorno (causa mais provável)
-- B) Venda paga sem movimento de saída
-- C) Diferença inexplicável (sem causa conhecida)
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 1: QUAIS SÃO OS 26 SKUs COM ERRO + QUAL O TIPO DE CAUSA
-- ─────────────────────────────────────────────────────────────────────────────
WITH mov_resumo AS (
  SELECT
    product_variation_id,
    SUM(quantity)                                                       AS total_movimentos,
    SUM(CASE WHEN type = 'initial' THEN quantity ELSE 0 END)            AS inicial,
    SUM(CASE WHEN type = 'entry'   THEN quantity ELSE 0 END)            AS entradas,
    SUM(CASE WHEN type = 'sale'    THEN quantity ELSE 0 END)            AS saidas_venda,
    SUM(CASE WHEN type = 'return'  THEN quantity ELSE 0 END)            AS retornos,
    SUM(CASE WHEN type = 'adjust'  THEN quantity ELSE 0 END)            AS ajustes
  FROM stock_movements
  GROUP BY product_variation_id
),
cancel_sem_mov AS (
  -- Vendas canceladas/devolvidas cujo retorno de estoque não tem movimento
  SELECT
    si.product_variation_id,
    SUM(si.quantity) AS qtd_retorno_faltando
  FROM sales s
  JOIN sale_items si ON si.sale_id = s.id
  WHERE s.status IN ('cancelled', 'returned')
    AND NOT EXISTS (
      SELECT 1 FROM stock_movements sm
      WHERE sm.reference_id = s.id::text
        AND sm.product_variation_id = si.product_variation_id
        AND sm.type = 'return'
    )
  GROUP BY si.product_variation_id
),
venda_sem_mov AS (
  -- Vendas pagas sem movimento de saída
  SELECT
    si.product_variation_id,
    SUM(si.quantity) AS qtd_venda_faltando
  FROM sales s
  JOIN sale_items si ON si.sale_id = s.id
  WHERE s.status = 'paid'
    AND NOT EXISTS (
      SELECT 1 FROM stock_movements sm
      WHERE sm.reference_id = s.id::text
        AND sm.product_variation_id = si.product_variation_id
        AND sm.type = 'sale'
    )
  GROUP BY si.product_variation_id
)
SELECT
  pv.id AS variation_id,
  pv.sku_variation,
  p.name AS produto,
  COALESCE(s.quantity, 0)          AS estoque_atual,
  COALESCE(m.total_movimentos, 0)  AS soma_movimentos,
  COALESCE(s.quantity, 0) - COALESCE(m.total_movimentos, 0) AS diferenca,

  -- Componentes do histórico
  COALESCE(m.inicial, 0)           AS inicial,
  COALESCE(m.entradas, 0)          AS entradas,
  ABS(COALESCE(m.saidas_venda, 0)) AS saidas_vendas,
  COALESCE(m.retornos, 0)          AS retornos_registrados,
  COALESCE(m.ajustes, 0)           AS ajustes,

  -- Causas prováveis
  COALESCE(c.qtd_retorno_faltando, 0) AS retorno_sem_movimento,
  COALESCE(v.qtd_venda_faltando, 0)   AS venda_sem_movimento,

  CASE
    WHEN COALESCE(c.qtd_retorno_faltando, 0) > 0
     AND ABS(COALESCE(s.quantity, 0) - COALESCE(m.total_movimentos, 0))
         = COALESCE(c.qtd_retorno_faltando, 0)
      THEN 'CAUSA: Cancel/dev sem movimento (migration 033 bug)'
    WHEN COALESCE(v.qtd_venda_faltando, 0) > 0
      THEN 'CAUSA: Venda paga sem movimento de saida'
    WHEN COALESCE(c.qtd_retorno_faltando, 0) > 0
      THEN 'CAUSA PARCIAL: Cancel/dev sem movimento'
    ELSE 'CAUSA DESCONHECIDA — investigar manualmente'
  END AS diagnostico

FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p             ON p.id  = pv.product_id
LEFT JOIN mov_resumo m      ON m.product_variation_id = s.product_variation_id
LEFT JOIN cancel_sem_mov c  ON c.product_variation_id = s.product_variation_id
LEFT JOIN venda_sem_mov v   ON v.product_variation_id = s.product_variation_id
WHERE COALESCE(s.quantity, 0) <> COALESCE(m.total_movimentos, 0)
ORDER BY ABS(COALESCE(s.quantity, 0) - COALESCE(m.total_movimentos, 0)) DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 2: LISTAR TODAS AS VENDAS CANCELADAS/DEVOLVIDAS SEM MOVIMENTO
-- (a causa mais provável dos 26 erros — bug da migration 033)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  s.id          AS sale_id,
  s.sale_number,
  s.status,
  s.sale_date,
  pv.id         AS variation_id,
  pv.sku_variation,
  p.name        AS produto,
  si.quantity   AS qtd_a_retornar,
  si.unit_cost  AS custo_unitario
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE s.status IN ('cancelled', 'returned')
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.product_variation_id = si.product_variation_id
      AND sm.type = 'return'
  )
ORDER BY s.sale_date, s.sale_number;


-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 3: CORREÇÃO — INSERIR OS MOVIMENTOS 'return' FALTANTES
--
-- Esta query insere um stock_movement type='return' retroativamente para cada
-- cancelamento/devolução que não gerou movimento.
--
-- O previous_stock e new_stock são aproximados (baseados no estoque atual
-- porque não temos como saber o saldo exato no momento do cancelamento).
-- Isso é aceitável pois o objetivo é reconciliar o saldo total, não o histórico perfeito.
--
-- ⚠️  Rode PASSO 2 primeiro e verifique as linhas antes de executar isso
-- ⚠️  Execute SOMENTE se o diagnóstico do PASSO 1 confirmar essa causa
-- =============================================================================
/*
INSERT INTO stock_movements (
  product_variation_id,
  product_id,
  type,
  quantity,
  previous_stock,
  new_stock,
  unit_cost,
  reference_id,
  created_at
)
SELECT
  si.product_variation_id,
  pv.product_id,
  'return'                          AS type,
  si.quantity                       AS quantity,
  -- approximação: estoque atual - quantidade retornada = estoque antes do retorno
  COALESCE(st.quantity, 0) - si.quantity AS previous_stock,
  COALESCE(st.quantity, 0)          AS new_stock,
  si.unit_cost                      AS unit_cost,
  s.id::text                        AS reference_id,
  s.updated_at                      AS created_at
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
JOIN product_variations pv ON pv.id = si.product_variation_id
JOIN stock st ON st.product_variation_id = si.product_variation_id
WHERE s.status IN ('cancelled', 'returned')
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.product_variation_id = si.product_variation_id
      AND sm.type = 'return'
  );
*/


-- ─────────────────────────────────────────────────────────────────────────────
-- PASSO 4: VERIFICAÇÃO FINAL — Quantos ainda têm erro depois da correção
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  SUM(CASE WHEN diff = 0 THEN 1 ELSE 0 END) AS skus_ok,
  SUM(CASE WHEN diff <> 0 THEN 1 ELSE 0 END) AS skus_com_erro_restantes,
  MAX(ABS(diff)) AS maior_discrepancia_restante
FROM (
  WITH mov_resumo AS (
    SELECT product_variation_id, SUM(quantity) AS total
    FROM stock_movements
    GROUP BY product_variation_id
  )
  SELECT
    s.product_variation_id,
    COALESCE(s.quantity, 0) - COALESCE(m.total, 0) AS diff
  FROM stock s
  LEFT JOIN mov_resumo m ON m.product_variation_id = s.product_variation_id
) t;
