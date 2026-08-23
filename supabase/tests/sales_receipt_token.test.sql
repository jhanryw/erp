-- =============================================================================
-- sales_receipt_token.test.sql
--
-- Valida supabase/migrations/20260830_sales_receipt_token.sql (comprovante
-- não fiscal / trocas):
--   1. Toda venda nova recebe receipt_token automaticamente (via DEFAULT na
--      coluna — nenhuma mudança em rpc_create_sale foi necessária).
--   2. Tokens são únicos entre vendas diferentes.
--   3. Token não é derivado/previsível a partir de sale_id (é um UUID v4,
--      formato validado — não fica em nenhuma relação aritmética simples com id).
--   4. Uma venda "histórica" (simulada aqui — coluna temporariamente NULL
--      dentro da transação de teste) recebe token corretamente ao rodar a
--      MESMA instrução de backfill usada na migration (Passo 2), sem alterar
--      nenhuma outra coluna da venda (subtotal/total/estoque/status).
--   5. Imutabilidade: tentar alterar receipt_token de uma venda existente
--      falha (trigger).
--
-- COMO RODAR (ambiente de TESTE, DEPOIS de aplicar
-- 20260830_sales_receipt_token.sql, nunca em produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sales_receipt_token.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_main_store_id int;
  v_user           uuid;
  v_category_id    int;
  v_product_id     int;
  v_variation      int;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO (todos os cenários): empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = 1 AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO (todos os cenários): nenhum usuário ativo na empresa 1.';
    RETURN;
  END IF;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Receipt Token — APAGAR', 'teste-receipt-token-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-receipt-token-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Receipt Token', 'TESTE-RT-0001', v_category_id, 1, 'x', 'y', '2026', 10, 30, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-RT-0001-V1', true)
  RETURNING id INTO v_variation;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation, v_main_store_id, 20, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 20;

  CREATE TEMP TABLE receipt_token_fixture (variation int, user_id uuid);
  INSERT INTO receipt_token_fixture VALUES (v_variation, v_user);
END $$;


-- =============================================================================
-- Cenário 1 — venda nova recebe receipt_token automaticamente, formato UUID
-- =============================================================================
SAVEPOINT cenario_1;

DO $$
DECLARE
  v_variation int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_token uuid;
BEGIN
  SELECT variation, user_id INTO v_variation, v_user FROM receipt_token_fixture;
  IF v_variation IS NULL THEN RETURN; END IF;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 1 — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT receipt_token INTO v_token FROM public.sales WHERE id = v_sale_id;

  IF v_token IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 1: venda criada por rpc_create_sale sem receipt_token — DEFAULT da coluna não disparou.';
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (venda nova recebe receipt_token automaticamente: %)', v_token;
END $$;

ROLLBACK TO SAVEPOINT cenario_1;


-- =============================================================================
-- Cenário 2 — tokens são únicos entre vendas diferentes (mesmo item/usuário)
-- =============================================================================
SAVEPOINT cenario_2;

DO $$
DECLARE
  v_variation int; v_user uuid;
  v_sale_result jsonb;
  v_token_a uuid; v_token_b uuid;
BEGIN
  SELECT variation, user_id INTO v_variation, v_user FROM receipt_token_fixture;
  IF v_variation IS NULL THEN RETURN; END IF;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 2a — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  SELECT receipt_token INTO v_token_a FROM public.sales WHERE id = (v_sale_result->>'id')::int;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 2b — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  SELECT receipt_token INTO v_token_b FROM public.sales WHERE id = (v_sale_result->>'id')::int;

  IF v_token_a = v_token_b THEN
    RAISE EXCEPTION 'FALHA Cenário 2: duas vendas diferentes receberam o MESMO receipt_token (%).', v_token_a;
  END IF;

  RAISE NOTICE 'OK — Cenário 2 (tokens únicos entre vendas: % <> %)', v_token_a, v_token_b;
END $$;

ROLLBACK TO SAVEPOINT cenario_2;


-- =============================================================================
-- Cenário 3 — token não é derivado/previsível a partir de sale_id
-- =============================================================================
SAVEPOINT cenario_3;

DO $$
DECLARE
  v_variation int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_token uuid;
