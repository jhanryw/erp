-- =============================================================================
-- 202609031200_sales_modality_analytics_indexes.sql
--
-- Analytics Varejo × Atacado — dois índices avaliados pelo pedido desta
-- fase, ambos justificados por uma query REAL introduzida agora (nenhum
-- índice especulativo):
--
--   idx_sales_company_saledate_saletype (company_id, sale_date, sale_type)
--     — serve `getModalityComparison`/`getDailyModalityRevenue`
--     (src/services/analytics/modalityAnalytics.ts) e
--     `getProductModalityBreakdown` (…/productModalityReport.ts): todas
--     filtram exatamente por company_id + intervalo de sale_date, com
--     sale_type como coluna de agrupamento/filtro imediatamente
--     relevante. Complementa (não substitui) o índice já existente
--     `idx_sales_company_sale_type (company_id, sale_type)`
--     (202608311200_wholesale_retail_schema_foundation.sql) — aquele não
--     cobre range de data, que é o filtro mais seletivo em todas as
--     queries novas desta fase.
--
--   idx_sales_company_saletype_channel_saledate
--     (company_id, sale_type, sales_channel, sale_date)
--     — serve o cruzamento sale_type × sales_channel introduzido pelo
--     filtro de canal em `getModalityComparison(..., {salesChannel})`
--     (seção "CANAL" do pedido: "Varejo + POS", "Atacado + Nuvemshop"
--     etc.) — usado de verdade pela página `/relatorios/varejo-atacado`.
--
-- Nenhum índice antigo removido/alterado. `CREATE INDEX CONCURRENTLY` não
-- usado de propósito — mesma convenção já adotada nas migrations
-- anteriores deste projeto (sempre dentro de uma transação de migration
-- normal); `sales` já recebe CHECK constraints via NOT VALID em fases
-- anteriores quando o lock era a preocupação real — aqui os índices são
-- novos (não reescrevem linhas existentes), custo de lock é o padrão de
-- CREATE INDEX simples.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_sales_company_saledate_saletype
  ON public.sales (company_id, sale_date, sale_type);

CREATE INDEX IF NOT EXISTS idx_sales_company_saletype_channel_saledate
  ON public.sales (company_id, sale_type, sales_channel, sale_date);

COMMENT ON INDEX public.idx_sales_company_saledate_saletype IS
  'Analytics Varejo/Atacado — comparação e evolução temporal por modalidade (getModalityComparison/getDailyModalityRevenue/getProductModalityBreakdown), sempre filtrados por company_id + intervalo de sale_date.';
COMMENT ON INDEX public.idx_sales_company_saletype_channel_saledate IS
  'Analytics Varejo/Atacado — cruzamento sale_type × sales_channel (filtro de canal em /relatorios/varejo-atacado), sale_type continua sendo a dimensão comercial primária, sales_channel só restringe.';

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'sales'
  AND indexname IN ('idx_sales_company_saledate_saletype', 'idx_sales_company_saletype_channel_saledate');
-- Esperado: 2 linhas

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP INDEX IF EXISTS public.idx_sales_company_saledate_saletype;
DROP INDEX IF EXISTS public.idx_sales_company_saletype_channel_saledate;
*/
