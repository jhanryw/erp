-- =============================================================================
-- product_kits.test.sql
--
-- KITS / PRODUTOS COMPOSTOS — testes de integração das RPCs e triggers
-- (migrations 202609231000..202609231300). Tudo dentro de BEGIN/ROLLBACK:
-- cria duas empresas de teste próprias, nunca toca em dado real.
-- Concorrência (duas sessões) fica em product_kits.concurrency.sh.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/product_kits.test.sql
-- Sucesso = termina com "NOTICE: product_kits: TODOS OS CENÁRIOS PASSARAM".
-- =============================================================================

BEGIN;

-- ─── Helpers (pg_temp — somem no fim da sessão) ─────────────────────────────

CREATE FUNCTION pg_temp.eq(actual anyelement, expected anyelement, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FALHOU [%]: esperado %, obtido %', label, expected, actual;
  END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

CREATE FUNCTION pg_temp.expect_error(sql text, fragment text, label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(lower(fragment) IN lower(SQLERRM)) = 0 THEN
      RAISE EXCEPTION 'FALHOU [%]: erro inesperado: %', label, SQLERRM;
    END IF;
    RAISE NOTICE 'ok  % (bloqueado: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FALHOU [%]: deveria ter sido bloqueado', label;
END $$;

-- Saldo físico direto (setup de teste) — mesmo bypass que as RPCs usam.
CREATE FUNCTION pg_temp.set_stock(p_pvid int, p_loc int, p_qty int) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);
  INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity)
  VALUES (p_pvid, p_loc, p_qty)
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
  PERFORM set_config('app.stock_rpc', '', true);
END $$;

CREATE FUNCTION pg_temp.qty(p_pvid int, p_loc int) RETURNS int
LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM stock_balances WHERE product_variation_id = p_pvid AND stock_location_id = p_loc), 0)
$$;

CREATE FUNCTION pg_temp.avail(p_company int, p_pvid int, p_mode text DEFAULT 'main_store') RETURNS int
LANGUAGE sql AS $$ SELECT public.fn_variation_sellable_quantity(p_company, p_pvid, p_mode) $$;

CREATE FUNCTION pg_temp.sell(p_user uuid, p_customer int, p_items jsonb, p_mode text DEFAULT 'main_store') RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  v := public.rpc_create_sale(
    p_customer_id      => p_customer,
    p_seller_id        => p_user,
    p_payment_method   => 'pix'::payment_method,
    p_sale_origin      => NULL,
    p_discount_amount  => 0,
    p_cashback_used    => 0,
    p_shipping_charged => 0,
    p_notes            => 'teste kits',
    p_items            => p_items,
    p_system_user_id   => p_user,
    p_stock_mode       => p_mode
  );
  RETURN (v->>'id')::int;
END $$;

-- ─── Fixtures ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text) ON COMMIT DROP;

