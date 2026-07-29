-- =============================================================================
-- 20260728_finance_entries_list_indexes.sql
--
-- Suporte à auditoria de /financeiro/lancamentos: a página trocou um
-- `.limit(100)` fixo por paginação real no servidor (.range + count:'exact')
-- com filtros combináveis (tipo, categoria, status de pagamento, competência,
-- origem do lançamento). Esta migration só cria os índices que essas novas
-- consultas passam a precisar — nenhuma alteração de dado, view ou RPC.
--
-- O QUE FAZ:
--   1. idx_finance_entries_company_created_at — filtro/ordenação padrão da
--      listagem (created_at DESC, "quando o lançamento entrou no ERP" — usado
--      para auditar a leva de importação/regularização do Caixa), sempre
--      escopado por company_id.
--   2. idx_finance_entries_company_reference_date — filtro/ordenação por
--      competência financeira (reference_date), grupo de filtro separado.
--      Mesmo padrão de idx_cash_movements_company_date.
--   3. idx_finance_entries_company_type_category — filtros combinados de
--      tipo (receita/despesa) e categoria.
--   4. Índices parciais em sale_id/stock_lot_id/marketing_cost_id/return_id
--      — usados pelo filtro "origem do lançamento" (WHERE ... IS NOT NULL).
--      cash_movement_id já tem índice via a UNIQUE fe_cash_movement_id_unique
--      (Entrega 2) — não duplicado aqui.
--
-- IDEMPOTENTE: sim — CREATE INDEX IF NOT EXISTS, sem DROP nem alteração de
-- dados existentes.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_finance_entries_company_created_at
  ON public.finance_entries (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_entries_company_reference_date
  ON public.finance_entries (company_id, reference_date DESC);

CREATE INDEX IF NOT EXISTS idx_finance_entries_company_type_category
  ON public.finance_entries (company_id, type, category);

CREATE INDEX IF NOT EXISTS idx_finance_entries_sale
  ON public.finance_entries (sale_id) WHERE sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_entries_stock_lot
  ON public.finance_entries (stock_lot_id) WHERE stock_lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_entries_marketing_cost
  ON public.finance_entries (marketing_cost_id) WHERE marketing_cost_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_entries_return
  ON public.finance_entries (return_id) WHERE return_id IS NOT NULL;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

SELECT indexname FROM pg_indexes
WHERE tablename = 'finance_entries'
  AND indexname IN (
    'idx_finance_entries_company_created_at',
    'idx_finance_entries_company_reference_date',
    'idx_finance_entries_company_type_category',
    'idx_finance_entries_sale',
    'idx_finance_entries_stock_lot',
    'idx_finance_entries_marketing_cost',
    'idx_finance_entries_return'
  )
ORDER BY indexname;
-- Esperado: 7 linhas

-- =============================================================================
-- FIM DA MIGRATION 20260728
-- =============================================================================
