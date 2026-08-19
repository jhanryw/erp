-- =============================================================================
-- fiscal_documents_constraints.test.sql
--
-- Valida as constraints de idempotência/duplicidade criadas em
-- supabase/migrations/20260821_focus_nfe_fiscal_foundation.sql:
--   1. UNIQUE(provider, provider_ref) em fiscal_documents.
--   2. UNIQUE(access_key) em fiscal_documents, só quando preenchida (NULLs
--      não colidem entre si).
--   3. No máximo um fiscal_document com status='authorized' por
--      (sale_id, document_type) — múltiplas tentativas draft/erro
--      continuam permitidas pra retry.
--   4. UNIQUE(company_id) em company_fiscal_settings (um cadastro por
--      empresa).
--
-- Roda como o papel padrão da conexão (dono/service_role) — as tabelas
-- fiscais têm RLS deny-by-default pra `authenticated` (nenhuma policy,
-- mesmo padrão de integration_outbox), então não há cenário de RLS aqui
-- pra testar; o que importa são as CONSTRAINTs do schema em si.
--
-- Mesmo padrão de fixture de supabase/tests/customer_purchase_profile.test.sql:
-- reaproveita uma linha existente de auth.users pra seller_id (evita o
-- problema já conhecido de FK direta com UUID sintético em public.users).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/fiscal_documents_constraints.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_company   int;
  v_customer  int;
  v_seller    uuid;
  v_sale      int;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Fiscal Documents — APAGAR', 'teste-fiscal-documents-apagar', 'starter', true)
  RETURNING id INTO v_company;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente Teste Fiscal — APAGAR', '99988877766', '84999990099', v_company, true)
  RETURNING id INTO v_customer;

  SELECT id INTO v_seller FROM auth.users LIMIT 1;

  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer, v_seller, v_company, 'paid', 'pix', '2026-08-20', 150)
  RETURNING id INTO v_sale;

  -- Persistidos em tabela temporária de sessão só pra os blocos seguintes
  -- reaproveitarem sem precisar de outro SELECT — mesmo padrão simples já
  -- usado neste arquivo de teste (variáveis locais por bloco DO não
  -- atravessam blocos, então usamos uma tabela TEMP dentro da transação).
  CREATE TEMP TABLE fiscal_test_fixture (company_id int, sale_id int);
  INSERT INTO fiscal_test_fixture VALUES (v_company, v_sale);

  RAISE NOTICE 'Fixture: company=%, sale=%', v_company, v_sale;
END $$;


-- =============================================================================
-- Cenário 1 — UNIQUE(provider, provider_ref)
-- =============================================================================
SAVEPOINT cenario_1;

DO $$
DECLARE
  v_company int;
  v_sale    int;
  v_caught  boolean := false;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM fiscal_test_fixture;

  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
  VALUES (v_company, v_sale, 'homologacao', 'ref-duplicada-apagar', 'draft');

  BEGIN
    INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
    VALUES (v_company, v_sale, 'homologacao', 'ref-duplicada-apagar', 'draft');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 1: dois fiscal_documents com o mesmo provider_ref deveriam violar UNIQUE(provider, provider_ref)';
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (UNIQUE provider_ref)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1;


-- =============================================================================
-- Cenário 2 — UNIQUE(access_key), só quando preenchida
-- =============================================================================
SAVEPOINT cenario_2;

DO $$
DECLARE
  v_company int;
  v_sale    int;
  v_caught  boolean := false;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM fiscal_test_fixture;

  -- Duas linhas com access_key IGUAL — deve falhar.
  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status, access_key)
  VALUES (v_company, v_sale, 'homologacao', 'ref-ak-1-apagar', 'authorized', '11111111111111111111111111111111111111111111');

  BEGIN
    INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status, access_key)
    VALUES (v_company, v_sale, 'homologacao', 'ref-ak-2-apagar', 'authorized', '11111111111111111111111111111111111111111111');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 2a: dois fiscal_documents com o mesmo access_key deveriam violar o UNIQUE INDEX parcial';
  END IF;

  RAISE NOTICE 'OK — Cenário 2a (UNIQUE access_key quando preenchida)';
END $$;

DO $$
DECLARE
  v_company int;
  v_sale    int;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM fiscal_test_fixture;

  -- Duas linhas com access_key NULL — NÃO deve falhar (índice parcial ignora NULL).
  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status, access_key)
  VALUES (v_company, v_sale, 'homologacao', 'ref-ak-null-1-apagar', 'draft', NULL);

  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status, access_key)
  VALUES (v_company, v_sale, 'homologacao', 'ref-ak-null-2-apagar', 'draft', NULL);

  RAISE NOTICE 'OK — Cenário 2b (múltiplos access_key NULL não colidem)';
END $$;

ROLLBACK TO SAVEPOINT cenario_2;


-- =============================================================================
-- Cenário 3 — no máximo um fiscal_document 'authorized' por
-- (sale_id, document_type); múltiplas tentativas draft/submission_error
-- continuam permitidas.
-- =============================================================================
SAVEPOINT cenario_3;

DO $$
DECLARE
  v_company int;
  v_sale    int;
  v_caught  boolean := false;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM fiscal_test_fixture;

  -- Duas tentativas draft/erro pra mesma venda — devem conviver (retry após correção).
  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
  VALUES (v_company, v_sale, 'homologacao', 'ref-retry-1-apagar', 'submission_error');
  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
  VALUES (v_company, v_sale, 'homologacao', 'ref-retry-2-apagar', 'draft');

  -- Primeira autorização pra essa venda — deve funcionar.
  INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
  VALUES (v_company, v_sale, 'homologacao', 'ref-autorizada-1-apagar', 'authorized');

  -- Segunda autorização pra MESMA venda — deve falhar (uma venda não pode
  -- ter duas NF-e autorizadas simultaneamente).
  BEGIN
    INSERT INTO public.fiscal_documents (company_id, sale_id, environment, provider_ref, status)
    VALUES (v_company, v_sale, 'homologacao', 'ref-autorizada-2-apagar', 'authorized');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 3: duas NF-e authorized pra mesma venda deveriam violar o UNIQUE INDEX parcial (sale_id, document_type) WHERE status=''authorized''';
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (no máximo 1 fiscal_document authorized por venda; retries em draft/erro continuam permitidos)';
END $$;

ROLLBACK TO SAVEPOINT cenario_3;


-- =============================================================================
-- Cenário 4 — UNIQUE(company_id) em company_fiscal_settings
-- =============================================================================
SAVEPOINT cenario_4;

DO $$
DECLARE
  v_company int;
  v_caught  boolean := false;
BEGIN
  SELECT company_id INTO v_company FROM fiscal_test_fixture;

  INSERT INTO public.company_fiscal_settings (company_id, cnpj) VALUES (v_company, '11111111000191');

  BEGIN
    INSERT INTO public.company_fiscal_settings (company_id, cnpj) VALUES (v_company, '22222222000192');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 4: duas linhas de company_fiscal_settings pra mesma empresa deveriam violar UNIQUE(company_id)';
  END IF;

  RAISE NOTICE 'OK — Cenário 4 (UNIQUE company_id em company_fiscal_settings)';
END $$;

ROLLBACK TO SAVEPOINT cenario_4;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO, inclusive as
-- empresas/clientes/vendas/documentos fiscais de fixture).
-- =============================================================================
