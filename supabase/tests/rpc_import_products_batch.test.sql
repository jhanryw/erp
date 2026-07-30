-- =============================================================================
-- rpc_import_products_batch.test.sql
--
-- Script de teste FUNCIONAL (não é migration — nunca aplicar via runner de
-- migrations) para public.rpc_import_products_batch, criada em
-- supabase/migrations/202607302400_rpc_import_products_batch.sql.
--
-- POR QUE UM SCRIPT SQL E NÃO UM TESTE VITEST: este repositório não tem
-- infraestrutura de teste com banco (só testes de função pura, sem mock de
-- Postgres). Testar atomicidade de transação/rollback e autorização exige
-- um Postgres real executando a função — simular isso em vitest seria
-- teatro. Este script roda direto contra o seu Postgres self-hosted,
-- depois de aplicar a migration 202607302400, e SOMENTE em ambiente de
-- teste (ver instruções de execução abaixo).
--
-- COMO RODAR (em ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch.test.sql
--
-- ON_ERROR_STOP=1 faz o psql abortar imediatamente se qualquer statement
-- (incluindo os RAISE EXCEPTION de assert que falharem) retornar erro —
-- sem essa flag, psql continua pros próximos comandos mesmo após um erro,
-- o que mascararia falhas.
--
-- SEGURANÇA: o script inteiro roda dentro de UMA transação com ROLLBACK no
-- final — não é destrutivo, nenhum dado de teste fica no banco depois de
-- rodar. Cada cenário usa DO $$ ... EXCEPTION WHEN OTHERS ... $$ para
-- capturar a falha esperada sem abortar a transação inteira (savepoint
-- implícito do PL/pgSQL).
--
-- ESTE SCRIPT NÃO TESTA CONCORRÊNCIA REAL — um único script é
-- inerentemente sequencial. Ver
-- supabase/tests/rpc_import_products_batch.concurrency.md para o
-- procedimento manual (dois terminais psql) que exercita as corridas de
-- idempotency_key e de sku_base.
-- =============================================================================

BEGIN;

-- ─── Fixtures (temporárias, dentro da transação — desfeitas pelo ROLLBACK) ────

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE RPC IMPORT — APAGAR', 'teste-rpc-import-apagar', 1, true)
ON CONFLICT DO NOTHING;

-- Atributo fictício de teste (não usa 'modelo' real, pra não depender de
-- quais migrations de PIM dinâmico já foram aplicadas no banco)
INSERT INTO public.variation_types (name, slug, active)
VALUES ('Teste RPC Import', 'teste-rpc-import-attr', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.variation_values (variation_type_id, value, slug, active, normalized_name, sku_code)
SELECT vt.id, v.value, v.slug, true, v.slug, v.sku_code
FROM public.variation_types vt, (VALUES
  ('Valor A', 'teste-valor-a', '90'),
  ('Valor B', 'teste-valor-b', '91')
) AS v(value, slug, sku_code)
WHERE vt.slug = 'teste-rpc-import-attr'
ON CONFLICT (variation_type_id, slug) DO NOTHING;

-- Um segundo variation_type, pra testar "atributo de outro tipo" (cenário 6b)
INSERT INTO public.variation_types (name, slug, active)
VALUES ('Teste RPC Import — Outro Tipo', 'teste-rpc-import-attr-outro', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.variation_values (variation_type_id, value, slug, active, normalized_name, sku_code)
SELECT vt.id, 'Valor Outro Tipo', 'teste-valor-outro-tipo', true, 'teste-valor-outro-tipo', '92'
FROM public.variation_types vt WHERE vt.slug = 'teste-rpc-import-attr-outro'
ON CONFLICT (variation_type_id, slug) DO NOTHING;

-- Segunda empresa, pra testar "usuário de outra empresa" sem violar a FK
-- users.company_id -> companies.id
INSERT INTO public.companies (name, slug, plan)
SELECT 'TESTE RPC OUTRA EMPRESA', 'teste-rpc-outra-empresa', plan
FROM public.companies LIMIT 1
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';

  -- Precisa de um usuário REAL (gerente ou admin, ativo, da empresa 1) pra
  -- rodar os cenários felizes — não é possível fabricar um usuário novo
  -- aqui porque public.users.id referencia auth.users(id) (gerenciado pelo
  -- Supabase Auth, não deve ser inserido diretamente por este script).
  SELECT id INTO v_test_user_id
  FROM public.users
  WHERE company_id = 1 AND role IN ('admin', 'gerente') AND active = true
  LIMIT 1;

  IF v_test_user_id IS NULL THEN
    RAISE EXCEPTION
      'Nenhum usuário ativo com role gerente/admin encontrado para company_id=1. Crie um usuário de teste (via Supabase Auth + public.users) antes de rodar este script.';
  END IF;

  RAISE NOTICE 'Fixture pronta: categoria id=%, usuário de teste autorizado id=%', v_category_id, v_test_user_id;
END $$;

-- =============================================================================
-- Cenário 1 — lote completamente válido (2 produtos, sem estoque inicial)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
  v_count_before INT;
  v_count_after  INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_count_before FROM public.products;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste RPC Produto 1', 'tipo', 'teste_tipo_1', 'modelo', 'teste_modelo_1',
        'ano', '2026', 'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL,
        'origin', 'third_party', 'base_cost', 10, 'base_price', 20, 'active', true,
        'sku', '9999990001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
        'variants', jsonb_build_array()
      ),
      jsonb_build_object(
        'client_index', 1, 'name', 'Teste RPC Produto 2', 'tipo', 'teste_tipo_2', 'modelo', 'teste_modelo_2',
        'ano', '2026', 'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL,
        'origin', 'third_party', 'base_cost', 10, 'base_price', 20, 'active', true,
        'sku', '9999990002', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
        'variants', jsonb_build_array()
      )
    ),
    'teste-1-lote-valido'
  );

  IF (v_result->>'imported')::int <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 1: esperado imported=2, veio %', v_result;
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after - v_count_before <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 1: esperado +2 produtos, veio % -> %', v_count_before, v_count_after;
  END IF;

  RAISE NOTICE 'OK cenário 1: lote válido importado (% produtos)', v_result->>'imported';
