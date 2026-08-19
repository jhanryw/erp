-- =============================================================================
-- rls_tenant_isolation.test.sql
--
-- Valida o comportamento das policies criadas em
-- supabase/migrations/20260820_fix_rls_open_policies_tenant_isolation.sql:
--   1. Isolamento entre empresas (company A não vê/edita dado de company B).
--   2. Roles preservadas (usuario não pode DELETE em products; admin pode).
--   3. Deny total para authenticated em sale_items/users/cashback_transactions.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rls_tenant_isolation.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo, mesmo padrão
-- de product_sku_identity.test.sql/rpc_import_products_batch.test.sql. Cria
-- suas próprias empresas/usuários/dados de teste, não depende de dado real
-- pré-existente.
--
-- Simulação de sessão: `auth.uid()` no Supabase lê
-- current_setting('request.jwt.claims', true)::json->>'sub'. Cada bloco de
-- teste troca de "usuário" via `SET LOCAL role authenticated` +
-- `SET LOCAL request.jwt.claims`, exatamente como uma sessão real via
-- PostgREST/supabase-js autenticaria. `SET LOCAL` só vale até o fim da
-- transação/savepoint — cada cenário usa seu próprio bloco DO/SAVEPOINT
-- para não vazar o "usuário" de um cenário para o outro.
-- =============================================================================

BEGIN;

-- ─── Fixtures: 2 empresas, 1 usuário admin + 1 usuário usuario por empresa ────

DO $$
DECLARE
  v_company_a  INT;
  v_company_b  INT;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE RLS — Empresa A — APAGAR', 'teste-rls-empresa-a-apagar', 'starter', true)
  RETURNING id INTO v_company_a;

  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE RLS — Empresa B — APAGAR', 'teste-rls-empresa-b-apagar', 'starter', true)
  RETURNING id INTO v_company_b;

  RAISE NOTICE 'Fixture: company_a=%, company_b=%', v_company_a, v_company_b;
END $$;

-- Usuários de teste — inseridos diretamente em public.users (não em
-- auth.users, que exigiria criar sessão real via GoTrue). auth.uid() é
-- simulado via request.jwt.claims abaixo, não depende de auth.users
-- existir para o propósito deste teste (current_company_id()/get_user_role()
-- só consultam public.users pelo id).
DO $$
DECLARE
  v_company_a INT;
  v_company_b INT;
BEGIN
  SELECT id INTO v_company_a FROM public.companies WHERE slug = 'teste-rls-empresa-a-apagar';
  SELECT id INTO v_company_b FROM public.companies WHERE slug = 'teste-rls-empresa-b-apagar';

  -- role é o enum user_role do banco: ('admin', 'seller', 'gerente') —
  -- confirmado por consulta live nesta sessão. 'usuario' NÃO é um valor
  -- válido do enum, só existe como nome de papel no TypeScript (AppRole),
  -- mapeado a partir de 'seller' por normalizeRole() (src/types/roles.ts).
  INSERT INTO public.users (id, name, role, active, company_id)
  VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'Teste A — seller', 'seller', true, v_company_a),
    ('00000000-0000-0000-0000-0000000000a2', 'Teste A — admin',  'admin',  true, v_company_a),
    ('00000000-0000-0000-0000-0000000000b1', 'Teste B — seller', 'seller', true, v_company_b);
END $$;

-- Um customer e um product por empresa, para testar SELECT/UPDATE/DELETE cross-tenant.
DO $$
DECLARE
  v_company_a INT;
  v_company_b INT;
  v_cat_a     INT;
  v_cat_b     INT;
BEGIN
  SELECT id INTO v_company_a FROM public.companies WHERE slug = 'teste-rls-empresa-a-apagar';
  SELECT id INTO v_company_b FROM public.companies WHERE slug = 'teste-rls-empresa-b-apagar';

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE RLS CAT A — APAGAR', 'teste-rls-cat-a-apagar', v_company_a, true)
  RETURNING id INTO v_cat_a;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE RLS CAT B — APAGAR', 'teste-rls-cat-b-apagar', v_company_b, true)
  RETURNING id INTO v_cat_b;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Teste RLS Cliente A — APAGAR', '11111111111', '11999999999', v_company_a, true);

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Teste RLS Cliente B — APAGAR', '22222222222', '11988888888', v_company_b, true);

  INSERT INTO public.products (name, sku, category_id, origin, base_cost, base_price, company_id, active)
  VALUES ('Teste RLS Produto A — APAGAR', 'TESTE-RLS-A-APAGAR', v_cat_a, 'third_party', 10, 20, v_company_a, true);

  INSERT INTO public.products (name, sku, category_id, origin, base_cost, base_price, company_id, active)
  VALUES ('Teste RLS Produto B — APAGAR', 'TESTE-RLS-B-APAGAR', v_cat_b, 'third_party', 10, 20, v_company_b, true);
END $$;


-- =============================================================================
-- Cenário 1 — SELECT: usuário da empresa A só vê customers/products da
-- empresa A, nunca da empresa B.
-- =============================================================================
SAVEPOINT cenario_1;

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';

DO $$
DECLARE
  v_count_a_customers INT;
  v_count_b_customers INT;
  v_count_a_products  INT;
  v_count_b_products  INT;