DO $$
DECLARE
  c_a int; c_b int; u_a uuid := gen_random_uuid(); u_b uuid := gen_random_uuid();
  cat_a int; cat_b int; main_a int; dep_a int; main_b int; cust_a int; cust_b int;
  p_std int; p_std_b int;
  v_preta_p int; v_preta_m int; v_preta_g int; v_bege_m int; v_a int; v_b int; v_c int; v_other int;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE KITS A', 'teste-kits-a-' || u_a) RETURNING id INTO c_a;
  INSERT INTO companies (name, slug) VALUES ('TESTE KITS B', 'teste-kits-b-' || u_b) RETURNING id INTO c_b;
  INSERT INTO auth.users (id) VALUES (u_a), (u_b);
  INSERT INTO users (id, name, role, company_id) VALUES (u_a, 'Teste A', 'admin', c_a), (u_b, 'Teste B', 'admin', c_b);

  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (c_a, 'Loja', 'loja', true, 1) RETURNING id INTO main_a;
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (c_a, 'Depósito', 'deposito', false, 2) RETURNING id INTO dep_a;
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (c_b, 'Loja', 'loja', true, 1) RETURNING id INTO main_b;

  INSERT INTO categories (name, slug, company_id) VALUES ('Kits teste', 'kits-teste-' || c_a, c_a) RETURNING id INTO cat_a;
  INSERT INTO categories (name, slug, company_id) VALUES ('Kits teste B', 'kits-teste-' || c_b, c_b) RETURNING id INTO cat_b;
  INSERT INTO customers (name, company_id) VALUES ('Cliente A', c_a) RETURNING id INTO cust_a;
  INSERT INTO customers (name, company_id) VALUES ('Cliente B', c_b) RETURNING id INTO cust_b;

  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Calcinha Teste', 'CALC-T', cat_a, 10, 30, c_a, 'calcinha', 'teste', '2026') RETURNING id INTO p_std;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std, 'T-CALC-PRETA-P') RETURNING id INTO v_preta_p;
  INSERT INTO product_variations (product_id, sku_variation, cost_override) VALUES (p_std, 'T-CALC-PRETA-M', 12) RETURNING id INTO v_preta_m;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std, 'T-CALC-PRETA-G') RETURNING id INTO v_preta_g;
  INSERT INTO product_variations (product_id, sku_variation, cost_override) VALUES (p_std, 'T-CALC-BEGE-M', 8) RETURNING id INTO v_bege_m;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std, 'T-A') RETURNING id INTO v_a;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std, 'T-B') RETURNING id INTO v_b;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std, 'T-C') RETURNING id INTO v_c;

  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Produto Empresa B', 'OUTRA', cat_b, 5, 20, c_b, 'calcinha', 'teste', '2026') RETURNING id INTO p_std_b;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_std_b, 'T-OUTRA-EMPRESA') RETURNING id INTO v_other;

  INSERT INTO ctx VALUES
    ('c_a', c_a), ('c_b', c_b), ('u_a', u_a), ('u_b', u_b), ('cat_a', cat_a), ('main_a', main_a), ('dep_a', dep_a),
    ('main_b', main_b), ('cust_a', cust_a), ('cust_b', cust_b),
    ('preta_p', v_preta_p), ('preta_m', v_preta_m), ('preta_g', v_preta_g), ('bege_m', v_bege_m),
    ('a', v_a), ('b', v_b), ('c', v_c), ('other', v_other);
END $$;

CREATE FUNCTION pg_temp.c(p_key text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM ctx WHERE k = p_key $$;

-- ─── 1-2. Criar kit com um e com múltiplos componentes ───────────────────────

DO $$
DECLARE r jsonb; v_kit int; v_kit2 int; v_prod int;
BEGIN
  r := public.rpc_create_kit_product(
    pg_temp.c('u_a')::uuid,
    jsonb_build_object('name', 'Kit 3 Calcinhas', 'sku', 'KIT-3', 'category_id', pg_temp.c('cat_a')::int, 'base_price', 49.90),
    jsonb_build_array(
      jsonb_build_object('sku_variation', 'KIT-3-M', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', pg_temp.c('preta_m')::int, 'quantity', 3))),
      jsonb_build_object('sku_variation', 'KIT-PB-M', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', pg_temp.c('preta_m')::int, 'quantity', 1),
        jsonb_build_object('component_product_variation_id', pg_temp.c('bege_m')::int, 'quantity', 2)))
    )
  );
  v_prod := (r->>'product_id')::int;
  v_kit  := (r->'variations'->0->>'id')::int;
  v_kit2 := (r->'variations'->1->>'id')::int;
  INSERT INTO ctx VALUES ('kit_prod', v_prod), ('kit_3m', v_kit), ('kit_pb', v_kit2);

  PERFORM pg_temp.eq((SELECT product_kind FROM products WHERE id = v_prod), 'kit', '1. produto criado como kit');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM product_kit_components WHERE kit_product_variation_id = v_kit), 1, '1. kit com um componente');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM product_kit_components WHERE kit_product_variation_id = v_kit2), 2, '2. kit com múltiplos componentes');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_balances WHERE product_variation_id IN (v_kit, v_kit2)), 0, '1. kit criado sem saldo físico');
END $$;

-- Duplicatas consolidadas deterministicamente (soma).
DO $$
DECLARE r jsonb;
BEGIN
  r := public.rpc_set_kit_components(pg_temp.c('u_a')::uuid, pg_temp.c('kit_3m')::int, jsonb_build_array(
    jsonb_build_object('component_product_variation_id', pg_temp.c('preta_m')::int, 'quantity', 1),
    jsonb_build_object('component_product_variation_id', pg_temp.c('preta_m')::int, 'quantity', 2)));
  PERFORM pg_temp.eq((SELECT quantity FROM product_kit_components WHERE kit_product_variation_id = pg_temp.c('kit_3m')::int), 3, '2b. componentes duplicados consolidados (1+2=3)');
END $$;

