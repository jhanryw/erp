-- =============================================================================
-- rpc_create_sale_pricing_invariants.test.sql
--
-- Valida as invariantes de precificação da Fase Fiscal 5C, introduzidas em
-- supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql:
--
--   1. `sale_items.list_price_snapshot`/`surcharge_amount` são persistidos
--      quando presentes no JSON do item, e `total_price` passa a somar
--      `+ surcharge_amount` (simétrico a `- discount_amount`).
--   2. `sales.products_total` volta a ser gravado (regressão desde
--      20260614 corrigida) com a fórmula DEFINITIVA (pós-Blocker 2)
--      `subtotal - sales.discount_amount + sales.surcharge_amount` (ambos
--      de nível de PEDIDO) — e NUNCA inclui `shipping_charged`, mesmo
--      quando o frete é maior que o valor de mercadoria.
--   3. Ajuste por item (já embutido em `unit_price`/`discount_amount`/
--      `surcharge_amount` do item) e ajuste de pedido (`discount_amount`/
--      `surcharge_amount` de `sales`) não se sobrepõem — cada um só é
--      somado UMA vez, em qualquer combinação (desconto+desconto,
--      acréscimo+acréscimo, ou os dois simultâneos).
--   4. Retrocompatibilidade: item SEM `list_price_snapshot`/
--      `surcharge_amount` no JSON continua funcionando exatamente como
--      antes desta fase (list_price_snapshot NULL, surcharge 0).
--   5. (Cenário 5, novo) `sales.surcharge_amount` (acréscimo GLOBAL de
--      mercadoria) soma corretamente em `products_total` — cenário
--      LITERAL do pedido: produtos R$80 + acréscimo global R$8 = 88,
--      frete R$12 fica de fora, total financeiro R$100.
--
-- Mesmo padrão de fixture de integration_outbox_sale_events.test.sql —
-- reaproveita empresa 1 (Santtorini) e seu "Estoque Loja" já configurado.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_pricing_invariants.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_category_id     INT;
  v_test_user_id    UUID;
  v_main_store_id   INT;
  v_product_id      INT;
  v_variation_a     INT;
  v_variation_b     INT;
  v_sale_result     JSONB;
  v_sale_id         INT;
  v_sale            RECORD;
  v_item_a          RECORD;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO: empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente.';
    RETURN;
  END IF;

  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo admin/gerente encontrado na empresa 1.';
    RETURN;
  END IF;

  -- ─── Fixture: categoria + 2 produtos/variações + estoque ─────────────────
  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Pricing 5C — APAGAR', 'teste-pricing-5c-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-pricing-5c-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Pricing A', 'TESTE-PRICING-5C-A', v_category_id, 1, 'x', 'y', '2026', 20, 40, true)
  RETURNING id INTO v_product_id;
  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-PRICING-5C-A-V1', true)
  RETURNING id INTO v_variation_a;
  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_a, v_main_store_id, 10, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 10;

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Pricing B', 'TESTE-PRICING-5C-B', v_category_id, 1, 'x', 'y', '2026', 15, 40, true)
  RETURNING id INTO v_product_id;
  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-PRICING-5C-B-V1', true)
  RETURNING id INTO v_variation_b;
  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_b, v_main_store_id, 10, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 10;

  RAISE NOTICE 'Fixture: variation_a=%, variation_b=%', v_variation_a, v_variation_b;
  CREATE TEMP TABLE pricing_test_fixture (variation_a int, variation_b int, user_id uuid);
  INSERT INTO pricing_test_fixture VALUES (v_variation_a, v_variation_b, v_test_user_id);
END $$;


-- =============================================================================
-- Cenário 1 — exemplo do pedido: Produto A tabela 40 → vendido 45 (acréscimo
-- implícito), Produto B tabela 40 → vendido 43 (acréscimo implícito).
-- subtotal = 88, sem ajuste de pedido → products_total = 88.
-- shipping_charged = 12 é enviado mas NUNCA deve aparecer em products_total.
-- =============================================================================
SAVEPOINT cenario_1;

DO $$
DECLARE
  v_a  int; v_b int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_sale record;