END $$;

-- =============================================================================
-- Cenário 2 — falha no primeiro produto (categoria inexistente/de outra empresa)
-- =============================================================================
DO $$
DECLARE
  v_test_user_id UUID;
  v_count_before INT;
  v_count_after  INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Falha Primeiro', 'tipo', 'x', 'modelo', 'y',
          'ano', '2026', 'category_id', 999999999, 'supplier_id', NULL, 'brand_id', NULL,
          'origin', 'third_party', 'base_cost', 10, 'base_price', 20, 'active', true,
          'sku', '9999990010', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array()
        )
      ),
      'teste-2-falha-primeiro'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%Categoria%' THEN
      RAISE EXCEPTION 'FALHOU cenário 2: esperava erro de categoria, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 2: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 2: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 2: linha residual! antes=%, depois=%', v_count_before, v_count_after;
  END IF;
  RAISE NOTICE 'OK cenário 2: nenhuma linha residual';
END $$;

-- =============================================================================
-- Cenário 2b — escopo de empresa: fornecedor inexistente (não confiar em ID arbitrário)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_count_before INT;
  v_count_after  INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Fornecedor Invalido', 'tipo', 'x', 'modelo', 'y',
          'ano', '2026', 'category_id', v_category_id, 'supplier_id', 999999999, 'brand_id', NULL,
          'origin', 'third_party', 'base_cost', 10, 'base_price', 20, 'active', true,
          'sku', '9999990011', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array()
        )
      ),
      'teste-2b-fornecedor-invalido'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%Fornecedor%' THEN
      RAISE EXCEPTION 'FALHOU cenário 2b: esperava erro de fornecedor, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 2b: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 2b: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 2b: linha residual!';
  END IF;
  RAISE NOTICE 'OK cenário 2b: nenhuma linha residual';
END $$;