-- ─── 3-5. Bloqueios estruturais ──────────────────────────────────────────────

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[]'::jsonb)$q$, pg_temp.c('u_a'), pg_temp.c('kit_3m')),
  'pelo menos um componente', '3. kit vazio bloqueado (RPC)');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_create_kit_product(%L::uuid, '{"name":"Kit Vazio","sku":"KV","category_id":%s,"base_price":10}'::jsonb,
     '[{"sku_variation":"KV-1","components":[]}]'::jsonb)$q$, pg_temp.c('u_a'), pg_temp.c('cat_a')),
  'pelo menos um componente', '3. criar kit sem componentes bloqueado');

-- Kit vazio também é barrado pelo banco no COMMIT (constraint trigger).
SELECT pg_temp.expect_error(format(
  $q$DO $x$ BEGIN
       DELETE FROM product_kit_components WHERE kit_product_variation_id = %s;
       SET CONSTRAINTS trg_kit_components_keep_at_least_one IMMEDIATE;
     END $x$$q$, pg_temp.c('kit_3m')),
  'pelo menos um componente', '3. apagar todos os componentes barrado pelo banco');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[{"component_product_variation_id":%s,"quantity":1}]'::jsonb)$q$,
  pg_temp.c('u_a'), pg_temp.c('kit_3m'), pg_temp.c('kit_pb')),
  'kit dentro de kit', '4. kit dentro de kit bloqueado (RPC)');

SELECT pg_temp.expect_error(format(
  $q$INSERT INTO product_kit_components (company_id, kit_product_variation_id, component_product_variation_id, quantity)
     VALUES (%s, %s, %s, 1)$q$, pg_temp.c('c_a'), pg_temp.c('kit_3m'), pg_temp.c('kit_pb')),
  'kit dentro de kit', '4. kit dentro de kit bloqueado (trigger)');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[{"component_product_variation_id":%s,"quantity":1}]'::jsonb)$q$,
  pg_temp.c('u_a'), pg_temp.c('kit_3m'), pg_temp.c('kit_3m')),
  'ele mesmo', '4b. kit contendo ele mesmo bloqueado');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[{"component_product_variation_id":%s,"quantity":1}]'::jsonb)$q$,
  pg_temp.c('u_a'), pg_temp.c('kit_3m'), pg_temp.c('other')),
  'não encontrado', '5. componente de outra empresa bloqueado (RPC)');

SELECT pg_temp.expect_error(format(
  $q$INSERT INTO product_kit_components (company_id, kit_product_variation_id, component_product_variation_id, quantity)
     VALUES (%s, %s, %s, 1)$q$, pg_temp.c('c_a'), pg_temp.c('kit_3m'), pg_temp.c('other')),
  'mesma empresa', '5. componente de outra empresa bloqueado (trigger)');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[{"component_product_variation_id":%s,"quantity":0}]'::jsonb)$q$,
  pg_temp.c('u_a'), pg_temp.c('kit_3m'), pg_temp.c('preta_m')),
  'maior que zero', '5b. quantidade zero bloqueada');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_set_kit_components(%L::uuid, %s, '[{"component_product_variation_id":%s,"quantity":1}]'::jsonb)$q$,
  pg_temp.c('u_b'), pg_temp.c('kit_3m'), pg_temp.c('preta_m')),
  'kit não encontrado', '26. usuário da empresa B não edita kit da empresa A');

SELECT pg_temp.expect_error(format(
  $q$UPDATE products SET product_kind = 'standard' WHERE id = %s$q$, pg_temp.c('kit_prod')),
  'não pode ser alterado', '5c. product_kind imutável');

-- ─── Kit nunca tem saldo físico (entrada/ajuste/transferência/inventário) ────

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_stock_entry(%s, NULL, 'purchase', 5, 10, 0, 0, CURRENT_DATE, 'x', %L::uuid, NULL::int)$q$,
  pg_temp.c('kit_pb'), pg_temp.c('u_a')),
  'não possui estoque próprio', '19. entrada de estoque no kit bloqueada');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_stock_adjust(%s, 3, 'ajuste', 'x', %L::uuid, NULL::int)$q$, pg_temp.c('kit_pb'), pg_temp.c('u_a')),
  'não possui estoque próprio', '19. ajuste manual do kit bloqueado');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_stock_adjust(%s, 3, 'inventario-fisico', 'x', %L::uuid, NULL::int)$q$, pg_temp.c('kit_pb'), pg_temp.c('u_a')),
  'não possui estoque próprio', '21. inventário do kit bloqueado');

