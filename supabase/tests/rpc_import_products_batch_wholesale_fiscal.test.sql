-- =============================================================================
-- rpc_import_products_batch_wholesale_fiscal.test.sql
--
-- Fundação varejo/atacado (2026-08-31) — prova que
-- _persist_single_product/rpc_import_products_batch (revisadas em
-- supabase/migrations/202608311203_import_products_wholesale_fiscal_fields.sql)
-- persistem corretamente os campos novos e opcionais: products.wholesale_price,
-- products.ncm, products.origem, products.cst,
-- product_variations.wholesale_price_override.
--
-- Mesmo padrão de fixture/execução de rpc_import_products_batch.test.sql —
-- roda dentro de BEGIN...ROLLBACK, não é destrutivo.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_import_products_batch_wholesale_fiscal.test.sql
-- =============================================================================

BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE Import Atacado — APAGAR', 'teste-import-atacado-apagar', 1, true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id  INT;
  v_test_user_id UUID;
  v_result       JSONB;
  v_product_id   INT;
  v_variation_id INT;
  v_wholesale_price NUMERIC;
  v_ncm          TEXT;
  v_origem       SMALLINT;
  v_cst          TEXT;
  v_wholesale_override NUMERIC;
  v_base_price   NUMERIC;
  v_base_cost    NUMERIC;
  v_price_override NUMERIC;
