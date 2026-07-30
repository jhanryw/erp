-- =============================================================================
-- product_sku_identity.test.sql
--
-- Script de teste FUNCIONAL para a Opção B (product_sku_identities +
-- discriminador propagado), criada em
-- supabase/migrations/202607302600_pim_product_sku_identity.sql.
-- Requer 202607302400 e 202607302600 já aplicadas.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/product_sku_identity.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo. Ver também
-- supabase/tests/rpc_import_products_batch.concurrency.md para o
-- procedimento manual de dois terminais (a lógica de lock por sku_base é
-- a mesma técnica, agora aplicada a product_sku_identities em vez de
-- product_variations).
-- =============================================================================

BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE IDENTIDADE — APAGAR', 'teste-identidade-apagar', 1, true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE EXCEPTION 'Nenhum usuário ativo gerente/admin encontrado para company_id=1 — crie um antes de rodar este script.';
  END IF;
  RAISE NOTICE 'Fixture pronta: categoria id=%, usuário de teste id=%', v_category_id, v_test_user_id;
END $$;

-- =============================================================================
-- Cenário 1 — primeiro produto de uma base: discriminator=1, SKU sem sufixo
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste Identidade Produto A', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', '9999880001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      )
    ),
    'teste-identidade-1-primeiro'
  );

  IF (v_result->'products'->0->>'discriminator')::int <> 1 THEN
    RAISE EXCEPTION 'FALHOU cenário 1: esperado discriminator=1, veio %', v_result;
  END IF;
  IF (v_result->'products'->0->>'sku') <> '9999880001' THEN
    RAISE EXCEPTION 'FALHOU cenário 1: esperado sku sem sufixo (10 dígitos), veio %', v_result->'products'->0->>'sku';
  END IF;
  RAISE NOTICE 'OK cenário 1: primeiro produto sem sufixo, discriminator=1 (%)', v_result->'products'->0->>'sku';
END $$;

-- =============================================================================
-- Cenário 2 — segundo produto colidente na MESMA base (mesmo lote): recebe
-- discriminator=2, sufixo '02', e o lote NÃO aborta (o bug original)
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste Identidade Produto B (colide com A)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', '9999880001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      ),
      jsonb_build_object(
        'client_index', 1, 'name', 'Teste Identidade Produto C (colide de novo)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', '9999880001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      )
    ),
    'teste-identidade-2-colisao-no-lote'
  );

  IF (v_result->>'imported')::int <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 2: lote com 2 produtos colidentes deveria importar os 2, veio %', v_result;
  END IF;
  IF (v_result->'products'->0->>'discriminator')::int <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 2: esperado discriminator=2 no 1º item do lote, veio %', v_result->'products'->0;
  END IF;
  IF (v_result->'products'->0->>'sku') <> '999988000102' THEN
    RAISE EXCEPTION 'FALHOU cenário 2: esperado sku ''999988000102'', veio %', v_result->'products'->0->>'sku';
  END IF;
  IF (v_result->'products'->1->>'discriminator')::int <> 3 THEN
    RAISE EXCEPTION 'FALHOU cenário 2: esperado discriminator=3 no 2º item do lote, veio %', v_result->'products'->1;
  END IF;
  IF (v_result->'products'->1->>'sku') <> '999988000103' THEN
    RAISE EXCEPTION 'FALHOU cenário 2: esperado sku ''999988000103'', veio %', v_result->'products'->1->>'sku';
  END IF;
  RAISE NOTICE 'OK cenário 2: lote com colisão não abortou — discriminator 2 e 3 atribuídos corretamente';
END $$;

