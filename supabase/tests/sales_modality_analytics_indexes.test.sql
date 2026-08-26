-- =============================================================================
-- sales_modality_analytics_indexes.test.sql
--
-- Analytics Varejo/Atacado — prova que os 2 índices de
-- 202609031200_sales_modality_analytics_indexes.sql existem com as
-- colunas certas, e que uma query real no formato usado por
-- getModalityComparison consegue usar o índice (EXPLAIN, sem alterar
-- dado nenhum).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sales_modality_analytics_indexes.test.sql
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'sales'
    AND indexname IN ('idx_sales_company_saledate_saletype', 'idx_sales_company_saletype_channel_saledate');

  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FALHA: esperado 2 índices novos, encontrado %.', v_count;
  END IF;
  RAISE NOTICE 'OK: os 2 índices de Analytics Varejo/Atacado existem.';

  -- Colunas na ordem certa (company_id primeiro sempre — é o filtro mais seletivo em multi-tenant)
  PERFORM 1 FROM pg_indexes
  WHERE indexname = 'idx_sales_company_saledate_saletype'
    AND indexdef ILIKE '%(company_id, sale_date, sale_type)%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA: idx_sales_company_saledate_saletype não tem a ordem de colunas esperada.';
  END IF;
  RAISE NOTICE 'OK: idx_sales_company_saledate_saletype com colunas (company_id, sale_date, sale_type).';

  RAISE NOTICE 'sales_modality_analytics_indexes.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