BEGIN
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-import-atacado-apagar';

  SELECT id INTO v_test_user_id
  FROM public.users
  WHERE company_id = 1 AND role IN ('admin', 'gerente') AND active = true
  LIMIT 1;

  IF v_test_user_id IS NULL THEN
    RAISE EXCEPTION 'Nenhum usuário ativo admin/gerente encontrado para company_id=1.';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- CENÁRIO 1 — produto com wholesale_price/ncm/origem/cst + 1 variante
  -- com wholesale_price_override diferente do produto-pai
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object(
      'client_index', 0,
      'name', 'Produto Teste Import Atacado',
      'tipo', 'x', 'modelo', 'y', 'ano', '2026',
      'category_id', v_category_id,
      'supplier_id', NULL, 'brand_id', NULL,
      'origin', 'third_party',
      'base_cost', 10, 'base_price', 50,
      'active', true,
      'sku_base', 'TESTE-IMPORT-ATACADO-0001',
      'sku_scheme', 'legacy',
      'wholesale_price', 35,
      'ncm', '61091000',
      'origem', 0,
      'cst', '060',
      'variants', jsonb_build_array(jsonb_build_object(
        'client_index', 0,
        'sku_base', 'TESTE-IMPORT-ATACADO-0001-V1',
        'wholesale_price_override', 30,
        'initial_stock', 0
      ))
    )),
    NULL
  );

  v_product_id := ((v_result->'products'->0)->>'id')::int;
  SELECT (v_result->'products'->0->'variants'->0->>'id')::int INTO v_variation_id;

  SELECT wholesale_price, ncm, origem, cst INTO v_wholesale_price, v_ncm, v_origem, v_cst
  FROM public.products WHERE id = v_product_id;

  IF v_wholesale_price IS DISTINCT FROM 35 THEN
    RAISE EXCEPTION 'FALHA (cenário 1): esperado wholesale_price=35, veio %.', v_wholesale_price;
  END IF;
  IF v_ncm IS DISTINCT FROM '61091000' THEN
    RAISE EXCEPTION 'FALHA (cenário 1): esperado ncm=61091000, veio %.', v_ncm;
  END IF;
  IF v_origem IS DISTINCT FROM 0::smallint THEN
    RAISE EXCEPTION 'FALHA (cenário 1): esperado origem=0, veio %.', v_origem;
  END IF;
  IF v_cst IS DISTINCT FROM '060' THEN
    RAISE EXCEPTION 'FALHA (cenário 1): esperado cst=060, veio %.', v_cst;
  END IF;

  SELECT wholesale_price_override, price_override INTO v_wholesale_override, v_price_override
  FROM public.product_variations WHERE id = v_variation_id;
  IF v_wholesale_override IS DISTINCT FROM 30 THEN
    RAISE EXCEPTION 'FALHA (cenário 1): esperado wholesale_price_override=30, veio %.', v_wholesale_override;
  END IF;
  IF v_price_override IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA (cenário 1): definir wholesale_price_override não deveria gravar price_override (varejo) nenhum, veio %.', v_price_override;
  END IF;

  -- Preço/custo de VAREJO do produto-pai continuam intactos — gravar
  -- wholesale_price nunca deve alterar base_price/base_cost.
  SELECT base_price, base_cost INTO v_base_price, v_base_cost FROM public.products WHERE id = v_product_id;
  IF v_base_price IS DISTINCT FROM 50 THEN
    RAISE EXCEPTION 'FALHA (cenário 1): base_price (varejo) deveria continuar 50, veio %.', v_base_price;
  END IF;
  IF v_base_cost IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'FALHA (cenário 1): base_cost deveria continuar 10, veio %.', v_base_cost;
  END IF;

  RAISE NOTICE 'OK (cenário 1): wholesale_price/ncm/origem/cst do produto e wholesale_price_override da variante persistem corretamente, sem alterar base_price/base_cost/price_override (varejo).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- CENÁRIO 2 — produto sem nenhum dos campos novos continua funcionando
  -- exatamente como antes (retrocompatibilidade — CSV antigo sem essas
  -- colunas não deve quebrar nem gerar erro).
  -- ═══════════════════════════════════════════════════════════════════════
  v_result := public.rpc_import_products_batch(
    1, v_test_user_id,
    jsonb_build_array(jsonb_build_object(
      'client_index', 0,
      'name', 'Produto Teste Import Sem Atacado',
      'tipo', 'x', 'modelo', 'y', 'ano', '2026',
      'category_id', v_category_id,
      'origin', 'third_party',
      'base_cost', 10, 'base_price', 50,
      'active', true,
      'sku_base', 'TESTE-IMPORT-SEMATACADO-0001',
      'sku_scheme', 'legacy',
      'variants', '[]'::jsonb
    )),
    NULL
  );
  v_product_id := ((v_result->'products'->0)->>'id')::int;

  SELECT wholesale_price, ncm, origem, cst INTO v_wholesale_price, v_ncm, v_origem, v_cst
  FROM public.products WHERE id = v_product_id;
  IF v_wholesale_price IS NOT NULL OR v_ncm IS NOT NULL OR v_origem IS NOT NULL OR v_cst IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA (cenário 2): produto sem os campos novos deveria persistir tudo NULL, veio wholesale_price=%, ncm=%, origem=%, cst=%.',
      v_wholesale_price, v_ncm, v_origem, v_cst;
  END IF;
  RAISE NOTICE 'OK (cenário 2): payload sem os campos novos (CSV antigo) continua funcionando, tudo NULL.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- CENÁRIO 3 — wholesale_price <= 0 é rejeitado (mesma regra de base_price)
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rpc_import_products_batch(
      1, v_test_user_id,
      jsonb_build_array(jsonb_build_object(
        'client_index', 0,
        'name', 'Produto Teste Import Wholesale Inválido',
        'tipo', 'x', 'modelo', 'y', 'ano', '2026',
        'category_id', v_category_id,
        'origin', 'third_party',
        'base_cost', 10, 'base_price', 50,
        'active', true,
        'sku_base', 'TESTE-IMPORT-WHOLESALE-INVALIDO-0001',
        'sku_scheme', 'legacy',
        'wholesale_price', -5,
        'variants', '[]'::jsonb
      )),
      NULL
    );
    RAISE EXCEPTION 'FALHA (cenário 3): wholesale_price negativo deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%wholesale_price deve ser maior que zero%' THEN
        RAISE NOTICE 'OK (cenário 3): wholesale_price inválido corretamente rejeitado (%).', SQLERRM;
      ELSE
        RAISE;
      END IF;
  END;

  RAISE NOTICE 'rpc_import_products_batch_wholesale_fiscal.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