SELECT pg_temp.expect_error(format(
  $q$SELECT public.rpc_transfer_stock(%s, %s, %s, 1, 'x', %L::uuid)$q$,
  pg_temp.c('kit_pb'), pg_temp.c('dep_a'), pg_temp.c('main_a'), pg_temp.c('u_a')),
  -- Kit nunca tem saldo em nenhum local → a transferência já para na
  -- checagem de saldo de origem; se chegasse a escrever, o trigger barraria.
  'saldo insuficiente', '20. transferência do kit bloqueada');

-- ─── 6-9. Disponibilidade derivada ───────────────────────────────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int;
  r jsonb; v_kit int;
BEGIN
  -- KIT: 2×A + 1×B; A=10, B=3 → A permite 5, B permite 3 → 3
  r := public.rpc_create_kit_product(pg_temp.c('u_a')::uuid,
    jsonb_build_object('name', 'Kit AB', 'sku', 'KIT-AB', 'category_id', pg_temp.c('cat_a')::int, 'base_price', 40),
    jsonb_build_array(jsonb_build_object('sku_variation', 'KIT-AB-1', 'components', jsonb_build_array(
      jsonb_build_object('component_product_variation_id', pg_temp.c('a')::int, 'quantity', 2),
      jsonb_build_object('component_product_variation_id', pg_temp.c('b')::int, 'quantity', 1)))));
  v_kit := (r->'variations'->0->>'id')::int;
  INSERT INTO ctx VALUES ('kit_ab', v_kit);

  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, m, 10);
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 3);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 3, '6/7/9. disponibilidade = MIN(floor(10/2), floor(3/1)) = 3');

  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 0);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 0, '8. componente com estoque zero → kit 0');

  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 50);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 5, '9. gargalo muda para A (10/2=5)');

  -- Standard continua respondendo o próprio saldo.
  PERFORM pg_temp.eq(pg_temp.avail(c, pg_temp.c('a')::int), 10, '6b. produto normal = saldo físico');

  -- Online soma locais ativos; main_store só a loja.
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, pg_temp.c('dep_a')::int, 6);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'main_store'), 5, '4-multi. PDV (main_store) ignora depósito');
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'online_priority'), 8, '4-multi. online soma locais ativos (16/2=8)');
  UPDATE stock_locations SET active = false WHERE id = pg_temp.c('dep_a')::int;
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'online_priority'), 5, '4-multi. local inativo não abastece online');
  UPDATE stock_locations SET active = true WHERE id = pg_temp.c('dep_a')::int;
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, pg_temp.c('dep_a')::int, 0);

  -- Multi-tenant: empresa B nunca enxerga disponibilidade do kit de A.
  PERFORM pg_temp.eq(pg_temp.avail(pg_temp.c('c_b')::int, v_kit), 0, '26. disponibilidade de kit de outra empresa = 0');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM public.rpc_get_variation_availability(pg_temp.c('c_b')::int, ARRAY[v_kit], 'main_store')), 0,
    '26. rpc_get_variation_availability não devolve variação de outra empresa');
END $$;

-- ─── 12-13. Venda sem saldo e rollback completo ──────────────────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; v_kit int := pg_temp.c('kit_ab')::int;
  v_sales_before int; v_mov_before int;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, m, 10);
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 2);
  SELECT count(*) INTO v_sales_before FROM sales WHERE company_id = c;
  SELECT count(*) INTO v_mov_before FROM stock_movements WHERE company_id = c;

  BEGIN
    -- 3 kits = 6×A (ok) + 3×B (só 2) → deve falhar por inteiro.
    PERFORM pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
      jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 3, 'unit_price', 40, 'unit_cost', 0)));
    RAISE EXCEPTION 'FALHOU [12]: venda sem saldo deveria falhar';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  12. venda sem saldo bloqueada (%)', SQLERRM;
  END;

  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, m), 10, '13. rollback: A não foi baixado');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('b')::int, m), 2, '13. rollback: B não foi baixado');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sales WHERE company_id = c), v_sales_before, '13. rollback: nenhuma venda criada');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE company_id = c), v_mov_before, '13. rollback: nenhum movimento criado');
END $$;

