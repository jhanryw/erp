-- =============================================================================
-- sale_recipients_constraints.test.sql
--
-- Valida as constraints criadas em supabase/migrations/20260828_sale_recipients.sql
-- e 20260828_customer_addresses_ibge.sql (Fase Fiscal 5C):
--   1. sale_recipients: UNIQUE(sale_id) — uma venda tem no máximo um snapshot.
--   2. sale_recipients: formato de município_ibge (7 dígitos), UF (2 letras
--      maiúsculas), CEP (8 dígitos).
--   3. customer_addresses: mesmo formato de município_ibge; ibge_source só
--      aceita os 3 valores documentados.
--   4. Alterar customer_addresses DEPOIS de criado o snapshot não muda o
--      snapshot já persistido (prova direta da invariante de imutabilidade
--      — não é FK ON UPDATE CASCADE, é cópia de valor).
--
-- Mesmo padrão de fixture de fiscal_documents_constraints.test.sql.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sale_recipients_constraints.test.sql
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
  v_address   int;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Sale Recipients — APAGAR', 'teste-sale-recipients-apagar', 'starter', true)
  RETURNING id INTO v_company;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente Teste Recipients — APAGAR', '99988877755', '84999990088', v_company, true)
  RETURNING id INTO v_customer;

  SELECT id INTO v_seller FROM auth.users LIMIT 1;

  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, sale_date, total)
  VALUES (v_customer, v_seller, v_company, 'paid', 'pix', '2026-08-20', 100)
  RETURNING id INTO v_sale;

  INSERT INTO public.customer_addresses (customer_id, cep, street, number, neighborhood, city, state, municipio_ibge, ibge_source)
  VALUES (v_customer, '59000000', 'Rua Teste', '100', 'Centro', 'Natal', 'RN', '2408102', 'viacep')
  RETURNING id INTO v_address;

  CREATE TEMP TABLE recipients_test_fixture (company_id int, customer_id int, sale_id int, address_id int);
  INSERT INTO recipients_test_fixture VALUES (v_company, v_customer, v_sale, v_address);

  RAISE NOTICE 'Fixture: company=%, customer=%, sale=%, address=%', v_company, v_customer, v_sale, v_address;
END $$;


-- =============================================================================
-- Cenário 1 — UNIQUE(sale_id): uma segunda linha de snapshot pra mesma venda falha
-- =============================================================================
SAVEPOINT cenario_1;

DO $$
DECLARE
  v_company int; v_sale int; v_caught boolean := false;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM recipients_test_fixture;

  INSERT INTO public.sale_recipients (sale_id, company_id, nome, cep, logradouro, numero, bairro, municipio, uf)
  VALUES (v_sale, v_company, 'Cliente A', '59000000', 'Rua A', '1', 'Centro', 'Natal', 'RN');

  BEGIN
    INSERT INTO public.sale_recipients (sale_id, company_id, nome, cep, logradouro, numero, bairro, municipio, uf)
    VALUES (v_sale, v_company, 'Cliente A (duplicata)', '59000000', 'Rua A', '1', 'Centro', 'Natal', 'RN');
  EXCEPTION WHEN unique_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 1: duas linhas de sale_recipients pra mesma venda deveriam violar UNIQUE(sale_id)';
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (UNIQUE sale_id em sale_recipients)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1;


-- =============================================================================
-- Cenário 2 — formato de município_ibge (7 dígitos), UF (2 letras), CEP (8 dígitos)
-- =============================================================================
SAVEPOINT cenario_2;

DO $$
DECLARE
  v_company int; v_sale int; v_caught boolean;