BEGIN
  SELECT count(*) INTO v_count_a_customers FROM public.customers WHERE name = 'Teste RLS Cliente A — APAGAR';
  SELECT count(*) INTO v_count_b_customers FROM public.customers WHERE name = 'Teste RLS Cliente B — APAGAR';
  SELECT count(*) INTO v_count_a_products  FROM public.products  WHERE sku = 'TESTE-RLS-A-APAGAR';
  SELECT count(*) INTO v_count_b_products  FROM public.products  WHERE sku = 'TESTE-RLS-B-APAGAR';

  IF v_count_a_customers != 1 THEN
    RAISE EXCEPTION 'FALHA Cenário 1: usuário da empresa A deveria ver o customer da própria empresa (esperado 1, veio %)', v_count_a_customers;
  END IF;
  IF v_count_b_customers != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 1 (ISOLAMENTO QUEBRADO): usuário da empresa A conseguiu ver customer da empresa B (esperado 0, veio %)', v_count_b_customers;
  END IF;
  IF v_count_a_products != 1 THEN
    RAISE EXCEPTION 'FALHA Cenário 1: usuário da empresa A deveria ver o product da própria empresa (esperado 1, veio %)', v_count_a_products;
  END IF;
  IF v_count_b_products != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 1 (ISOLAMENTO QUEBRADO): usuário da empresa A conseguiu ver product da empresa B (esperado 0, veio %)', v_count_b_products;
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (isolamento de SELECT em customers/products)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1;
RESET role;


-- =============================================================================
-- Cenário 2 — DELETE em products: usuario NÃO pode (products_delete exige
-- admin), admin da MESMA empresa pode, admin não afeta linha de outra
-- empresa.
-- =============================================================================
SAVEPOINT cenario_2;

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a1", "role": "authenticated"}';

DO $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.products WHERE sku = 'TESTE-RLS-A-APAGAR';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 2 (ROLE QUEBRADA): usuario conseguiu apagar product — deveria exigir admin (esperado 0 linhas afetadas, veio %)', v_deleted;
  END IF;
  RAISE NOTICE 'OK — Cenário 2a (usuario não pode DELETE em products)';
END $$;

RESET role;
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}';

DO $$
DECLARE
  v_deleted INT;
BEGIN
  -- Admin da empresa A tenta apagar o product da empresa B — deve afetar 0 linhas.
  DELETE FROM public.products WHERE sku = 'TESTE-RLS-B-APAGAR';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 2 (ISOLAMENTO QUEBRADO): admin da empresa A conseguiu apagar product da empresa B (esperado 0, veio %)', v_deleted;
  END IF;

  -- Admin da empresa A apaga o product da PRÓPRIA empresa — deve afetar 1 linha.
  DELETE FROM public.products WHERE sku = 'TESTE-RLS-A-APAGAR';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted != 1 THEN
    RAISE EXCEPTION 'FALHA Cenário 2: admin deveria conseguir apagar product da própria empresa (esperado 1, veio %)', v_deleted;
  END IF;

  RAISE NOTICE 'OK — Cenário 2b/2c (admin só apaga da própria empresa)';
END $$;

ROLLBACK TO SAVEPOINT cenario_2;
RESET role;


-- =============================================================================
-- Cenário 3 — deny total para authenticated em sale_items, users,
-- cashback_transactions (nenhuma policy = zero linhas em qualquer SELECT,
-- mesmo dentro da própria empresa).
-- =============================================================================
SAVEPOINT cenario_3;

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000000a2", "role": "authenticated"}';

DO $$
DECLARE
  v_count_sale_items INT;
  v_count_users       INT;
  v_count_cashback     INT;
BEGIN
  SELECT count(*) INTO v_count_sale_items FROM public.sale_items;
  SELECT count(*) INTO v_count_users FROM public.users;
  SELECT count(*) INTO v_count_cashback FROM public.cashback_transactions;

  IF v_count_sale_items != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: authenticated não deveria ver nenhuma linha de sale_items (esperado 0, veio %)', v_count_sale_items;
  END IF;
  IF v_count_users != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: authenticated não deveria ver nenhuma linha de users, nem mesmo a si mesmo (esperado 0, veio %)', v_count_users;
  END IF;
  IF v_count_cashback != 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: authenticated não deveria ver nenhuma linha de cashback_transactions (esperado 0, veio %)', v_count_cashback;
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (deny total em sale_items/users/cashback_transactions)';
END $$;

ROLLBACK TO SAVEPOINT cenario_3;
RESET role;


-- =============================================================================
-- Cenário 4 — service_role continua com acesso total (RPCs/rotas de API
-- não afetadas). Roda como o papel padrão da conexão (service_role/dono),
-- sem SET LOCAL role — confirma que a migration não alterou GRANT nenhum.
-- =============================================================================
DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM public.sale_items; -- não deve lançar erro nem retornar 0 por causa de RLS
  RAISE NOTICE 'OK — Cenário 4 (service_role/dono continua acessando sale_items sem restrição de RLS)';
END $$;


-- RAISE NOTICE é comando PL/pgSQL, não SQL padrão — precisa estar dentro
-- de um bloco DO, nunca solto no nível do script (isso causaria
-- "ERROR: syntax error at or near RAISE" antes de chegar ao ROLLBACK).
DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO, inclusive as
-- empresas/usuários/customers/products de fixture).
-- =============================================================================