-- ─── 10-11. Venda de 1 e de 3 kits ───────────────────────────────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; v_kit int := pg_temp.c('kit_pb')::int;
  v_sale int; v_item record;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('preta_m')::int, m, 20);
  PERFORM pg_temp.set_stock(pg_temp.c('bege_m')::int, m, 14);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 7, '18-ui. KIT-PB-M: preta 20/1=20, bege 14/2=7 → 7');

  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 1, 'unit_price', 49.90, 'unit_cost', 999)));
  INSERT INTO ctx VALUES ('sale_1kit', v_sale);

  SELECT * INTO v_item FROM sale_items WHERE sale_id = v_sale;
  PERFORM pg_temp.eq(v_item.product_variation_id, v_kit, '10. item comercial é o SKU do kit');
  PERFORM pg_temp.eq(v_item.quantity, 1, '10. 1 unidade comercial');
  PERFORM pg_temp.eq(v_item.unit_price, 49.90::numeric, '10. preço próprio do kit');
  PERFORM pg_temp.eq(v_item.unit_cost, 28.00::numeric, '8-custo. custo = 1×12 + 2×8 = 28 (payload 999 ignorado)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('preta_m')::int, m), 19, '10. preta baixou 1');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('bege_m')::int, m), 12, '10. bege baixou 2');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_balances WHERE product_variation_id = v_kit), 0, '10. nenhum saldo criado para o kit');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_item_components WHERE sale_id = v_sale), 2, '10. snapshot com 2 componentes');
  PERFORM pg_temp.eq((SELECT unit_cost FROM sale_item_components WHERE sale_id = v_sale AND component_product_variation_id = pg_temp.c('bege_m')::int), 8.00::numeric, '8-custo. custo do componente congelado');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE reference_id = v_sale::text AND product_variation_id = v_kit), 0, '10. nenhum movimento para o kit');

  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 3, 'unit_price', 49.90, 'unit_cost', 0)));
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('preta_m')::int, m), 16, '11. 3 kits → preta -3');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('bege_m')::int, m), 6, '11. 3 kits → bege -6');
  PERFORM pg_temp.eq((SELECT total_quantity FROM sale_item_components WHERE sale_id = v_sale AND component_product_variation_id = pg_temp.c('bege_m')::int), 6, '11. snapshot total = 2×3');
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 3, '16. disponibilidade recalculada (bege 6/2=3)');
END $$;

-- Kit + componente avulso no mesmo carrinho: validação agregada.
DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, m, 3);
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 5);
  BEGIN
    -- KIT-AB (2A+1B) + 2×A avulso = 4×A, só há 3.
    PERFORM pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int, jsonb_build_array(
      jsonb_build_object('product_variation_id', pg_temp.c('kit_ab')::int, 'quantity', 1, 'unit_price', 40, 'unit_cost', 0),
      jsonb_build_object('product_variation_id', pg_temp.c('a')::int, 'quantity', 2, 'unit_price', 20, 'unit_cost', 10)));
    RAISE EXCEPTION 'FALHOU [agregado]: deveria falhar';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  7b. kit + componente avulso validados em conjunto (%)', SQLERRM;
  END;
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, m), 3, '7b. nada baixado');
END $$;

-- ─── 16. Dois kits compartilhando componente ────────────────────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; r jsonb; k1 int; k2 int;
BEGIN
  r := public.rpc_create_kit_product(pg_temp.c('u_a')::uuid,
    jsonb_build_object('name', 'Kit Compartilhado', 'sku', 'KIT-SH', 'category_id', pg_temp.c('cat_a')::int, 'base_price', 30),
    jsonb_build_array(
      jsonb_build_object('sku_variation', 'KIT-SH-2A', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', pg_temp.c('c')::int, 'quantity', 2))),
      jsonb_build_object('sku_variation', 'KIT-SH-1A', 'components', jsonb_build_array(
        jsonb_build_object('component_product_variation_id', pg_temp.c('c')::int, 'quantity', 1)))));
  k1 := (r->'variations'->0->>'id')::int;
  k2 := (r->'variations'->1->>'id')::int;
  PERFORM pg_temp.set_stock(pg_temp.c('c')::int, m, 10);
  PERFORM pg_temp.eq(pg_temp.avail(c, k1), 5, '16. KIT1 (2×C) = 5');
  PERFORM pg_temp.eq(pg_temp.avail(c, k2), 10, '16. KIT2 (1×C) = 10 (kits não reservam)');
  PERFORM pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', k1, 'quantity', 2, 'unit_price', 30, 'unit_cost', 0)));
  PERFORM pg_temp.eq(pg_temp.avail(c, k1), 3, '16. após vender 2×KIT1: KIT1 = 3');
  PERFORM pg_temp.eq(pg_temp.avail(c, k2), 6, '16. após vender 2×KIT1: KIT2 = 6 (recalculado)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_availability_changes
                      WHERE product_variation_id IN (k1, k2) AND status = 'pending'), 2,
    '14/16. mudança de C enfileirou os dois kits dependentes');