BEGIN
  SELECT company_id, sale_id INTO v_company, v_sale FROM recipients_test_fixture;

  v_caught := false;
  BEGIN
    INSERT INTO public.sale_recipients (sale_id, company_id, nome, cep, logradouro, numero, bairro, municipio, uf, municipio_ibge)
    VALUES (v_sale, v_company, 'Cliente B', '59000000', 'Rua B', '1', 'Centro', 'Natal', 'RN', '240810'); -- 6 dígitos
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 2a: municipio_ibge com 6 dígitos deveria violar o CHECK de formato';
  END IF;

  v_caught := false;
  BEGIN
    INSERT INTO public.sale_recipients (sale_id, company_id, nome, cep, logradouro, numero, bairro, municipio, uf)
    VALUES (v_sale, v_company, 'Cliente C', '59000000', 'Rua C', '1', 'Centro', 'Natal', 'rn'); -- minúsculo
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 2b: UF minúscula deveria violar o CHECK de formato (~ [A-Z]{2})';
  END IF;

  v_caught := false;
  BEGIN
    INSERT INTO public.sale_recipients (sale_id, company_id, nome, cep, logradouro, numero, bairro, municipio, uf)
    VALUES (v_sale, v_company, 'Cliente D', '5900-000', 'Rua D', '1', 'Centro', 'Natal', 'RN'); -- CEP com hífen
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 2c: CEP com pontuação deveria violar o CHECK de formato (só dígitos, 8 caracteres)';
  END IF;

  RAISE NOTICE 'OK — Cenário 2 (formatos de municipio_ibge/UF/CEP validados por CHECK)';
END $$;

ROLLBACK TO SAVEPOINT cenario_2;


-- =============================================================================
-- Cenário 3 — customer_addresses.ibge_source só aceita valores documentados
-- =============================================================================
SAVEPOINT cenario_3;

DO $$
DECLARE
  v_customer int; v_caught boolean := false;
BEGIN
  SELECT customer_id INTO v_customer FROM recipients_test_fixture;

  BEGIN
    INSERT INTO public.customer_addresses (customer_id, cep, street, number, neighborhood, city, state, ibge_source)
    VALUES (v_customer, '59000001', 'Rua E', '2', 'Centro', 'Natal', 'RN', 'chute'); -- valor não documentado
  EXCEPTION WHEN check_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 3: ibge_source com valor arbitrário deveria violar o CHECK (só viacep/resolve_municipio_ibge/manual_confirmado)';
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (ibge_source restrito aos valores documentados)';
END $$;

ROLLBACK TO SAVEPOINT cenario_3;


-- =============================================================================
-- Cenário 4 — imutabilidade: alterar customer_addresses DEPOIS de criado o
-- snapshot não muda o snapshot já persistido (prova direta, não só design)
-- =============================================================================
SAVEPOINT cenario_4;

DO $$
DECLARE
  v_company int; v_sale int; v_address int;
  v_snapshot_municipio_antes text;
  v_snapshot_municipio_depois text;
BEGIN
  SELECT company_id, sale_id, address_id INTO v_company, v_sale, v_address FROM recipients_test_fixture;

  INSERT INTO public.sale_recipients (sale_id, company_id, source_address_id, nome, cep, logradouro, numero, bairro, municipio, uf, municipio_ibge)
  VALUES (v_sale, v_company, v_address, 'Cliente F', '59000000', 'Rua F', '1', 'Centro', 'Natal', 'RN', '2408102');

  SELECT municipio INTO v_snapshot_municipio_antes FROM public.sale_recipients WHERE sale_id = v_sale;

  -- Cliente muda de cidade DEPOIS da venda — igual ao cenário descrito no
  -- pedido original (Rua A → Rua B, 3 meses depois).
  UPDATE public.customer_addresses SET city = 'Mossoró', state = 'RN' WHERE id = v_address;

  SELECT municipio INTO v_snapshot_municipio_depois FROM public.sale_recipients WHERE sale_id = v_sale;

  IF v_snapshot_municipio_antes <> v_snapshot_municipio_depois THEN
    RAISE EXCEPTION 'FALHA Cenário 4: snapshot mudou de "%" para "%" depois de alterar customer_addresses — imutabilidade quebrada!', v_snapshot_municipio_antes, v_snapshot_municipio_depois;
  END IF;
  IF v_snapshot_municipio_depois <> 'Natal' THEN
    RAISE EXCEPTION 'FALHA Cenário 4: snapshot deveria continuar "Natal" (valor no momento da venda), veio "%".', v_snapshot_municipio_depois;
  END IF;

  RAISE NOTICE 'OK — Cenário 4 (alterar customer_addresses depois NÃO altera sale_recipients já criado — snapshot é cópia de valor, não referência)';
END $$;

ROLLBACK TO SAVEPOINT cenario_4;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO).
-- =============================================================================