-- =============================================================================
-- Cenário 3 — variantes herdam o MESMO discriminador do produto-pai, sem
-- resolvedor independente
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
  v_disc         INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste Identidade Produto D (colide, com variantes)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', '9999880001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL,
        'variants', jsonb_build_array(
          jsonb_build_object(
            'client_index', 0, 'sku_base', '9999880001', 'color_value_id', NULL, 'color_variation_type_id', NULL,
            'size_value_id', NULL, 'size_variation_type_id', NULL,
            'cost_override', NULL, 'price_override', NULL, 'initial_stock', 0
          )
        )
      )
    ),
    'teste-identidade-3-variantes-herdam'
  );

  v_disc := (v_result->'products'->0->>'discriminator')::int;
  IF v_disc <> 4 THEN
    RAISE EXCEPTION 'FALHOU cenário 3: esperado discriminator=4 (4º produto desta base), veio %', v_disc;
  END IF;

  IF (v_result->'products'->0->'variants'->0->>'sku_variation') <> ('9999880001' || lpad(v_disc::text, 2, '0')) THEN
    RAISE EXCEPTION 'FALHOU cenário 3: sku_variation deveria embutir o discriminador do pai (%), veio %',
      v_disc, v_result->'products'->0->'variants'->0->>'sku_variation';
  END IF;
  RAISE NOTICE 'OK cenário 3: variante herdou o discriminador do produto-pai (%)', v_result->'products'->0->'variants'->0->>'sku_variation';
END $$;

-- =============================================================================
-- Cenário 4 — não reutilização após exclusão física do produto
-- =============================================================================
DO $$
DECLARE
  v_category_id     INT;
  v_test_user_id    UUID;
  v_result          JSONB;
  v_product_id_b    INT;
  v_discriminator_e INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  -- Descobre o id do "Produto B" criado no cenário 2 (discriminator=2)
  SELECT product_id INTO v_product_id_b
  FROM public.product_sku_identities
  WHERE sku_base = '9999880001' AND discriminator = 2;

  IF v_product_id_b IS NULL THEN
    RAISE EXCEPTION 'FALHOU cenário 4: não encontrou o produto do discriminator=2 (setup do cenário 2 não rodou?)';
  END IF;

  -- Exclusão física real (mesmo mecanismo de deleteProductCascade)
  DELETE FROM public.product_variation_attributes
    WHERE product_variation_id IN (SELECT id FROM public.product_variations WHERE product_id = v_product_id_b);
  DELETE FROM public.product_variations WHERE product_id = v_product_id_b;
  DELETE FROM public.product_attribute_values WHERE product_id = v_product_id_b;
  DELETE FROM public.products WHERE id = v_product_id_b;

  -- Confirma que o ledger sobreviveu (linha permanece, só product_id vira NULL)
  IF NOT EXISTS (
    SELECT 1 FROM public.product_sku_identities
    WHERE sku_base = '9999880001' AND discriminator = 2 AND product_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FALHOU cenário 4: a linha do ledger (discriminator=2) deveria ter sobrevivido à exclusão física, com product_id=NULL';
  END IF;
  RAISE NOTICE 'OK cenário 4a: ledger sobrevive à exclusão física do produto (product_id virou NULL, linha permanece)';

  -- Cria um NOVO produto colidente na MESMA base — não deve reciclar
  -- discriminator=2 (o slot "liberado" pela exclusão)
  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste Identidade Produto E (pós-exclusao)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', '9999880001', 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      )
    ),
    'teste-identidade-4-pos-exclusao'
  );

  v_discriminator_e := (v_result->'products'->0->>'discriminator')::int;
  IF v_discriminator_e = 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 4b: discriminator=2 foi RECICLADO após a exclusão física — não deveria!';
  END IF;
  IF v_discriminator_e <> 5 THEN
    RAISE EXCEPTION 'FALHOU cenário 4b: esperado discriminator=5 (próximo do ledger, ignorando o slot 2 liberado), veio %', v_discriminator_e;
  END IF;
  RAISE NOTICE 'OK cenário 4b: novo produto recebeu discriminator=% (não reciclou o 2, liberado pela exclusão)', v_discriminator_e;
END $$;

-- =============================================================================
-- Cenário 5 — exaustão: erro explícito ao tentar passar de 99
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_failed       BOOLEAN := false;
  i              INT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  -- Povoa o ledger diretamente até discriminator=99 pra esta base de teste
  -- (sem passar pela RPC — só testando o limite do resolvedor)
  FOR i IN 6..99 LOOP
    INSERT INTO public.product_sku_identities (sku_base, discriminator, company_id, product_id)
    VALUES ('9999880001', i, 1, NULL)
    ON CONFLICT (sku_base, discriminator) DO NOTHING;
  END LOOP;

  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(
        jsonb_build_object(
          'client_index', 0, 'name', 'Teste Identidade Produto 100', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
          'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
          'base_cost', 10, 'base_price', 20, 'active', true,
          'sku_base', '9999880001', 'sku_scheme', 'legacy',
          'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
        )
      ),
      'teste-identidade-5-exaustao'
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    IF SQLERRM NOT LIKE '%Limite de 99 produtos%' THEN
      RAISE EXCEPTION 'FALHOU cenário 5: esperava erro de limite de 99, veio: %', SQLERRM;
    END IF;
    RAISE NOTICE 'OK cenário 5: rejeitado como esperado ao tentar passar de 99 (%)', SQLERRM;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 5: deveria ter lançado exceção ao exceder 99 e não lançou';
  END IF;