-- =============================================================================
-- Cenário 3 — falha no meio do lote (3º produto com categoria inválida, 1º e
-- 2º válidos) — confirma que o 1º/2º também são revertidos
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_count_before INT;
  v_count_after  INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Meio 1', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990020', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        ),
        jsonb_build_object(
          'client_index', 1, 'name', 'Teste RPC Meio 2', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990021', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        ),
        jsonb_build_object(
          'client_index', 2, 'name', 'Teste RPC Meio 3 (falha)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', 999999999, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990022', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-3-falha-no-meio'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    RAISE NOTICE 'OK cenário 3: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 3: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 3: linha residual! Os 2 primeiros produtos do lote NÃO foram revertidos (antes=%, depois=%)', v_count_before, v_count_after;
  END IF;
  RAISE NOTICE 'OK cenário 3: nenhuma linha residual (1º e 2º produtos do lote também revertidos)';
END $$;

-- =============================================================================
-- Cenário 4 — falha DEPOIS de criar estoque
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_prod_before  INT;
  v_stock_before INT;
  v_mov_before   INT;
  v_prod_after   INT;
  v_stock_after  INT;
  v_mov_after    INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_prod_before  FROM public.products;
  -- stock_balances é a fonte de verdade real desde
  -- supabase/migrations/20260610_multi_estoque.sql — a tabela "stock" foi
  -- congelada como backup legado e não recebe mais escrita de
  -- rpc_stock_initialize (ver achado de auditoria no cabeçalho da migration
  -- da RPC).
  SELECT count(*) INTO v_stock_before FROM public.stock_balances;
  SELECT count(*) INTO v_mov_before   FROM public.stock_movements;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Estoque OK', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990030', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array(
            jsonb_build_object(
              'client_index', 0, 'sku_base', '9999990030', 'color_value_id', NULL, 'color_variation_type_id', NULL,
              'size_value_id', NULL, 'size_variation_type_id', NULL,
              'cost_override', NULL, 'price_override', NULL, 'initial_stock', 15
            )
          )
        ),
        jsonb_build_object(
          'client_index', 1, 'name', 'Teste RPC Falha Depois De Estoque', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', 999999999, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990031', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-4-falha-depois-de-estoque'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    RAISE NOTICE 'OK cenário 4: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 4: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_prod_after  FROM public.products;
  SELECT count(*) INTO v_stock_after FROM public.stock_balances;
  SELECT count(*) INTO v_mov_after   FROM public.stock_movements;

  IF v_prod_after <> v_prod_before OR v_stock_after <> v_stock_before OR v_mov_after <> v_mov_before THEN
    RAISE EXCEPTION 'FALHOU cenário 4: resíduo! products %->%, stock %->%, stock_movements %->%',
      v_prod_before, v_prod_after, v_stock_before, v_stock_after, v_mov_before, v_mov_after;
  END IF;
  RAISE NOTICE 'OK cenário 4: estoque do 1º produto também revertido, nenhum resíduo';
END $$;

-- =============================================================================
-- Cenário 5 — conflito de SKU dentro do próprio lote
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_count_before INT;
  v_count_after  INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC SKU Dup 1', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990040', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        ),
        jsonb_build_object(
          'client_index', 1, 'name', 'Teste RPC SKU Dup 2', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990040', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-5-conflito-sku'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%Conflito de SKU%' THEN
      RAISE EXCEPTION 'FALHOU cenário 5: esperava erro de conflito de SKU, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 5: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 5: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 5: linha residual!';
  END IF;
  RAISE NOTICE 'OK cenário 5: nenhuma linha residual';
END $$;

-- =============================================================================
-- Cenário 6 — conflito em product_variation_attributes (payload malformado:
-- cor e tamanho apontando pro MESMO variation_type_id no mesmo variant)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_attr_type_id INT;
  v_value_a_id   INT;
  v_value_b_id   INT;
  v_count_before INT;
  v_count_after  INT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT id INTO v_attr_type_id FROM public.variation_types WHERE slug = 'teste-rpc-import-attr';
  SELECT id INTO v_value_a_id FROM public.variation_values WHERE variation_type_id = v_attr_type_id AND slug = 'teste-valor-a';
  SELECT id INTO v_value_b_id FROM public.variation_values WHERE variation_type_id = v_attr_type_id AND slug = 'teste-valor-b';
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Attr Conflito', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990050', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array(
            jsonb_build_object(
              'client_index', 0, 'sku_base', '9999990050',
              -- Payload malformado de propósito: cor e tamanho com o MESMO
              -- variation_type_id -> viola a PK composta (product_variation_id, variation_type_id)
              'color_value_id', v_value_a_id, 'color_variation_type_id', v_attr_type_id,
              'size_value_id', v_value_b_id, 'size_variation_type_id', v_attr_type_id,
              'cost_override', NULL, 'price_override', NULL, 'initial_stock', 0
            )
          )
        )
      ),
      'teste-6-conflito-attr'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    RAISE NOTICE 'OK cenário 6: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 6: deveria ter lançado exceção (violação de PK) e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 6: linha residual!';
  END IF;
  RAISE NOTICE 'OK cenário 6: nenhuma linha residual (produto+variação também revertidos)';