END $$;

-- ─── 22. Variação M indisponível sem afetar P/G ─────────────────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; r jsonb; kp int; km int; kg int;
BEGIN
  r := public.rpc_create_kit_product(pg_temp.c('u_a')::uuid,
    jsonb_build_object('name', 'Kit Tamanhos', 'sku', 'KIT-TAM', 'category_id', pg_temp.c('cat_a')::int, 'base_price', 30),
    jsonb_build_array(
      jsonb_build_object('sku_variation', 'KIT-TAM-P', 'components', jsonb_build_array(jsonb_build_object('component_product_variation_id', pg_temp.c('preta_p')::int, 'quantity', 3))),
      jsonb_build_object('sku_variation', 'KIT-TAM-M', 'components', jsonb_build_array(jsonb_build_object('component_product_variation_id', pg_temp.c('preta_m')::int, 'quantity', 3))),
      jsonb_build_object('sku_variation', 'KIT-TAM-G', 'components', jsonb_build_array(jsonb_build_object('component_product_variation_id', pg_temp.c('preta_g')::int, 'quantity', 3)))));
  kp := (r->'variations'->0->>'id')::int; km := (r->'variations'->1->>'id')::int; kg := (r->'variations'->2->>'id')::int;
  PERFORM pg_temp.set_stock(pg_temp.c('preta_p')::int, m, 9);
  PERFORM pg_temp.set_stock(pg_temp.c('preta_m')::int, m, 0);
  PERFORM pg_temp.set_stock(pg_temp.c('preta_g')::int, m, 6);
  PERFORM pg_temp.eq(pg_temp.avail(c, kp), 3, '22. KIT P disponível');
  PERFORM pg_temp.eq(pg_temp.avail(c, km), 0, '22. KIT M indisponível');
  PERFORM pg_temp.eq(pg_temp.avail(c, kg), 2, '22. KIT G disponível');
  PERFORM pg_temp.eq((SELECT active FROM products WHERE id = (r->>'product_id')::int), true, '22. produto inteiro continua ativo');
END $$;

-- ─── 17. Cancelamento (volta ao local de origem, idempotente) ────────────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; d int := pg_temp.c('dep_a')::int;
  v_kit int := pg_temp.c('kit_ab')::int; v_sale int;
BEGIN
  -- Venda ONLINE em cascata: A = 1 na loja + 5 no depósito; 2 kits = 4×A.
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, m, 1);
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, d, 5);
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 5);
  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 2, 'unit_price', 40, 'unit_cost', 0)), 'online_priority');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, m), 0, '17. online: loja (prioridade 1) consumida primeiro');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, d), 2, '17. online: depósito completou (5-3)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_item_components WHERE sale_id = v_sale AND component_product_variation_id = pg_temp.c('a')::int), 2,
    '17. snapshot registra os 2 locais de origem de A');

  -- Editar a composição DEPOIS da venda (23).
  PERFORM public.rpc_set_kit_components(pg_temp.c('u_a')::uuid, v_kit, jsonb_build_array(
    jsonb_build_object('component_product_variation_id', pg_temp.c('a')::int, 'quantity', 5)));
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_item_components WHERE sale_id = v_sale), 3, '23. editar composição não altera snapshot da venda');

  PERFORM public.rpc_cancel_sale(v_sale, pg_temp.c('u_a')::uuid);
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, m), 1, '17. cancelamento devolveu 1×A à loja (origem)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, d), 5, '17. cancelamento devolveu 3×A ao depósito (origem)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('b')::int, m), 5, '17/23. B devolvido pelo snapshot (composição atual nem tem B)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_balances WHERE product_variation_id = v_kit), 0, '17. cancelamento não criou saldo para o kit');

  BEGIN
    PERFORM public.rpc_cancel_sale(v_sale, pg_temp.c('u_a')::uuid);
    RAISE EXCEPTION 'FALHOU [17]: segundo cancelamento deveria falhar';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  17. cancelamento idempotente (%)', SQLERRM;
  END;
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('a')::int, d), 5, '17. segundo cancelamento não devolveu de novo');

  -- Restaura composição original para os próximos cenários.
  PERFORM public.rpc_set_kit_components(pg_temp.c('u_a')::uuid, v_kit, jsonb_build_array(
    jsonb_build_object('component_product_variation_id', pg_temp.c('a')::int, 'quantity', 2),
    jsonb_build_object('component_product_variation_id', pg_temp.c('b')::int, 'quantity', 1)));
END $$;