END $$;

-- =============================================================================
-- Cenário 6 — rpc_create_product (cadastro manual): funciona isoladamente
-- =============================================================================
DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  v_result := public.rpc_create_product(
    1, v_test_user_id,
    jsonb_build_object(
      'client_index', 0, 'name', 'Teste Identidade Cadastro Manual', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
      'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
      'base_cost', 10, 'base_price', 20, 'active', true,
      'sku_base', '9999880002', 'sku_scheme', 'legacy',
      'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
    )
  );

  IF (v_result->>'discriminator')::int <> 1 THEN
    RAISE EXCEPTION 'FALHOU cenário 6: esperado discriminator=1 pro primeiro produto desta base via rpc_create_product, veio %', v_result;
  END IF;
  IF (v_result->>'sku') <> '9999880002' THEN
    RAISE EXCEPTION 'FALHOU cenário 6: esperado sku sem sufixo, veio %', v_result->>'sku';
  END IF;

  -- Um segundo, colidente, via rpc_create_product de novo — recebe discriminator=2
  v_result := public.rpc_create_product(
    1, v_test_user_id,
    jsonb_build_object(
      'client_index', 0, 'name', 'Teste Identidade Cadastro Manual 2 (colide)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
      'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
      'base_cost', 10, 'base_price', 20, 'active', true,
      'sku_base', '9999880002', 'sku_scheme', 'legacy',
      'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
    )
  );

  IF (v_result->>'discriminator')::int <> 2 THEN
    RAISE EXCEPTION 'FALHOU cenário 6: esperado discriminator=2 pro segundo produto colidente via rpc_create_product, veio %', v_result;
  END IF;
  RAISE NOTICE 'OK cenário 6: rpc_create_product resolve identidade corretamente (1º sem sufixo, 2º com discriminator=2)';
END $$;

-- =============================================================================
-- Cenário 7 — helpers privados não são executáveis por PUBLIC/authenticated
-- =============================================================================
DO $$
DECLARE
  v_failed BOOLEAN := false;
BEGIN
  BEGIN
    SET ROLE authenticated;
    PERFORM public._resolve_product_sku_identity('0000000000', 1);
    RESET ROLE;
  EXCEPTION WHEN insufficient_privilege THEN
    v_failed := true;
    RESET ROLE;
    RAISE NOTICE 'OK cenário 7: authenticated não tem EXECUTE em _resolve_product_sku_identity (%)', SQLERRM;
  WHEN OTHERS THEN
    RESET ROLE;
    RAISE NOTICE 'PULADO cenário 7: não foi possível trocar pra role authenticated neste ambiente (%). Verifique manualmente com has_function_privilege/aclexplode.', SQLERRM;
    RETURN;
  END;

  IF NOT v_failed THEN
    RAISE EXCEPTION 'FALHOU cenário 7: authenticated conseguiu chamar a helper privada — GRANT está incorreto.';
  END IF;
END $$;