BEGIN
  SELECT variation_a, variation_b, user_id INTO v_a, v_b, v_user FROM pricing_test_fixture;

  v_sale_result := public.rpc_create_sale(
    p_customer_id      => NULL,
    p_seller_id        => NULL,
    p_payment_method   => 'pix',
    p_sale_origin      => 'store',
    p_discount_amount  => 0,
    p_cashback_used    => 0,
    p_shipping_charged => 12,
    p_notes            => 'teste cenario 1 — apagar',
    p_items            => jsonb_build_array(
      jsonb_build_object('product_variation_id', v_a, 'quantity', 1, 'unit_price', 45, 'unit_cost', 20, 'discount_amount', 0, 'list_price_snapshot', 40),
      jsonb_build_object('product_variation_id', v_b, 'quantity', 1, 'unit_price', 43, 'unit_cost', 15, 'discount_amount', 0, 'list_price_snapshot', 40)
    ),
    p_system_user_id   => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT subtotal, discount_amount, shipping_charged, products_total, total INTO v_sale
  FROM public.sales WHERE id = v_sale_id;

  IF v_sale.subtotal <> 88 THEN
    RAISE EXCEPTION 'FALHA Cenário 1: subtotal esperado 88, veio %.', v_sale.subtotal;
  END IF;
  IF v_sale.products_total <> 88 THEN
    RAISE EXCEPTION 'FALHA Cenário 1: products_total esperado 88 (mercadoria, SEM frete), veio %.', v_sale.products_total;
  END IF;
  IF v_sale.total <> 100 THEN
    RAISE EXCEPTION 'FALHA Cenário 1: total financeiro esperado 100 (88 mercadoria + 12 frete), veio %.', v_sale.total;
  END IF;
  IF v_sale.total - v_sale.products_total <> v_sale.shipping_charged THEN
    RAISE EXCEPTION 'FALHA Cenário 1: diferença entre total e products_total deveria ser exatamente o frete.';
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (products_total=88 exclui frete de R$12; total financeiro=100)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1;


-- =============================================================================
-- Cenário 2 — desconto individual do item + desconto de PEDIDO não se
-- sobrepõem: item vendido com desconto já embutido (unit_price 35, tabela
-- 40) + desconto de pedido adicional de R$5 (sem origem por item).
-- subtotal = 35. products_total = 35 - 5 = 30 (nunca 35 - 5 - 5 = 25).
-- =============================================================================
SAVEPOINT cenario_2;

DO $$
DECLARE
  v_a  int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_sale record;
BEGIN
  SELECT variation_a, user_id INTO v_a, v_user FROM pricing_test_fixture;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store',
    5,  -- p_discount_amount (nível de pedido)
    0, 0, 'teste cenario 2 — apagar',
    jsonb_build_array(
      jsonb_build_object('product_variation_id', v_a, 'quantity', 1, 'unit_price', 35, 'unit_cost', 20, 'discount_amount', 0, 'list_price_snapshot', 40)
    ),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT subtotal, discount_amount, products_total INTO v_sale
  FROM public.sales WHERE id = v_sale_id;

  IF v_sale.subtotal <> 35 THEN
    RAISE EXCEPTION 'FALHA Cenário 2: subtotal esperado 35, veio %.', v_sale.subtotal;
  END IF;
  IF v_sale.products_total <> 30 THEN
    RAISE EXCEPTION 'FALHA Cenário 2: products_total esperado 30 (35 - 5, desconto de pedido aplicado UMA vez), veio % — possível dupla contagem.', v_sale.products_total;
  END IF;

  RAISE NOTICE 'OK — Cenário 2 (ajuste por item + ajuste de pedido somados uma vez cada, sem dupla contagem)';
END $$;

ROLLBACK TO SAVEPOINT cenario_2;


-- =============================================================================
-- Cenário 3 — surcharge_amount e list_price_snapshot persistidos em
-- sale_items; total_price soma o surcharge corretamente.
-- =============================================================================
SAVEPOINT cenario_3;

DO $$
DECLARE
  v_a  int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_item record;
BEGIN
  SELECT variation_a, user_id INTO v_a, v_user FROM pricing_test_fixture;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste cenario 3 — apagar',
    jsonb_build_array(
      jsonb_build_object('product_variation_id', v_a, 'quantity', 2, 'unit_price', 40, 'unit_cost', 20, 'discount_amount', 3, 'surcharge_amount', 7, 'list_price_snapshot', 40)
    ),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT unit_price, discount_amount, surcharge_amount, list_price_snapshot, total_price INTO v_item
  FROM public.sale_items WHERE sale_id = v_sale_id;

  -- total_price = (40*2) - 3 + 7 = 84
  IF v_item.total_price <> 84 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: total_price esperado 84, veio %.', v_item.total_price;
  END IF;
  IF v_item.surcharge_amount <> 7 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: surcharge_amount esperado 7, veio %.', v_item.surcharge_amount;
  END IF;
  IF v_item.list_price_snapshot <> 40 THEN
    RAISE EXCEPTION 'FALHA Cenário 3: list_price_snapshot esperado 40, veio %.', v_item.list_price_snapshot;
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (surcharge_amount/list_price_snapshot persistidos, total_price correto)';
END $$;

ROLLBACK TO SAVEPOINT cenario_3;


-- =============================================================================
-- Cenário 4 — retrocompatibilidade: item SEM list_price_snapshot/
-- surcharge_amount no JSON (caller antigo) → comportamento idêntico ao
-- anterior a esta fase (list_price_snapshot NULL, surcharge 0).
-- =============================================================================
SAVEPOINT cenario_4;

DO $$
DECLARE
  v_a  int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_item record;
BEGIN
  SELECT variation_a, user_id INTO v_a, v_user FROM pricing_test_fixture;

  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'teste cenario 4 — apagar',
    jsonb_build_array(
      jsonb_build_object('product_variation_id', v_a, 'quantity', 1, 'unit_price', 40, 'unit_cost', 20, 'discount_amount', 0)
    ),
    v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT surcharge_amount, list_price_snapshot, total_price INTO v_item
  FROM public.sale_items WHERE sale_id = v_sale_id;

  IF v_item.surcharge_amount <> 0 THEN
    RAISE EXCEPTION 'FALHA Cenário 4: surcharge_amount deveria ser 0 por default (retrocompat), veio %.', v_item.surcharge_amount;
  END IF;
  IF v_item.list_price_snapshot IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 4: list_price_snapshot deveria ser NULL quando ausente do payload, veio %.', v_item.list_price_snapshot;
  END IF;
  IF v_item.total_price <> 40 THEN
    RAISE EXCEPTION 'FALHA Cenário 4: total_price esperado 40, veio %.', v_item.total_price;
  END IF;

  RAISE NOTICE 'OK — Cenário 4 (retrocompatibilidade preservada para callers sem os campos novos)';
END $$;

ROLLBACK TO SAVEPOINT cenario_4;


-- =============================================================================
-- Cenário 5 (Blocker 2) — exemplo LITERAL do pedido: produtos R$80 (sem
-- ajuste por item), acréscimo GLOBAL de mercadoria (sales.surcharge_amount)
-- R$8, frete R$12. products_total esperado = 88 (80 - 0 + 8), NUNCA 92
-- (80+12) nem 80 (surcharge ignorado, bug da primeira versão desta fase).
-- total financeiro = 100 (88 + 12 de frete).
-- =============================================================================
SAVEPOINT cenario_5;

DO $$
DECLARE
  v_a  int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_sale record;
BEGIN
  SELECT variation_a, user_id INTO v_a, v_user FROM pricing_test_fixture;

  v_sale_result := public.rpc_create_sale(
    p_customer_id      => NULL,
    p_seller_id        => NULL,
    p_payment_method   => 'pix',
    p_sale_origin      => 'store',
    p_discount_amount  => 0,
    p_cashback_used    => 0,
    p_shipping_charged => 12,
    p_notes            => 'teste cenario 5 — apagar',
    p_items            => jsonb_build_array(
      jsonb_build_object('product_variation_id', v_a, 'quantity', 1, 'unit_price', 80, 'unit_cost', 20, 'discount_amount', 0)
    ),
    p_system_user_id   => v_user,
    p_surcharge_amount => 8  -- acréscimo GLOBAL de mercadoria (nível de pedido)
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT subtotal, discount_amount, surcharge_amount, shipping_charged, products_total, total INTO v_sale
  FROM public.sales WHERE id = v_sale_id;

  IF v_sale.subtotal <> 80 THEN
    RAISE EXCEPTION 'FALHA Cenário 5: subtotal esperado 80, veio %.', v_sale.subtotal;
  END IF;
  IF v_sale.products_total <> 88 THEN
    RAISE EXCEPTION 'FALHA Cenário 5: products_total esperado 88 (80 - 0 + 8, acréscimo global incluído), veio % — fórmula do Blocker 2 não corrigida.', v_sale.products_total;
  END IF;
  IF v_sale.total <> 100 THEN
    RAISE EXCEPTION 'FALHA Cenário 5: total financeiro esperado 100 (88 mercadoria + 12 frete), veio %.', v_sale.total;
  END IF;

  RAISE NOTICE 'OK — Cenário 5 (products_total inclui acréscimo GLOBAL de mercadoria = 88; frete fica de fora; total financeiro = 100)';
END $$;

ROLLBACK TO SAVEPOINT cenario_5;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO).
-- =============================================================================