-- ─── Devolução total e troca de kit ─────────────────────────────────────────

DO $$
DECLARE m int := pg_temp.c('main_a')::int; v_kit int := pg_temp.c('kit_pb')::int; v_sale int; v_item int;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('preta_m')::int, m, 10);
  PERFORM pg_temp.set_stock(pg_temp.c('bege_m')::int, m, 10);

  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 2, 'unit_price', 49.90, 'unit_cost', 0)));
  PERFORM public.rpc_return_sale(v_sale, pg_temp.c('u_a')::uuid);
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('preta_m')::int, m), 10, '10-dev. devolução total devolveu preta');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('bege_m')::int, m), 10, '10-dev. devolução total devolveu bege');

  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', v_kit, 'quantity', 3, 'unit_price', 49.90, 'unit_cost', 0)));
  SELECT id INTO v_item FROM sale_items WHERE sale_id = v_sale;
  -- Troca de 1 dos 3 kits (unidade inteira do item comercial).
  PERFORM public.rpc_process_exchange(pg_temp.c('c_a')::int, v_sale, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity_returned', 1)), 'troca teste', pg_temp.c('u_a')::uuid);
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('preta_m')::int, m), 8, '10-troca. troca de 1 kit devolveu 1×preta (10-3+1)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('bege_m')::int, m), 6, '10-troca. troca de 1 kit devolveu 2×bege (10-6+2)');
  PERFORM pg_temp.eq((SELECT product_variation_id FROM exchange_items ei JOIN exchanges e ON e.id = ei.exchange_id WHERE e.original_sale_id = v_sale), v_kit,
    '10-troca. troca registra o item comercial (kit)');

  BEGIN
    PERFORM public.rpc_process_exchange(pg_temp.c('c_a')::int, v_sale, pg_temp.c('cust_a')::int,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'quantity_returned', 3)), 'excesso', pg_temp.c('u_a')::uuid);
    RAISE EXCEPTION 'FALHOU [troca]: deveria limitar a 2 kits restantes';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    RAISE NOTICE 'ok  10-troca. não troca mais kits do que restam (%)', SQLERRM;
  END;
END $$;

-- ─── 18/19/20/21/25. Reposição por qualquer origem recalcula o kit ──────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; d int := pg_temp.c('dep_a')::int;
  v_kit int := pg_temp.c('kit_ab')::int; r jsonb;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, m, 0);
  PERFORM pg_temp.set_stock(pg_temp.c('a')::int, d, 0);
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 4);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 0, '18/25. componente A = 0 → KIT = 0');

  -- Processa a fila: o cache passa a dizer "indisponível".
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM pg_temp.eq((SELECT is_sellable FROM variation_availability WHERE product_variation_id = v_kit), false, '18. cache: kit indisponível');

  -- Entrada de mercadoria (RPC real): A = 20.
  PERFORM public.rpc_stock_entry(pg_temp.c('a')::int, NULL, 'purchase', 20, 10, 0, 0, CURRENT_DATE, 'reposição', pg_temp.c('u_a')::uuid, NULL::int);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 4, '18/25. após entrada: KIT = MIN(20/2, 4/1) = 4');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_availability_changes WHERE product_variation_id = v_kit AND status = 'pending'), 1,
    '18. entrada enfileirou o kit dependente (sem lógica em rota)');
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM pg_temp.eq((SELECT is_sellable FROM variation_availability WHERE product_variation_id = v_kit), true, '25. cache: kit volta a ficar vendável automaticamente');
  PERFORM pg_temp.eq((SELECT online_quantity FROM variation_availability WHERE product_variation_id = v_kit), 4, '25. cache: quantidade vendável publicada = 4');

  -- Ajuste (19)
  PERFORM public.rpc_stock_adjust(pg_temp.c('b')::int, -3, 'ajuste', 'teste', pg_temp.c('u_a')::uuid, NULL::int);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit), 1, '19. ajuste do componente recalcula o kit');

  -- Transferência (20): leva A para o depósito → PDV perde, online mantém.
  -- (rpc_stock_transfer_bulk: é o caminho da tela de transferência em massa;
  -- rpc_transfer_stock das migrations tem um bug pré-existente de CHECK em
  -- INSERT ... ON CONFLICT com valor negativo — ver relatório.)
  PERFORM public.rpc_stock_transfer_bulk(m, d, 'teste', pg_temp.c('u_a')::uuid,
    jsonb_build_array(jsonb_build_object('product_variation_id', pg_temp.c('a')::int, 'quantity', 20)));
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'main_store'), 0, '20. transferência: PDV sem A no Estoque Loja → 0');
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'online_priority'), 1, '20. transferência: online continua 1');

  -- Inventário (21) = rpc_stock_adjust com motivo inventario-fisico.
  PERFORM public.rpc_stock_adjust(pg_temp.c('b')::int, 9, 'inventario-fisico', 'contagem', pg_temp.c('u_a')::uuid, NULL::int);
  PERFORM pg_temp.eq(pg_temp.avail(c, v_kit, 'online_priority'), 10, '21. inventário do componente recalcula o kit (20/2=10)');