-- =============================================================================
-- Cenário 8 — base histórica com múltiplos produtos (simula o cenário real
-- relatado: até 44 produtos compartilhando o mesmo sku, cada cor cadastrada
-- como produto separado) — confirma que o backfill (aqui simulado
-- manualmente, já que a migration já rodou antes deste script) enumera
-- 1..N corretamente e que o PRÓXIMO produto novo recebe N+1.
-- =============================================================================
DO $$
DECLARE
  v_category_id   INT;
  v_test_user_id  UUID;
  v_result        JSONB;
  v_hist_sku      TEXT := '9999770001';
  v_hist_count    INT  := 5; -- base histórica menor pra teste rápido; a lógica é a mesma pra 44
  i               INT;
  v_new_product_id INT;
  v_new_identity_id BIGINT;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-identidade-apagar';
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;

  -- Simula N produtos "históricos" com o MESMO sku, inseridos diretamente
  -- (como o sistema antigo fazia, sem passar pela RPC) — created_at
  -- crescente pra ordem determinística.
  FOR i IN 1..v_hist_count LOOP
    INSERT INTO public.products (
      name, tipo, modelo, ano, category_id, origin, base_cost, base_price,
      active, sku, sku_scheme, company_id, created_at
    ) VALUES (
      format('Teste Historico Cor %s', i), 'x', 'y', '2026', v_category_id, 'third_party',
      10, 20, true, v_hist_sku, 'legacy', 1, NOW() - (v_hist_count - i) * INTERVAL '1 day'
    );
  END LOOP;

  -- Simula o backfill (ROW_NUMBER por created_at) pra esta base específica
  -- — mesma lógica da PARTE 4 da migration, aplicada só a este grupo de teste.
  WITH ranked AS (
    SELECT id, sku, company_id,
           ROW_NUMBER() OVER (PARTITION BY sku ORDER BY created_at NULLS LAST, id) AS discriminator
    FROM public.products
    WHERE sku = v_hist_sku
  )
  INSERT INTO public.product_sku_identities (sku_base, discriminator, company_id, product_id)
  SELECT sku, discriminator, company_id, id FROM ranked
  ON CONFLICT (sku_base, discriminator) DO NOTHING;

  UPDATE public.products p
  SET sku_identity_id = psi.id
  FROM public.product_sku_identities psi
  WHERE psi.product_id = p.id AND p.sku = v_hist_sku AND p.sku_identity_id IS NULL;

  -- Confirma que o "backfill simulado" enumerou 1..N sem gaps e sem
  -- alterar nenhum sku histórico
  IF (SELECT max(discriminator) FROM public.product_sku_identities WHERE sku_base = v_hist_sku) <> v_hist_count THEN
    RAISE EXCEPTION 'FALHOU cenário 8: esperado max(discriminator)=% pra base histórica, veio %',
      v_hist_count, (SELECT max(discriminator) FROM public.product_sku_identities WHERE sku_base = v_hist_sku);
  END IF;
  IF (SELECT count(*) FROM public.products WHERE sku = v_hist_sku) <> v_hist_count THEN
    RAISE EXCEPTION 'FALHOU cenário 8: algum sku histórico foi alterado pelo backfill simulado';
  END IF;
  RAISE NOTICE 'OK cenário 8a: base histórica com % produtos enumerada 1..% sem gaps, nenhum sku alterado', v_hist_count, v_hist_count;

  -- O PRÓXIMO produto novo desta base (via RPC de verdade) deve receber N+1
  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(
      jsonb_build_object(
        'client_index', 0, 'name', 'Teste Historico Cor Nova (pos-backfill)', 'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id, 'supplier_id', NULL, 'brand_id', NULL, 'origin', 'third_party',
        'base_cost', 10, 'base_price', 20, 'active', true,
        'sku_base', v_hist_sku, 'sku_scheme', 'legacy',
        'modelo_variation_type_id', NULL, 'modelo_value_id', NULL, 'variants', jsonb_build_array()
      )
    ),
    'teste-identidade-8-pos-historico'
  );

  IF (v_result->'products'->0->>'discriminator')::int <> v_hist_count + 1 THEN
    RAISE EXCEPTION 'FALHOU cenário 8b: esperado discriminator=% (N+1) pro produto novo, veio %',
      v_hist_count + 1, v_result->'products'->0->>'discriminator';
  END IF;

  v_new_product_id := (v_result->'products'->0->>'id')::int;
  SELECT sku_identity_id INTO v_new_identity_id FROM public.products WHERE id = v_new_product_id;
  IF v_new_identity_id IS NULL THEN
    RAISE EXCEPTION 'FALHOU cenário 8b: produto novo criado sem sku_identity_id preenchido.';
  END IF;

  RAISE NOTICE 'OK cenário 8b: produto novo após base histórica de % recebeu discriminator=% (N+1), sku_identity_id preenchido',
    v_hist_count, v_hist_count + 1;
END $$;

DO $$ BEGIN RAISE NOTICE '=== TODOS OS CENÁRIOS DE IDENTIDADE PASSARAM ==='; END $$;

ROLLBACK;