BEGIN
  SELECT variation, user_id INTO v_variation, v_user FROM receipt_token_fixture;
  IF v_variation IS NULL THEN RETURN; END IF;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 3 — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;
  SELECT receipt_token INTO v_token FROM public.sales WHERE id = v_sale_id;

  -- Formato UUID v4 real (16 bytes aleatórios, não um valor derivado de v_sale_id
  -- como zero-padding/hash simples) — checagem de formato via regex, e checagem
  -- de que o token NÃO contém o sale_id como substring óbvia (sanity check
  -- contra uma implementação ingênua tipo "id || preenchimento").
  IF v_token::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'FALHA Cenário 3: receipt_token (%) não tem formato de UUID v4 válido.', v_token;
  END IF;
  IF v_token::text LIKE '%' || v_sale_id::text || '%' THEN
    RAISE EXCEPTION 'FALHA Cenário 3: receipt_token (%) contém o sale_id (%) como substring — não deveria ser derivável.', v_token, v_sale_id;
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (token é UUID v4 real, sem relação óbvia com sale_id=%)', v_sale_id;
END $$;

ROLLBACK TO SAVEPOINT cenario_3;


-- =============================================================================
-- Cenário 4 — backfill histórico: venda "sem token" (simulada) recebe token
-- ao rodar a MESMA instrução de UPDATE da migration, sem tocar em mais nada.
-- =============================================================================
SAVEPOINT cenario_4;

DO $$
DECLARE
  v_variation int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_subtotal_antes numeric; v_total_antes numeric; v_status_antes text;
  v_token_depois uuid;
BEGIN
  SELECT variation, user_id INTO v_variation, v_user FROM receipt_token_fixture;
  IF v_variation IS NULL THEN RETURN; END IF;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 4 (backfill) — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  -- Simula uma venda "pré-migration": remove a constraint NOT NULL só dentro
  -- desta transação de teste (ROLLBACK no fim desfaz), zera o token.
  ALTER TABLE public.sales ALTER COLUMN receipt_token DROP NOT NULL;
  UPDATE public.sales SET receipt_token = NULL WHERE id = v_sale_id;

  SELECT subtotal, total, status INTO v_subtotal_antes, v_total_antes, v_status_antes
  FROM public.sales WHERE id = v_sale_id;

  -- Exatamente a instrução do Passo 2 da migration.
  UPDATE public.sales
  SET receipt_token = gen_random_uuid()
  WHERE receipt_token IS NULL AND id = v_sale_id;

  SELECT receipt_token INTO v_token_depois FROM public.sales WHERE id = v_sale_id;

  IF v_token_depois IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 4: backfill não preencheu receipt_token da venda histórica simulada.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales
    WHERE id = v_sale_id
      AND (subtotal <> v_subtotal_antes OR total <> v_total_antes OR status <> v_status_antes)
  ) THEN
    RAISE EXCEPTION 'FALHA Cenário 4: backfill alterou subtotal/total/status da venda — deveria tocar SOMENTE receipt_token.';
  END IF;

  RAISE NOTICE 'OK — Cenário 4 (backfill preenche receipt_token de venda histórica sem alterar mais nada)';
END $$;

ROLLBACK TO SAVEPOINT cenario_4;


-- =============================================================================
-- Cenário 5 — imutabilidade: alterar receipt_token de venda existente falha
-- =============================================================================
SAVEPOINT cenario_5;

DO $$
DECLARE
  v_variation int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_caught boolean := false;
BEGIN
  SELECT variation, user_id INTO v_variation, v_user FROM receipt_token_fixture;
  IF v_variation IS NULL THEN RETURN; END IF;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste receipt token cenario 5 (imutavel) — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10, 'discount_amount', 0)),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  BEGIN
    UPDATE public.sales SET receipt_token = gen_random_uuid() WHERE id = v_sale_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%receipt_token é imutável%' THEN
      v_caught := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 5: alterar receipt_token de venda existente deveria falhar (trigger de imutabilidade) e não falhou.';
  END IF;

  RAISE NOTICE 'OK — Cenário 5 (receipt_token é imutável — trigger bloqueia alteração)';
END $$;

ROLLBACK TO SAVEPOINT cenario_5;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM (ou foram pulados por falta de pré-requisito de ambiente) ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO, inclusive o
-- ALTER TABLE ... DROP NOT NULL do Cenário 4).
-- =============================================================================