END $$;

-- ─── 24. Kit desativado manualmente nunca é reativado pela reposição ─────────

DO $$
DECLARE c int := pg_temp.c('c_a')::int; m int := pg_temp.c('main_a')::int; v_kit int := pg_temp.c('kit_ab')::int; r jsonb;
BEGIN
  UPDATE product_variations SET active = false WHERE id = v_kit;
  PERFORM pg_temp.set_stock(pg_temp.c('b')::int, m, 0);
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM public.rpc_stock_entry(pg_temp.c('b')::int, NULL, 'purchase', 30, 5, 0, 0, CURRENT_DATE, 'reposição', pg_temp.c('u_a')::uuid, NULL::int);
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM pg_temp.eq((SELECT active FROM product_variations WHERE id = v_kit), false, '24. reposição não reativou o kit');
  PERFORM pg_temp.eq((SELECT is_sellable FROM variation_availability WHERE product_variation_id = v_kit), false, '24. cache: continua não vendável');
  PERFORM pg_temp.eq((SELECT inventory_available FROM variation_availability WHERE product_variation_id = v_kit), true, '24. cache: há estoque, mas desativado manualmente');
  PERFORM pg_temp.eq((SELECT manual_enabled FROM public.rpc_get_variation_availability(c, ARRAY[v_kit], 'online_priority')), false, '24. manual_enabled=false');
  UPDATE product_variations SET active = true WHERE id = v_kit;
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM pg_temp.eq((SELECT is_sellable FROM variation_availability WHERE product_variation_id = v_kit), true, '24. reativação MANUAL volta a vender');
END $$;

-- ─── 26. Venda cross-tenant bloqueada ───────────────────────────────────────

SELECT pg_temp.expect_error(format(
  $q$SELECT pg_temp.sell(%L::uuid, %s, '[{"product_variation_id":%s,"quantity":1,"unit_price":10,"unit_cost":0}]'::jsonb)$q$,
  pg_temp.c('u_b'), pg_temp.c('cust_b'), pg_temp.c('kit_pb')),
  'não pertence à empresa', '26. empresa B não vende kit da empresa A');

-- ─── Regressão: produto normal inalterado ───────────────────────────────────

DO $$
DECLARE m int := pg_temp.c('main_a')::int; v_sale int;
BEGIN
  PERFORM pg_temp.set_stock(pg_temp.c('c')::int, m, 5);
  v_sale := pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
    jsonb_build_array(jsonb_build_object('product_variation_id', pg_temp.c('c')::int, 'quantity', 2, 'unit_price', 20, 'unit_cost', 7)));
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('c')::int, m), 3, 'regressão. venda normal baixa o próprio saldo');
  PERFORM pg_temp.eq((SELECT unit_cost FROM sale_items WHERE sale_id = v_sale), 7::numeric, 'regressão. custo do payload preservado para produto normal');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_item_components WHERE sale_id = v_sale), 0, 'regressão. venda normal não gera snapshot de kit');
  PERFORM public.rpc_cancel_sale(v_sale, pg_temp.c('u_a')::uuid);
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('c')::int, m), 5, 'regressão. cancelamento normal devolve à loja');
  BEGIN
    PERFORM pg_temp.sell(pg_temp.c('u_a')::uuid, pg_temp.c('cust_a')::int,
      jsonb_build_array(jsonb_build_object('product_variation_id', pg_temp.c('c')::int, 'quantity', 9, 'unit_price', 20, 'unit_cost', 7)));
    RAISE EXCEPTION 'FALHOU [regressão]: deveria faltar saldo';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    PERFORM pg_temp.eq(position('Produto sem saldo no Estoque Loja' IN SQLERRM) > 0, true, 'regressão. mensagem original de falta de saldo preservada');
  END;
END $$;

DO $$ BEGIN RAISE NOTICE 'product_kits: TODOS OS CENÁRIOS PASSARAM'; END $$;

ROLLBACK;