END $$;

-- =============================================================================
-- Cenário 6b — variation_value_id de um variation_type diferente do
-- declarado (ex.: valor de "Outro Tipo" enviado como se fosse cor)
-- =============================================================================
DO $$
DECLARE
  v_category_id     INT;
  v_test_user_id    UUID;
  v_attr_type_id    INT;
  v_outro_type_id   INT;
  v_valor_outro_id  INT;
  v_count_before    INT;
  v_count_after     INT;
  v_failed          BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT id INTO v_attr_type_id FROM public.variation_types WHERE slug = 'teste-rpc-import-attr';
  SELECT id INTO v_outro_type_id FROM public.variation_types WHERE slug = 'teste-rpc-import-attr-outro';
  SELECT id INTO v_valor_outro_id FROM public.variation_values WHERE variation_type_id = v_outro_type_id AND slug = 'teste-valor-outro-tipo';
  SELECT count(*) INTO v_count_before FROM public.products;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Attr Tipo Errado', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990051', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array(
            jsonb_build_object(
              -- v_valor_outro_id pertence a v_outro_type_id, mas é declarado
              -- aqui como se pertencesse a v_attr_type_id (cor) -> deve ser rejeitado
              'client_index', 0, 'sku_base', '9999990051',
              'color_value_id', v_valor_outro_id, 'color_variation_type_id', v_attr_type_id,
              'size_value_id', NULL, 'size_variation_type_id', NULL,
              'cost_override', NULL, 'price_override', NULL, 'initial_stock', 0
            )
          )
        )
      ),
      'teste-6b-attr-tipo-errado'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%não pertence ao variation_type_id%' THEN
      RAISE EXCEPTION 'FALHOU cenário 6b: esperava erro de tipo incoerente, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 6b: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 6b: deveria ter lançado exceção e não lançou';
  END IF;

  SELECT count(*) INTO v_count_after FROM public.products;
  IF v_count_after <> v_count_before THEN
    RAISE EXCEPTION 'FALHOU cenário 6b: linha residual!';
  END IF;
  RAISE NOTICE 'OK cenário 6b: nenhuma linha residual';
END $$;

-- =============================================================================
-- Cenário 7 — lote com produtos legacy e dynamic juntos
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_attr_type_id INT;
  v_value_a_id   INT;
  v_result       JSONB;
  v_pav_count    INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  SELECT id INTO v_attr_type_id FROM public.variation_types WHERE slug = 'teste-rpc-import-attr';
  SELECT id INTO v_value_a_id FROM public.variation_values WHERE variation_type_id = v_attr_type_id AND slug = 'teste-valor-a';

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste RPC Legacy', 'tipo', 'sutia', 'modelo', 'basico_com_bojo', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990060', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      ),
      jsonb_build_object(
        'client_index', 1, 'name', 'Teste RPC Dynamic', 'tipo', 'teste_tipo_dyn', 'modelo', 'Valor A', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990061', 'sku_scheme', 'dynamic',
        'modelo_variation_type_id', v_attr_type_id, 'modelo_value_id', v_value_a_id, 'variants', jsonb_build_array()
      )
    ),
    'teste-7-legacy-e-dynamic'
  );

  IF (v_result->>'imported')::int <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 7: esperado imported=2, veio %', v_result;
  END IF;

  SELECT count(*) INTO v_pav_count
  FROM public.product_attribute_values pav
  WHERE pav.variation_value_id = v_value_a_id;

  IF v_pav_count <> 1 THEN
    RAISE EXCEPTION 'FALHOU cenário 7: esperado exatamente 1 product_attribute_values pro produto dynamic, veio %', v_pav_count;
  END IF;

  RAISE NOTICE 'OK cenário 7: legacy e dynamic no mesmo lote, product_attribute_values só no dynamic';
