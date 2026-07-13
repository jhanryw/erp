-- =============================================================================
-- 20260723_backfill_historico_cancelled_returned_at.sql
--
-- Financeiro 2.1 — Estabilidade de competência do DRE (3/3)
--
-- Backfill de cancelled_at/cancelled_by/returned_at/returned_by para as 19
-- vendas cancelled/returned que existiam antes de 20260722 (RPC nova) passar
-- a preencher esses campos automaticamente.
--
-- Fontes, por grupo (definidas por diagnóstico manual, não por heurística
-- automática — ver conversa de auditoria Financeiro 2.1):
--
--   Grupo 1 — 14 cancelamentos: finance_entries(category='other_expense',
--     description LIKE 'Cancelamento —%'), exatamente 1 por venda.
--   Grupo 2 — 1 devolução (venda 102): finance_entries(category='other_expense',
--     description LIKE 'Devolução —%'), exatamente 1.
--   Grupo 3 — 4 devoluções por troca (vendas 114, 156, 264, 281):
--     exchanges(status='completed'), exatamente 1 por venda. Confirmado que
--     exchanges.created_at coincide exatamente com o primeiro audit_log de
--     status='returned' para essas 4 vendas (diferença = 0s) — não geram
--     finance_entries porque não houve reembolso financeiro, só troca/crédito.
--
-- Rede de segurança: cada UPDATE só afeta vendas com exatamente uma fonte
-- correspondente (HAVING COUNT(*) = 1) e ainda não preenchidas
-- (cancelled_at/returned_at IS NULL). A query de pós-validação no final
-- deve retornar 0 linhas — qualquer venda cancelled/returned que sobre ali
-- não tem fonte inequívoca e precisa de revisão manual, sem fallback
-- automático para sales.updated_at.
--
-- Não cria, apaga nem altera nenhuma finance_entries.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- Grupo 1 — Cancelamentos via finance_entries
-- ═══════════════════════════════════════════════════════════════════════════════

WITH fe_cancel_unicas AS (
  SELECT
    sale_id,
    MIN(created_at)             AS created_at,
    MIN(created_by::text)::uuid AS created_by
  FROM finance_entries
  WHERE category = 'other_expense'
    AND description LIKE 'Cancelamento —%'
    AND sale_id IS NOT NULL
  GROUP BY sale_id
  HAVING COUNT(*) = 1
)
UPDATE sales s
SET cancelled_at = fc.created_at,
    cancelled_by = fc.created_by
FROM fe_cancel_unicas fc
WHERE s.id = fc.sale_id
  AND s.status = 'cancelled'
  AND s.cancelled_at IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Grupo 2 — Devoluções via finance_entries
-- ═══════════════════════════════════════════════════════════════════════════════

WITH fe_return_unicas AS (
  SELECT
    sale_id,
    MIN(created_at)             AS created_at,
    MIN(created_by::text)::uuid AS created_by
  FROM finance_entries
  WHERE category = 'other_expense'
    AND description LIKE 'Devolução —%'
    AND sale_id IS NOT NULL
  GROUP BY sale_id
  HAVING COUNT(*) = 1
)
UPDATE sales s
SET returned_at = fr.created_at,
    returned_by = fr.created_by
FROM fe_return_unicas fr
WHERE s.id = fr.sale_id
  AND s.status = 'returned'
  AND s.returned_at IS NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- Grupo 3 — Devoluções por troca (exchanges), sem finance_entries
-- ═══════════════════════════════════════════════════════════════════════════════

WITH exchange_unicas AS (
  SELECT
    original_sale_id            AS sale_id,
    MIN(created_at)              AS created_at,
    MIN(created_by::text)::uuid  AS created_by
  FROM exchanges
  WHERE status = 'completed'
  GROUP BY original_sale_id
  HAVING COUNT(*) = 1
)
UPDATE sales s
SET returned_at = ex.created_at,
    returned_by = ex.created_by
FROM exchange_unicas ex
WHERE s.id = ex.sale_id
  AND s.status = 'returned'
  AND s.returned_at IS NULL
  -- Rede de segurança: não usar exchange se também existir finance_entries de
  -- devolução para a mesma venda (ambiguidade de dupla fonte) — não observado
  -- nos dados atuais, mas a migration não deve depender da ordem de execução
  -- dos três blocos acima para ficar correta.
  AND NOT EXISTS (
    SELECT 1 FROM finance_entries fe
    WHERE fe.sale_id = s.id
      AND fe.category = 'other_expense'
      AND fe.description LIKE 'Devolução —%'
  );


-- =============================================================================
-- PÓS-VALIDAÇÃO — deve retornar 0 linhas
-- =============================================================================
-- SELECT id, sale_number, status, cancelled_at, returned_at
-- FROM sales
-- WHERE status IN ('cancelled', 'returned')
--   AND ((status = 'cancelled' AND cancelled_at IS NULL)
--     OR (status = 'returned'  AND returned_at  IS NULL));


-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Snapshot obrigatório antes de rodar esta migration:
--   SELECT id, cancelled_at, cancelled_by, returned_at, returned_by
--   FROM sales WHERE status IN ('cancelled','returned');
-- (nesse ponto todos os 4 campos devem estar NULL — é a base do rollback)
--
-- Reverter:
UPDATE sales
SET cancelled_at = NULL, cancelled_by = NULL, returned_at = NULL, returned_by = NULL
WHERE id IN (44,45,58,59,70,102,114,156,178,179,180,181,182,183,184,185,264,281,296);
*/
