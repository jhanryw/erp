-- =============================================================================
-- 20260727_backfill_returned_at_trocas_totais.sql
--
-- ⚠️  NÃO EXECUTADO em produção nesta sessão. Preparado para revisão — rode
--     antes `audit_trocas_returned_at_null.sql` (raiz do repo) em produção e
--     confirme a contagem/lista antes de aplicar esta migration. Sem acesso
--     a produção (Supabase MCP não autorizado neste ambiente), não há como
--     confirmar aqui quantas vendas — se alguma — são afetadas.
--
-- CONTEXTO: até 20260726_fix_rpc_process_exchange_guards.sql, uma troca que
--   devolvia 100% dos itens de uma venda marcava sales.status = 'returned'
--   sem preencher returned_at/returned_by. vw_dre_mensal (v3, ver
--   20260724_vw_dre_mensal_v3_revenue_reversal.sql) só reverte receita de
--   vendas 'returned' com returned_at IS NOT NULL — essas vendas ficam com
--   receita bruta lançada permanentemente, mesmo devolvidas.
--
-- Este backfill é o equivalente, para o caminho de troca, do que
-- 20260723_backfill_historico_cancelled_returned_at.sql já fez para
-- devoluções via finance_entries/exchanges pré-20260722.
--
-- FONTE DA DATA — prioridade e por quê:
--   1. exchanges.completed_at — NÃO EXISTE. A tabela `exchanges` (criada em
--      20260609_exchanges.sql) nunca teve essa coluna; conferido em todas as
--      migrations que tocam `public.exchanges` (nenhum ADD COLUMN
--      completed_at/updated_at foi encontrado).
--   2. exchanges.updated_at — NÃO EXISTE, pelo mesmo motivo.
--   3. exchanges.created_at — ÚNICA coluna de timestamp disponível na tabela.
--      Como a linha em `exchanges` é criada dentro da mesma transação da RPC
--      que, no mesmo instante, decide se a venda atingiu 100% de troca e
--      atualiza sales.status, created_at da troca que completou o total é
--      exatamente o instante em que sales.status virou 'returned'. Não há
--      diferença de tempo entre os dois eventos na versão corrigida da RPC
--      (mesma transação) nem na versão antiga (mesma instrução SQL,
--      NOW() avaliado uma vez por transação) — logo created_at é uma fonte
--      exata, não uma aproximação.
--
-- Qual troca usar quando há múltiplas (trocas parciais cumulativas até
-- 100%): a de created_at mais recente entre as 'completed' daquela venda —
-- é ela quem, na soma cumulativa, cruzou o total vendido e disparou o
-- UPDATE sales SET status='returned' dentro da RPC.
--
-- SALVAGUARDA: só atualiza vendas onde SUM(exchange_items.quantity_returned)
--   de trocas completed >= SUM(sale_items.quantity) — a mesma condição que
--   rpc_process_exchange usa para decidir marcar a venda como devolvida.
--   Isso evita atribuir returned_at de uma troca a uma venda cujo status
--   'returned' veio de rpc_return_sale (devolução direta, sem relação com
--   troca) e que só por coincidência também tem alguma troca parcial
--   registrada.
--
-- NÃO usa NOW() em nenhum ponto — a data de competência histórica do DRE
-- não pode ser distorcida por quando este backfill roda.
--
-- Não cria, apaga nem altera nenhuma linha em exchanges/exchange_items/
-- finance_entries. Só preenche sales.returned_at/returned_by onde estavam
-- NULL.
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
    ex.created_at        AS completion_at,
    ex.created_by        AS completion_by
  FROM public.exchanges ex
  WHERE ex.status = 'completed'
    AND ex.original_sale_id IN (SELECT sale_id FROM fully_exchanged_sales)
  ORDER BY ex.original_sale_id, ex.created_at DESC
)
UPDATE public.sales s
SET returned_at = lce.completion_at,
    returned_by = lce.completion_by
FROM last_completing_exchange lce
WHERE s.id = lce.sale_id
  AND s.status = 'returned'
  AND s.returned_at IS NULL;

-- =============================================================================
-- PÓS-VALIDAÇÃO — deve retornar 0 linhas após esta migration
-- =============================================================================
-- (mesma query de audit_trocas_returned_at_null.sql na raiz do repo)

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Snapshot obrigatório antes de rodar esta migration:
--   SELECT id, returned_at, returned_by FROM public.sales
--   WHERE status = 'returned' AND returned_at IS NULL;
-- (nesse ponto os dois campos devem estar NULL nas linhas afetadas — é a
--  base do rollback; anote os IDs retornados por essa query)
--
-- Reverter (troque a lista de IDs pela capturada no snapshot acima):
-- UPDATE public.sales
-- SET returned_at = NULL, returned_by = NULL
-- WHERE id IN (/* IDs do snapshot */);
*/