END $$;

-- =============================================================================
-- Cenário 8 — estoque inicial ZERO (não deve criar stock/stock_movements)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
  v_variation_id INT;
  v_stock_count  INT;
  v_mov_count    INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste RPC Estoque Zero', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990070', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
        'variants', jsonb_build_array(
          jsonb_build_object(
            'client_index', 0, 'sku_base', '9999990070', 'color_value_id', NULL, 'color_variation_type_id', NULL,
            'size_value_id', NULL, 'size_variation_type_id', NULL,
            'cost_override', NULL, 'price_override', NULL, 'initial_stock', 0
          )
        )
      )
    ),
    'teste-8-estoque-zero'
  );

  v_variation_id := ((v_result->'products'->0->'variants'->0)->>'id')::int;

  -- stock_balances (não "stock", tabela legada congelada desde
  -- 20260610_multi_estoque.sql) é onde rpc_stock_initialize realmente escreve.
  SELECT count(*) INTO v_stock_count FROM public.stock_balances WHERE product_variation_id = v_variation_id;
  SELECT count(*) INTO v_mov_count FROM public.stock_movements WHERE product_variation_id = v_variation_id;

  IF v_stock_count <> 0 OR v_mov_count <> 0 THEN
    RAISE EXCEPTION 'FALHOU cenário 8: esperado 0 linhas em stock_balances/stock_movements pra initial_stock=0, veio stock_balances=% movements=%', v_stock_count, v_mov_count;
  END IF;
  RAISE NOTICE 'OK cenário 8: estoque inicial zero não criou stock nem stock_movements';
END $$;

-- =============================================================================
-- Cenário 9 — estoque inicial POSITIVO (deve criar stock + stock_movements)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
  v_product_id   INT;
  v_variation_id INT;
  v_stock_qty    INT;
  v_mov_type     TEXT;
  v_diag_product   RECORD;
  v_diag_variation RECORD;
  v_diag_stock_row TEXT;
  v_diag_mov_row   TEXT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste RPC Estoque Positivo', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990080', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
        'variants', jsonb_build_array(
          jsonb_build_object(
            'client_index', 0, 'sku_base', '9999990080', 'color_value_id', NULL, 'color_variation_type_id', NULL,
            'size_value_id', NULL, 'size_variation_type_id', NULL,
            'cost_override', NULL, 'price_override', NULL, 'initial_stock', 42
          )
        )
      )
    ),
    'teste-9-estoque-positivo'
  );

  v_product_id   := ((v_result->'products'->0)->>'id')::int;
  v_variation_id := ((v_result->'products'->0->'variants'->0)->>'id')::int;

  -- ─── Diagnóstico (temporário, antes do assert) ────────────────────────────
  RAISE NOTICE 'DIAG cenário 9 — JSON retornado pela RPC: %', v_result;
  RAISE NOTICE 'DIAG cenário 9 — v_product_id=%, v_variation_id=%', v_product_id, v_variation_id;

  SELECT * INTO v_diag_product FROM public.products WHERE id = v_product_id;
  RAISE NOTICE 'DIAG cenário 9 — produto criado: id=%, sku=%, sku_scheme=%, company_id=%',
    v_diag_product.id, v_diag_product.sku, v_diag_product.sku_scheme, v_diag_product.company_id;

  SELECT * INTO v_diag_variation FROM public.product_variations WHERE id = v_variation_id;
  RAISE NOTICE 'DIAG cenário 9 — variação criada: id=%, product_id=%, sku_variation=%',
    v_diag_variation.id, v_diag_variation.product_id, v_diag_variation.sku_variation;

  FOR v_diag_stock_row IN
    SELECT format('product_variation_id=%s, stock_location_id=%s, quantity=%s, avg_cost=%s',
                   product_variation_id, stock_location_id, quantity, avg_cost)
    FROM public.stock_balances WHERE product_variation_id = v_variation_id
  LOOP
    RAISE NOTICE 'DIAG cenário 9 — linha em stock_balances: %', v_diag_stock_row;
  END LOOP;

  FOR v_diag_mov_row IN
    SELECT format('type=%s, quantity=%s, destination_location_id=%s, created_by=%s',
                   type, quantity, destination_location_id, created_by)
    FROM public.stock_movements WHERE product_variation_id = v_variation_id
  LOOP
    RAISE NOTICE 'DIAG cenário 9 — linha em stock_movements: %', v_diag_mov_row;
  END LOOP;
  -- ─── Fim do diagnóstico ────────────────────────────────────────────────────

  -- stock_balances (não "stock", tabela legada congelada desde
  -- 20260610_multi_estoque.sql) é onde rpc_stock_initialize realmente
  -- escreve — achado desta investigação: 000_schema_completo.sql estava
  -- desatualizado em relação a essa migration real já aplicada.
  SELECT quantity INTO v_stock_qty FROM public.stock_balances WHERE product_variation_id = v_variation_id;
  SELECT type INTO v_mov_type FROM public.stock_movements WHERE product_variation_id = v_variation_id;

  IF v_stock_qty IS DISTINCT FROM 42 THEN
    RAISE EXCEPTION 'FALHOU cenário 9: esperado stock_balances.quantity=42, veio %', v_stock_qty;
  END IF;
  IF v_mov_type IS DISTINCT FROM 'initial' THEN
    RAISE EXCEPTION 'FALHOU cenário 9: esperado stock_movements.type=initial, veio %', v_mov_type;
  END IF;
  RAISE NOTICE 'OK cenário 9: estoque inicial positivo criou stock (qty=42) e stock_movements (initial)';
