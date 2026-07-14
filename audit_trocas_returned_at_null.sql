-- =============================================================================
-- AUDITORIA — vendas totalmente trocadas sem returned_at/returned_by
--
-- Somente leitura. Roda antes de qualquer backfill (ver
-- supabase/migrations/20260727_backfill_returned_at_trocas_totais.sql).
--
-- Objetivo: encontrar vendas que:
--   (a) estão com status = 'returned';
--   (b) essa devolução foi causada por uma troca ter atingido 100% dos itens
--       vendidos (SUM(exchange_items.quantity_returned) de trocas 'completed'
--       >= SUM(sale_items.quantity)) — exatamente a condição que
--       rpc_process_exchange usa para decidir marcar a venda como devolvida;
--   (c) returned_at está NULL — ou seja, a marcação aconteceu antes da
--       correção em 20260726_fix_rpc_process_exchange_guards.sql (a versão
--       vigente até então, de 20260626_fix_exchange_stock_balances.sql,
--       nunca preenchia essa coluna).
--
-- NÃO FOI EXECUTADO em produção nesta sessão — não há acesso ao banco de
-- produção neste ambiente (Supabase MCP não autorizado, .env.local aponta
-- para um Supabase local/dummy). Rode isto primeiro e confira a contagem e
-- a lista antes de aplicar o backfill.
-- =============================================================================

WITH exchange_progress AS (
  SELECT
    ex.original_sale_id AS sale_id,
    SUM(ei.quantity_returned) AS total_exchanged
  FROM public.exchanges ex
  JOIN public.exchange_items ei ON ei.exchange_id = ex.id
  WHERE ex.status = 'completed'
  GROUP BY ex.original_sale_id
),
sale_totals AS (
  SELECT sale_id, SUM(quantity) AS total_sold
  FROM public.sale_items
  GROUP BY sale_id
),
fully_exchanged_sales AS (
  SELECT ep.sale_id
  FROM exchange_progress ep
  JOIN sale_totals st ON st.sale_id = ep.sale_id
  WHERE ep.total_exchanged >= st.total_sold
),
last_completing_exchange AS (
  SELECT DISTINCT ON (ex.original_sale_id)
    ex.original_sale_id AS sale_id,
    ex.id                AS exchange_id,
    ex.created_at        AS completion_at,
    ex.created_by        AS completion_by
  FROM public.exchanges ex
  WHERE ex.status = 'completed'
    AND ex.original_sale_id IN (SELECT sale_id FROM fully_exchanged_sales)
  ORDER BY ex.original_sale_id, ex.created_at DESC
)
SELECT
  s.id,
  s.company_id,
  s.sale_number,
  s.status,
  s.sale_date,
  s.total,
  s.returned_at,
  s.returned_by,
  lce.exchange_id   AS would_use_exchange_id,
  lce.completion_at AS would_set_returned_at,
  lce.completion_by AS would_set_returned_by
FROM public.sales s
JOIN last_completing_exchange lce ON lce.sale_id = s.id
WHERE s.status = 'returned'
  AND s.returned_at IS NULL
ORDER BY s.id;

-- Contagem isolada, para conferência rápida:
-- SELECT COUNT(*) FROM (
--   <mesma query acima sem os campos would_*>
-- ) x;