END $$;

-- =============================================================================
-- Cenário 10 — repetição do mesmo idempotency_key (não deve duplicar)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_payload      JSONB;
  v_result_1     JSONB;
  v_result_2     JSONB;
  v_count_before INT;
  v_count_after  INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_payload := jsonb_build_array(
    jsonb_build_object(
      'client_index', 0, 'name', 'Teste RPC Idempotencia', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
      'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
      'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990090', 'sku_scheme', 'legacy',
      'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
    )
  );

  SELECT count(*) INTO v_count_before FROM public.products;

  v_result_1 := public.rpc_import_products_batch(1, v_test_user_id, v_payload, 'teste-10-idempotencia-fixa');
  v_result_2 := public.rpc_import_products_batch(1, v_test_user_id, v_payload, 'teste-10-idempotencia-fixa');

  SELECT count(*) INTO v_count_after FROM public.products;

  IF v_count_after - v_count_before <> 1 THEN
    RAISE EXCEPTION 'FALHOU cenário 10: esperado +1 produto no total (2ª chamada não deveria inserir de novo), veio %->%',
      v_count_before, v_count_after;
  END IF;

  IF v_result_1 IS DISTINCT FROM v_result_2 THEN
    RAISE EXCEPTION 'FALHOU cenário 10: a 2ª chamada com a mesma idempotency_key deveria devolver o MESMO resultado. 1º=% 2º=%', v_result_1, v_result_2;
  END IF;

  RAISE NOTICE 'OK cenário 10: repetição da idempotency_key devolveu o mesmo resultado, sem duplicar produto';
END $$;

-- =============================================================================
-- Cenário 11 — usuário inexistente (UUID aleatório, nunca cadastrado)
-- =============================================================================
DO $$
DECLARE
  v_category_id INT;
  v_failed      BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, gen_random_uuid(),
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Usuario Inexistente', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990100', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-11-usuario-inexistente'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%não encontrado%' THEN
      RAISE EXCEPTION 'FALHOU cenário 11: esperava erro de usuário não encontrado, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 11: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 11: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 12 — usuário inativo (flip temporário de um usuário real existente,
-- restaurado pelo ROLLBACK final)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_borrowed_id  UUID;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_borrowed_id FROM public.users LIMIT 1;

  IF v_borrowed_id IS NULL THEN
    RAISE NOTICE 'PULADO cenário 12: nenhum usuário existe no banco pra emprestar temporariamente.';
    RETURN;
  END IF;

  UPDATE public.users SET active = false WHERE id = v_borrowed_id;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_borrowed_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Usuario Inativo', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990110', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-12-usuario-inativo'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%inativo%' THEN
      RAISE EXCEPTION 'FALHOU cenário 12: esperava erro de usuário inativo, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 12: rejeitado como esperado (%)', SQLERRM;
  END;

  UPDATE public.users SET active = true WHERE id = v_borrowed_id;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 12: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 13 — usuário de outra empresa (flip temporário)
-- =============================================================================
DO $$
DECLARE
  v_category_id      INT;
  v_borrowed_id      UUID;
  v_original_company INT;
  v_other_company_id INT;
  v_failed           BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_other_company_id FROM public.companies WHERE slug = 'teste-rpc-outra-empresa';
  SELECT id, company_id INTO v_borrowed_id, v_original_company
  FROM public.users WHERE company_id = 1 LIMIT 1;

  IF v_borrowed_id IS NULL OR v_other_company_id IS NULL THEN
    RAISE NOTICE 'PULADO cenário 13: sem usuário da empresa 1 ou sem empresa de teste pra reatribuir.';
    RETURN;
  END IF;

  UPDATE public.users SET company_id = v_other_company_id WHERE id = v_borrowed_id;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_borrowed_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Usuario Outra Empresa', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990120', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-13-usuario-outra-empresa'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%não pertence à empresa%' THEN
      RAISE EXCEPTION 'FALHOU cenário 13: esperava erro de empresa incoerente, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 13: rejeitado como esperado (%)', SQLERRM;
  END;

  UPDATE public.users SET company_id = v_original_company WHERE id = v_borrowed_id;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 13: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 14 — usuário sem permissão (role diferente de admin/gerente)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_borrowed_id  UUID;
  v_original_role TEXT;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id, role::text INTO v_borrowed_id, v_original_role
  FROM public.users WHERE company_id = 1 LIMIT 1;

  IF v_borrowed_id IS NULL THEN
    RAISE NOTICE 'PULADO cenário 14: nenhum usuário existe na empresa 1 pra emprestar temporariamente.';
    RETURN;
  END IF;

  UPDATE public.users SET role = 'seller' WHERE id = v_borrowed_id;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_borrowed_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Sem Permissao', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990130', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-14-sem-permissao'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%não tem permissão%' THEN
      RAISE EXCEPTION 'FALHOU cenário 14: esperava erro de permissão, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 14: rejeitado como esperado (%)', SQLERRM;
  END;

  UPDATE public.users SET role = v_original_role::user_role WHERE id = v_borrowed_id;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 14: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 15 — função não executável por PUBLIC/authenticated
-- =============================================================================
DO $$
DECLARE
  v_failed BOOLEAN := false;
BEGIN
  BEGIN
    SET ROLE authenticated;
    PERFORM public.rpc_import_products_batch(1, gen_random_uuid(), '[]'::jsonb, NULL);
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
    RESET ROLE;
    RAISE NOTICE 'OK cenário 15: authenticated não tem EXECUTE (%)', SQLERRM;
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE NOTICE 'PULADO cenário 15: não foi possível trocar pra role authenticated neste ambiente (%). Verifique manualmente com has_function_privilege.', SQLERRM;
    RETURN;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 15: authenticated conseguiu chamar a função — GRANT está incorreto.';
  END IF;
END $$;

-- =============================================================================
-- Cenário 16 — payload malformado: client_index de produto duplicado
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Client Index Dup 1', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990140', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        ),
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Client Index Dup 2', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990141', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-16-client-index-duplicado'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%client_index de produto duplicado%' THEN
      RAISE EXCEPTION 'FALHOU cenário 16: esperava erro de client_index duplicado, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 16: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 16: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 17 — initial_stock negativo
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_failed       BOOLEAN := false;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-rpc-import-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste RPC Estoque Negativo', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true, 'sku', '9999990150', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
          'variants', jsonb_build_array(
            jsonb_build_object(
              'client_index', 0, 'sku_base', '9999990150', 'color_value_id', NULL, 'color_variation_type_id', NULL,
              'size_value_id', NULL, 'size_variation_type_id', NULL,
              'cost_override', NULL, 'price_override', NULL, 'initial_stock', -5
            )
          )
        )
      ),
      'teste-17-estoque-negativo'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%initial_stock negativo%' THEN
      RAISE EXCEPTION 'FALHOU cenário 17: esperava erro de estoque negativo, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 17: rejeitado como esperado (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 17: deveria ter lançado exceção e não lançou';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM ==='; END $$;

ROLLBACK;
