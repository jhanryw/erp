-- =============================================================================
-- channel_orders.test.sql — Fase 3 marketplace (202609261000 + 202609261100).
-- BEGIN/ROLLBACK, empresas próprias. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/channel_orders.test.sql
-- Sucesso = "channel_orders: TODOS OS CENÁRIOS PASSARAM".
-- =============================================================================
BEGIN;

CREATE FUNCTION pg_temp.eq(actual anyelement, expected anyelement, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FALHOU [%]: esperado %, obtido %', label, expected, actual; END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

CREATE FUNCTION pg_temp.expect_error(sql text, fragment text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(lower(fragment) IN lower(SQLERRM)) = 0 THEN RAISE EXCEPTION 'FALHOU [%]: erro inesperado: %', label, SQLERRM; END IF;
    RAISE NOTICE 'ok  % (bloqueado: %)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FALHOU [%]: deveria ter sido bloqueado', label;
END $$;

CREATE FUNCTION pg_temp.set_stock(p_pvid int, p_loc int, p_qty int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);
  INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity) VALUES (p_pvid, p_loc, p_qty)
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = EXCLUDED.quantity;
  PERFORM set_config('app.stock_rpc', '', true);
END $$;

CREATE FUNCTION pg_temp.qty(p_pvid int, p_loc int) RETURNS int LANGUAGE sql AS $$
  SELECT COALESCE((SELECT quantity FROM stock_balances WHERE product_variation_id = p_pvid AND stock_location_id = p_loc), 0)
$$;

CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text) ON COMMIT DROP;
CREATE FUNCTION pg_temp.c(k text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM ctx WHERE ctx.k = $1 $$;

DO $$
DECLARE
  a int; b int; ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  cat_a int; cat_b int; main_a int; dep_a int; main_b int;
  p_n int; v_n int; p_c int; v_ca int; v_cb int; p_b int; v_b int; ia bigint; ib bigint; r jsonb; v_kit int;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE CO A', 'teste-co-a-' || ua) RETURNING id INTO a;
  INSERT INTO companies (name, slug) VALUES ('TESTE CO B', 'teste-co-b-' || ub) RETURNING id INTO b;
  INSERT INTO auth.users (id) VALUES (ua), (ub);
  INSERT INTO users (id, name, role, company_id) VALUES (ua, 'Admin A', 'admin', a), (ub, 'Admin B', 'admin', b);
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (a, 'Loja', 'loja', true, 1) RETURNING id INTO main_a;
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (a, 'Depósito', 'deposito', false, 2) RETURNING id INTO dep_a;
  INSERT INTO stock_locations (company_id, name, slug, is_main_store, priority) VALUES (b, 'Loja', 'loja', true, 1) RETURNING id INTO main_b;
  INSERT INTO categories (name, slug, company_id) VALUES ('Cat A', 'co-a-' || a, a) RETURNING id INTO cat_a;
  INSERT INTO categories (name, slug, company_id) VALUES ('Cat B', 'co-b-' || b, b) RETURNING id INTO cat_b;
  -- cashback ATIVO na empresa A: prova que marketplace não credita cashback
  INSERT INTO cashback_config (company_id, rate_pct, release_days, expiry_days, min_order_value, active) VALUES (a, 10, 0, 0, 0, true);

  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Item de Teste ML - Produto Normal', 'TEST-ML-NORMAL', cat_a, 20, 50, a, 'calcinha', 'teste', '2026') RETURNING id INTO p_n;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_n, 'TEST-ML-NORMAL-01') RETURNING id INTO v_n;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Componentes TEST', 'TEST-COMP', cat_a, 5, 10, a, 'calcinha', 'teste', '2026') RETURNING id INTO p_c;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_c, 'TEST-COMP-A') RETURNING id INTO v_ca;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_c, 'TEST-COMP-B') RETURNING id INTO v_cb;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Outro B', 'CO-B', cat_b, 5, 20, b, 'calcinha', 'teste', '2026') RETURNING id INTO p_b;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_b, 'CO-B-1') RETURNING id INTO v_b;

  r := public.rpc_create_kit_product(ua,
    jsonb_build_object('name', 'Item de Teste ML - Kit', 'sku', 'TEST-ML-KIT', 'category_id', cat_a, 'base_price', 79.9),
    jsonb_build_array(jsonb_build_object('sku_variation', 'TEST-ML-KIT-01', 'components', jsonb_build_array(
      jsonb_build_object('component_product_variation_id', v_ca, 'quantity', 1),
      jsonb_build_object('component_product_variation_id', v_cb, 'quantity', 2)))));
  v_kit := (r->'variations'->0->>'id')::int;

  -- Estoque: normal 1 na loja + 2 no depósito; componentes A=5, B=6 (kit vendável = 3)
  PERFORM pg_temp.set_stock(v_n, main_a, 1);
  PERFORM pg_temp.set_stock(v_n, dep_a, 2);
  PERFORM pg_temp.set_stock(v_ca, main_a, 5);
  PERFORM pg_temp.set_stock(v_cb, main_a, 6);
  PERFORM pg_temp.set_stock(v_b, main_b, 5);

  INSERT INTO company_integrations (company_id, provider, status, external_account_id, created_by) VALUES (a, 'mercadolivre', 'active', '555', ua) RETURNING id INTO ia;
  INSERT INTO company_integrations (company_id, provider, status, external_account_id, created_by) VALUES (b, 'mercadolivre', 'active', '777', ub) RETURNING id INTO ib;

  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, external_listing_id, local_status)
  VALUES (a, ia, 'mercadolivre', p_n, v_n, 'TEST-ML-NORMAL-01', 'MLB100', 'active'),
         (a, ia, 'mercadolivre', (SELECT product_id FROM product_variations WHERE id = v_kit), v_kit, 'TEST-ML-KIT-01', 'MLB200', 'active');

  INSERT INTO ctx VALUES ('a', a), ('b', b), ('ua', ua), ('ub', ub), ('main_a', main_a), ('dep_a', dep_a), ('main_b', main_b),
    ('v_n', v_n), ('v_ca', v_ca), ('v_cb', v_cb), ('v_kit', v_kit), ('v_b', v_b), ('ia', ia), ('ib', ib);
END $$;

-- Pedido ML normalizado (como o worker grava) — valores da API.
CREATE FUNCTION pg_temp.order_json(p_ext text, p_gross numeric, p_fee numeric, p_ship numeric, p_status text DEFAULT 'paid', p_buyer text DEFAULT '9001')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('external_order_id', p_ext, 'channel_status', p_status, 'payment_status', 'approved',
    'buyer_external_id', p_buyer, 'buyer_nickname', 'TESTBUYER', 'currency', 'BRL', 'gross_amount', p_gross, 'paid_amount', p_gross,
    'marketplace_fees', p_fee, 'shipping_cost_seller', p_ship, 'shipping_cost_buyer', 0, 'other_costs', 0,
    'net_amount', p_gross - p_fee - p_ship, 'is_test', true, 'tags', jsonb_build_array('test_order', 'paid'),
    'external_shipment_id', 'SH-' || p_ext, 'shipping_mode', 'me2', 'shipping_status', 'ready_to_ship')
$$;
CREATE FUNCTION pg_temp.item_json(p_item text, p_sku text, p_qty int, p_price numeric, p_fee numeric, p_pvid int, p_listing bigint, p_resolution text DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('external_item_id', p_item, 'seller_sku', p_sku, 'title', 'Item ' || p_sku, 'quantity', p_qty,
    'unit_price', p_price, 'sale_fee', p_fee, 'listing_type_id', 'gold_special',
    'channel_listing_id', p_listing, 'product_variation_id', p_pvid, 'external_user_product_id', 'MLBU-N',
    'mapping_status', CASE WHEN p_pvid IS NULL THEN 'unmapped' ELSE 'mapped' END)
    || CASE WHEN p_resolution IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('listing_resolution', p_resolution) END
$$;
CREATE FUNCTION pg_temp.pay(p_amount numeric, p_method text DEFAULT 'credit_card', p_ext text DEFAULT 'PAY-1') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('method', p_method, 'net_amount', p_amount, 'installments', 1,
    'external_payment_id', p_ext, 'metadata', jsonb_build_object('provider_payment_type', p_method, 'provider_payment_method', 'visa')))
$$;
CREATE FUNCTION pg_temp.upsert(p_order jsonb, p_items jsonb, p_company int DEFAULT NULL, p_int bigint DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $$
  SELECT (public.rpc_upsert_channel_order(COALESCE(p_company, pg_temp.c('a')::int), COALESCE(p_int, pg_temp.c('ia')::bigint), 'mercadolivre', p_order, p_items)->>'channel_order_id')::bigint
$$;
CREATE FUNCTION pg_temp.listing(p_ext text) RETURNS bigint LANGUAGE sql AS $$ SELECT id FROM channel_listings WHERE external_listing_id = p_ext $$;

-- ─── 1. inbound_events ─────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; e1 bigint; n int; w record;
BEGIN
  PERFORM pg_temp.eq(public.rpc_enqueue_inbound_event('mercadolivre', '999', 'orders_v2', '/orders/1', 'orders_v2:/orders/1', NULL, '{}')->>'result',
    'unknown_account', '1. conta desconhecida não enfileira (empresa nunca vem do corpo)');
  r := public.rpc_enqueue_inbound_event('mercadolivre', '555', 'orders_v2', '/orders/1', 'orders_v2:/orders/1', 'n1', '{"topic":"orders_v2"}');
  PERFORM pg_temp.eq(r->>'result', 'queued', '1. primeira notificação enfileirada');
  PERFORM pg_temp.eq((r->>'company_id')::int, pg_temp.c('a')::int, '1. empresa resolvida pelo user_id do ML');
  e1 := (r->>'event_id')::bigint;
  PERFORM public.rpc_enqueue_inbound_event('mercadolivre', '555', 'orders_v2', '/orders/1', 'orders_v2:/orders/1', 'n2', '{}');
  r := public.rpc_enqueue_inbound_event('mercadolivre', '555', 'orders_v2', '/orders/1', 'orders_v2:/orders/1', 'n3', '{}');
  PERFORM pg_temp.eq(r->>'result', 'coalesced', '1. notificação repetida coalescida');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM inbound_events WHERE resource = '/orders/1'), 1, '1. 3 notificações → 1 evento');
  PERFORM pg_temp.eq((SELECT received_count FROM inbound_events WHERE id = e1), 3, '1. contagem de recebimentos');

  SELECT count(*) INTO n FROM public.rpc_claim_inbound_events('mercadolivre', 10, 'w1', 300);
  PERFORM pg_temp.eq(n, 1, '1. claim pega o evento');
  SELECT count(*) INTO n FROM public.rpc_claim_inbound_events('mercadolivre', 10, 'w2', 300);
  PERFORM pg_temp.eq(n, 0, '1. segundo worker não pega evento em processamento');
  -- nova notificação durante o processamento abre OUTRO evento (estado pode ter mudado)
  PERFORM pg_temp.eq(public.rpc_enqueue_inbound_event('mercadolivre', '555', 'orders_v2', '/orders/1', 'orders_v2:/orders/1', 'n4', '{}')->>'result',
    'queued', '1. notificação durante processamento vira novo evento');
  PERFORM pg_temp.eq(public.rpc_finish_inbound_event(e1, 'w2', 'processed'), false, '1. só o dono do lock finaliza (fencing)');
  PERFORM pg_temp.eq(public.rpc_finish_inbound_event(e1, 'w1', 'failed', 'boom', NOW() + interval '1 minute'), true, '1. dono agenda retry');
  PERFORM pg_temp.eq((SELECT status || '|' || last_error FROM inbound_events WHERE id = e1), 'processed|coalescido: boom',
    '1. retry que colidiria com evento aberto é coalescido');

  -- recuperação de processing preso
  UPDATE inbound_events SET status = 'processing', locked_by = 'morto', locked_at = NOW() - interval '1 hour'
  WHERE resource = '/orders/1' AND status = 'pending';
  SELECT * INTO w FROM public.rpc_claim_inbound_events('mercadolivre', 10, 'w3', 300) LIMIT 1;
  PERFORM pg_temp.eq(w.locked_by, 'w3', '1. evento preso em processing é recuperado');
  PERFORM pg_temp.eq(public.rpc_finish_inbound_event(w.id, 'w3', 'dead', 'sem jeito'), true, '1. dead-letter');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM public.rpc_claim_inbound_events('mercadolivre', 10, 'w4', 300)), 0, '1. dead não é reivindicado');
END $$;

-- ─── 2. Importação produto normal ─────────────────────────────────────────
DO $$
DECLARE co bigint; r jsonb; s record; mov int; fe int; i int;
BEGIN
  co := pg_temp.upsert(pg_temp.order_json('2000001', 50, 8.5, 3),
          jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, pg_temp.listing('MLB100'))));
  INSERT INTO ctx VALUES ('co1', co);
  PERFORM pg_temp.eq((SELECT processing_state FROM channel_orders WHERE id = co), 'pending', '2. pedido novo fica pending (sem venda)');

  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(50));
  PERFORM pg_temp.eq(r->>'result', 'imported', '2. pedido pago importado');
  SELECT * INTO s FROM sales WHERE id = (r->>'sale_id')::int;
  INSERT INTO ctx VALUES ('sale1', s.id);
  PERFORM pg_temp.eq(s.sales_channel, 'mercadolivre', '2. sales_channel = mercadolivre');
  PERFORM pg_temp.eq(s.total, 50.00::numeric, '2. venda pelo valor BRUTO (não o líquido)');
  PERFORM pg_temp.eq(s.shipping_charged, 0.00::numeric, '2. frete do comprador não vira receita');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_items WHERE sale_id = s.id AND product_variation_id = pg_temp.c('v_n')::int), 1, '2. item correto');
  PERFORM pg_temp.eq((SELECT method::text || '|' || net_amount || '|' || external_payment_id || '|' || acquirer || '|' || (metadata->>'provider_payment_method')
                      FROM sale_payments WHERE sale_id = s.id), 'credit_card|50.00|PAY-1|mercadolivre|visa', '2. pagamento com id externo e método original');
  PERFORM pg_temp.eq((SELECT amount FROM finance_entries WHERE sale_id = s.id AND type = 'income' AND category = 'sale'), 50.00::numeric, '2. receita bruta 50');
  PERFORM pg_temp.eq((SELECT amount FROM finance_entries WHERE sale_id = s.id AND type = 'expense' AND category = 'marketplace_fee'), 8.50::numeric, '2. tarifa ML 8,50 (marketplace_fee)');
  PERFORM pg_temp.eq((SELECT amount FROM finance_entries WHERE sale_id = s.id AND type = 'expense' AND category = 'freight_cost'), 3.00::numeric, '2. frete do vendedor 3,00 (freight_cost)');
  PERFORM pg_temp.eq((SELECT net_amount FROM channel_orders WHERE id = co), 38.50::numeric, '2. líquido previsto 38,50');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM cashback_transactions WHERE sale_id = s.id), 0, '2. marketplace NÃO gera cashback');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('main_a')::int), 0, '2. estoque -1 (loja primeiro, prioridade 1)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('dep_a')::int), 2, '2. depósito intacto');
  PERFORM pg_temp.eq((SELECT sale_id || '|' || processing_state || '|' || fees_posted || '|' || shipping_posted FROM channel_orders WHERE id = co),
    s.id || '|imported|8.50|3.00', '2. sale_id vinculado na mesma transação');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM integration_outbox WHERE event_type = 'sale.completed' AND aggregate_id = s.id::text), 1, '2. outbox sale.completed emitido pelo core');
  PERFORM pg_temp.eq((SELECT payload->>'sales_channel' FROM integration_outbox WHERE event_type = 'sale.completed' AND aggregate_id = s.id::text), 'mercadolivre', '2. evento carrega o canal');

  -- 3. idempotência: reprocessar 3x
  SELECT count(*) INTO mov FROM stock_movements WHERE reference_id = s.id::text;
  SELECT count(*) INTO fe FROM finance_entries WHERE sale_id = s.id;
  FOR i IN 1..3 LOOP
    PERFORM pg_temp.upsert(pg_temp.order_json('2000001', 50, 8.5, 3),
      jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, pg_temp.listing('MLB100'))));
    PERFORM pg_temp.eq(public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(50))->>'result',
      'already_imported', '3. reprocesso #' || i || ' é NO-OP');
  END LOOP;
  PERFORM pg_temp.eq((SELECT count(*)::int FROM channel_orders WHERE external_order_id = '2000001'), 1, '3. 1 channel_order');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sales WHERE notes LIKE '%#2000001'), 1, '3. 1 venda');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE reference_id = s.id::text), mov, '3. 1 baixa');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM finance_entries WHERE sale_id = s.id), fe, '3. 1 conjunto de lançamentos');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM channel_order_items WHERE channel_order_id = co), 1, '3. itens congelados após venda');
END $$;

-- ─── 4. Custos que mudam depois: só a diferença ───────────────────────────
DO $$
DECLARE co bigint := pg_temp.c('co1')::bigint; r jsonb;
BEGIN
  PERFORM pg_temp.upsert(pg_temp.order_json('2000001', 50, 9.0, 3), '[]');
  r := public.rpc_sync_channel_order_costs(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq(r->>'result', 'adjusted', '4. tarifa mudou 8,50 → 9,00');
  PERFORM pg_temp.eq((SELECT amount FROM finance_entries WHERE sale_id = pg_temp.c('sale1')::int AND description LIKE 'Ajuste tarifa%'), 0.50::numeric, '4. lança só a diferença (0,50)');
  PERFORM pg_temp.eq(public.rpc_sync_channel_order_costs(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid)->>'result', 'noop', '4. repetir não duplica');
  PERFORM pg_temp.eq((SELECT fees_posted FROM channel_orders WHERE id = co), 9.00::numeric, '4. fees_posted atualizado');
END $$;

-- ─── 5. Kit ────────────────────────────────────────────────────────────────
DO $$
DECLARE co bigint; r jsonb; sid int;
BEGIN
  co := pg_temp.upsert(pg_temp.order_json('2000002', 79.9, 13.58, 0),
          jsonb_build_array(pg_temp.item_json('MLB200', 'TEST-ML-KIT-01', 1, 79.9, 13.58, pg_temp.c('v_kit')::int, pg_temp.listing('MLB200'))));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(79.9, 'digital_wallet', 'PAY-2'));
  PERFORM pg_temp.eq(r->>'result', 'imported', '5. kit importado');
  sid := (r->>'sale_id')::int;
  PERFORM pg_temp.eq((SELECT count(*)::int || '|' || min(product_variation_id) FROM sale_items WHERE sale_id = sid), '1|' || pg_temp.c('v_kit'), '5. comercialmente 1x KIT (nenhum componente como item)');
  PERFORM pg_temp.eq((SELECT total FROM sales WHERE id = sid), 79.90::numeric, '5. financeiro pelo valor do kit');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_ca')::int, pg_temp.c('main_a')::int), 4, '5. componente A −1');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_cb')::int, pg_temp.c('main_a')::int), 4, '5. componente B −2');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_item_components WHERE sale_id = sid), 2, '5. snapshot de componentes com local de saída');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_balances WHERE product_variation_id = pg_temp.c('v_kit')::int), 0, '5. kit sem saldo físico');
  PERFORM pg_temp.eq((SELECT method::text FROM sale_payments WHERE sale_id = sid), 'digital_wallet', '5. saldo Mercado Pago → digital_wallet (não distorce para pix)');
  INSERT INTO ctx VALUES ('co_kit', co), ('sale_kit', sid);
END $$;

-- ─── 6. Oversale / sem vínculo / pagamento divergente ──────────────────────
DO $$
DECLARE co bigint; r jsonb; before_mov int;
BEGIN
  SELECT count(*) INTO before_mov FROM stock_movements WHERE company_id = pg_temp.c('a')::int;
  co := pg_temp.upsert(pg_temp.order_json('2000003', 500, 85, 0),
          jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 10, 50, 85, pg_temp.c('v_n')::int, pg_temp.listing('MLB100'))));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(500, 'credit_card', 'PAY-3'));
  PERFORM pg_temp.eq(r->>'result' || '|' || (r->>'code'), 'needs_attention|insufficient_stock', '6. pago sem estoque → needs_attention');
  PERFORM pg_temp.eq((SELECT processing_state || '|' || attention_code FROM channel_orders WHERE id = co), 'needs_attention|insufficient_stock', '6. motivo registrado');
  PERFORM pg_temp.eq((SELECT sale_id FROM channel_orders WHERE id = co), NULL::int, '6. sem venda parcial');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('dep_a')::int), 2, '6. estoque intacto (sem negativo)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE company_id = pg_temp.c('a')::int), before_mov, '6. nenhuma baixa');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM sale_payments WHERE external_payment_id = 'PAY-3'), 0, '6. nenhum pagamento gravado');

  co := pg_temp.upsert(pg_temp.order_json('2000004', 30, 5, 0),
          jsonb_build_array(pg_temp.item_json('MLB999', 'SKU-DESCONHECIDO', 1, 30, 5, NULL, NULL)));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(30, 'pix', 'PAY-4'));
  PERFORM pg_temp.eq(r->>'code', 'unmapped_items', '6. item sem mapping → needs_attention');
  PERFORM pg_temp.eq((SELECT attention_reason FROM channel_orders WHERE id = co) LIKE '%SKU-DESCONHECIDO%', true, '6. motivo cita o SKU');

  co := pg_temp.upsert(pg_temp.order_json('2000005', 50, 8.5, 0),
          jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, pg_temp.listing('MLB100'))));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(41.5, 'credit_card', 'PAY-5'));
  PERFORM pg_temp.eq(r->>'code', 'payment_mismatch', '6. pagamento ≠ bruto → needs_attention (nunca venda pelo líquido)');
  INSERT INTO ctx VALUES ('co_mismatch', co);
  -- corrigido → importa na mesma linha
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(50, 'credit_card', 'PAY-5'));
  PERFORM pg_temp.eq(r->>'result', 'imported', '6. após correção importa (needs_attention não é terminal)');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('dep_a')::int), 1, '6. loja zerada → saiu do depósito (prioridade 2)');
END $$;

-- ─── 7. Cliente: mesmo comprador → mesmo cliente ──────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.eq((SELECT count(DISTINCT customer_id)::int FROM channel_orders WHERE buyer_external_id = '9001' AND sale_id IS NOT NULL), 1,
    '7. mesmo buyer em vários pedidos → 1 cliente');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM external_entity_links WHERE external_entity_type = 'buyer' AND external_id = '9001'), 1, '7. 1 vínculo externo');
  PERFORM pg_temp.eq((SELECT cpf IS NULL AND phone IS NULL FROM customers WHERE id = (SELECT customer_id FROM channel_orders WHERE id = pg_temp.c('co1')::bigint)),
    true, '7. não depende de CPF/telefone');
END $$;

-- ─── 8. Cancelamento idempotente ──────────────────────────────────────────
DO $$
DECLARE co bigint := pg_temp.c('co_kit')::bigint; sid int := pg_temp.c('sale_kit')::int; r jsonb; fe int; mov int;
BEGIN
  r := public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, 'cancelado pelo comprador');
  PERFORM pg_temp.eq(r->>'result', 'cancelled', '8. pedido cancelado no canal → venda cancelada');
  PERFORM pg_temp.eq((SELECT status::text FROM sales WHERE id = sid), 'cancelled', '8. venda cancelada uma vez');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_ca')::int, pg_temp.c('main_a')::int), 5, '8. kit devolve componente A');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_cb')::int, pg_temp.c('main_a')::int), 6, '8. kit devolve componente B');
  PERFORM pg_temp.eq((SELECT amount FROM finance_entries WHERE sale_id = sid AND type = 'income' AND category = 'marketplace_fee'), 13.58::numeric, '8. estorno da tarifa (histórico preservado)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM finance_entries WHERE sale_id = sid AND type = 'expense' AND category = 'marketplace_fee'), 1, '8. lançamento original mantido');
  SELECT count(*) INTO fe FROM finance_entries WHERE sale_id = sid;
  SELECT count(*) INTO mov FROM stock_movements WHERE reference_id = sid::text;
  PERFORM pg_temp.eq(public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid)->>'result', 'already_cancelled', '8. cancelamento repetido é NO-OP');
  PERFORM pg_temp.eq(public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid)->>'result', 'already_cancelled', '8. terceiro cancelamento é NO-OP');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM finance_entries WHERE sale_id = sid), fe, '8. nenhuma reversão financeira repetida');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE reference_id = sid::text), mov, '8. nenhuma devolução de estoque repetida');
  PERFORM pg_temp.eq(public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(79.9))->>'result', 'already_imported', '8. cancelado não reimporta');

  co := pg_temp.upsert(pg_temp.order_json('2000006', 50, 8.5, 0, 'payment_in_process'),
          jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, pg_temp.listing('MLB100'))));
  PERFORM pg_temp.eq(public.rpc_set_channel_order_state(pg_temp.c('a')::int, co, 'awaiting_payment'), true, '8. não pago → awaiting_payment (sem venda)');
  PERFORM pg_temp.eq(public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid)->>'result', 'cancelled_without_sale', '8. cancelar pedido sem venda');
END $$;

-- ─── 9. DRE: tarifas de marketplace líquidas ──────────────────────────────
DO $$
DECLARE v numeric;
BEGIN
  SELECT tarifas_marketplace INTO v FROM vw_dre_mensal WHERE company_id = pg_temp.c('a')::int AND mes = DATE_TRUNC('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::date;
  -- 8,50 + 0,50 (ajuste) + 8,50 (pedido 2000005) + 13,58 − 13,58 (estorno do kit) = 17,50
  PERFORM pg_temp.eq(v, 17.50::numeric, '9. DRE soma tarifas de marketplace, líquidas de estornos');
  PERFORM pg_temp.eq((SELECT total_opex >= tarifas_marketplace FROM vw_dre_mensal WHERE company_id = pg_temp.c('a')::int
                      AND mes = DATE_TRUNC('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::date), true, '9. tarifas entram no opex');
END $$;

-- ─── 14. 1 variação → N ofertas (Clássico + Premium) ──────────────────────
DO $$
DECLARE co bigint; r jsonb; sid int; premium bigint; before_dep int;
BEGIN
  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, external_listing_id,
                                external_product_id, local_status, offer_key, listing_type_id, channel_price)
  SELECT company_id, integration_id, provider, product_id, product_variation_id, seller_sku, 'MLB101', 'MLBU-N', 'active', 'gold_pro', 'gold_pro', 44.90
  FROM channel_listings WHERE external_listing_id = 'MLB100'
  RETURNING id INTO premium;
  UPDATE channel_listings SET external_product_id = 'MLBU-N' WHERE external_listing_id = 'MLB100';
  PERFORM pg_temp.eq((SELECT count(*)::int FROM channel_listings WHERE product_variation_id = pg_temp.c('v_n')::int AND local_status <> 'closed'), 2,
    '14. mesma variação com 2 ofertas vivas');

  before_dep := pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('dep_a')::int);
  co := pg_temp.upsert(pg_temp.order_json('2000014', 44.9, 7.63, 0),
          jsonb_build_array(pg_temp.item_json('MLB101', 'TEST-ML-NORMAL-01', 1, 44.9, 7.63, pg_temp.c('v_n')::int, premium)));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(44.9, 'credit_card', 'PAY-14'));
  PERFORM pg_temp.eq(r->>'result', 'imported', '14. venda pela oferta Premium');
  PERFORM pg_temp.eq((SELECT channel_listing_id || '|' || listing_resolution FROM channel_order_items WHERE channel_order_id = co), premium || '|exact',
    '14. pedido preserva QUAL oferta originou a venda');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('dep_a')::int), before_dep - 1, '14. baixa no MESMO estoque-mãe da variação');
  PERFORM pg_temp.eq((SELECT total FROM sales WHERE id = (r->>'sale_id')::int), 44.90::numeric, '14. preço da oferta Premium');

  -- oferta não identificada exatamente, mas a variação sim → importa sem inventar oferta
  PERFORM pg_temp.set_stock(pg_temp.c('v_n')::int, pg_temp.c('main_a')::int, 2);
  co := pg_temp.upsert(pg_temp.order_json('2000015', 50, 8.5, 0),
          jsonb_build_array(pg_temp.item_json('MLB-NOVO', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, NULL, 'ambiguous_same_variation')));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(50, 'credit_card', 'PAY-15'));
  PERFORM pg_temp.eq(r->>'result', 'imported', '14. oferta ambígua da MESMA variação → importa (não perde venda)');
  PERFORM pg_temp.eq((SELECT COALESCE(channel_listing_id::text, 'null') || '|' || listing_resolution || '|' || external_item_id || '|' || external_user_product_id
                      FROM channel_order_items WHERE channel_order_id = co), 'null|ambiguous_same_variation|MLB-NOVO|MLBU-N',
    '14. channel_listing_id NÃO inventado; ids externos preservados; resolução auditável');
  PERFORM pg_temp.expect_error(format($q$UPDATE channel_order_items SET listing_resolution = 'exact' WHERE channel_order_id = %s$q$, co),
    'channel_order_items_resolution_listing', '14. "exact" exige anúncio identificado');
  co := pg_temp.upsert(pg_temp.order_json('2000016', 50, 8.5, 0),
          jsonb_build_array(pg_temp.item_json('MLB-NOVO2', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, NULL)));
  PERFORM pg_temp.eq((SELECT listing_resolution FROM channel_order_items WHERE channel_order_id = co), 'ambiguous_same_variation',
    '14. mapeado sem oferta nunca vira "exact" por padrão');
END $$;

-- ─── 10. Estoque → canais (processador marca anúncio pendente) ─────────────
DO $$
DECLARE r jsonb;
BEGIN
  UPDATE channel_listings SET stock_sync_pending = false;
  r := public.rpc_process_stock_availability_changes(1000, 'teste');
  PERFORM pg_temp.eq((SELECT stock_sync_pending FROM channel_listings WHERE external_listing_id = 'MLB100'), true, '10. venda → anúncio marcado para reenviar quantidade');
  PERFORM pg_temp.eq((SELECT bool_and(stock_sync_pending) FROM channel_listings WHERE product_variation_id = pg_temp.c('v_n')::int AND local_status <> 'closed'), true,
    '10. TODAS as ofertas da variação (Clássico e Premium) recebem a nova disponibilidade');
  PERFORM pg_temp.eq(r->'changed_variation_ids' @> to_jsonb(pg_temp.c('v_n')::int), true, '10. processador devolve variações alteradas');
END $$;

-- ─── 15. Venda pela oferta A e pela B; kit com 2 ofertas; convergência inversa ───
DO $$
DECLARE co bigint; r jsonb; classic bigint; kit_pro bigint; sid int; before_main int; before_a int; before_b int;
BEGIN
  SELECT id INTO classic FROM channel_listings WHERE external_listing_id = 'MLB100';
  before_main := pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('main_a')::int);
  co := pg_temp.upsert(pg_temp.order_json('2000017', 50, 8.5, 0),
          jsonb_build_array(pg_temp.item_json('MLB100', 'TEST-ML-NORMAL-01', 1, 50, 8.5, pg_temp.c('v_n')::int, classic)));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(50, 'credit_card', 'PAY-17'));
  PERFORM pg_temp.eq(r->>'result', 'imported', '15. venda pela oferta A (Clássico) com a B (Premium) viva');
  PERFORM pg_temp.eq((SELECT channel_listing_id FROM channel_order_items WHERE channel_order_id = co), classic, '15. pedido aponta para a oferta A');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_n')::int, pg_temp.c('main_a')::int), before_main - 1, '15. mesma variação baixada UMA vez');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE reference_id = (r->>'sale_id')), 1, '15. uma única movimentação');

  -- kit com 2 ofertas: vende pela Premium do kit
  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, external_listing_id, local_status, offer_key, listing_type_id, channel_price)
  SELECT company_id, integration_id, provider, product_id, product_variation_id, seller_sku, 'MLB201', 'active', 'gold_pro', 'gold_pro', 89.9
  FROM channel_listings WHERE external_listing_id = 'MLB200' RETURNING id INTO kit_pro;
  before_a := pg_temp.qty(pg_temp.c('v_ca')::int, pg_temp.c('main_a')::int);
  before_b := pg_temp.qty(pg_temp.c('v_cb')::int, pg_temp.c('main_a')::int);
  co := pg_temp.upsert(pg_temp.order_json('2000018', 89.9, 15.28, 0),
          jsonb_build_array(pg_temp.item_json('MLB201', 'TEST-ML-KIT-01', 1, 89.9, 15.28, pg_temp.c('v_kit')::int, kit_pro)));
  r := public.rpc_import_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, pg_temp.pay(89.9, 'credit_card', 'PAY-18'));
  sid := (r->>'sale_id')::int;
  PERFORM pg_temp.eq(r->>'result', 'imported', '15. kit vendido pela 2ª oferta');
  PERFORM pg_temp.eq((SELECT channel_listing_id FROM channel_order_items WHERE channel_order_id = co), kit_pro, '15. pedido do kit aponta para a oferta Premium do kit');
  PERFORM pg_temp.eq((SELECT count(*)::int || '|' || min(product_variation_id) FROM sale_items WHERE sale_id = sid), '1|' || pg_temp.c('v_kit'), '15. comercialmente 1 KIT');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_ca')::int, pg_temp.c('main_a')::int), before_a - 1, '15. componente A −1');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_cb')::int, pg_temp.c('main_a')::int), before_b - 2, '15. componente B −2');

  -- convergência: as 2 ofertas do kit e as 2 da variação normal ficam pendentes de sincronização
  UPDATE channel_listings SET stock_sync_pending = false;
  PERFORM public.rpc_process_stock_availability_changes(1000, 'teste-15');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM channel_listings WHERE stock_sync_pending AND product_variation_id IN (pg_temp.c('v_kit')::int, pg_temp.c('v_n')::int)), 4,
    '15. todas as ofertas (normal e kit) recebem a nova disponibilidade');

  -- cancelamento → estoque volta e as ofertas convergem de novo
  r := public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid, 'teste');
  PERFORM pg_temp.eq(r->>'result', 'cancelled', '15. cancelamento do pedido do kit');
  PERFORM pg_temp.eq(pg_temp.qty(pg_temp.c('v_ca')::int, pg_temp.c('main_a')::int) || '|' || pg_temp.qty(pg_temp.c('v_cb')::int, pg_temp.c('main_a')::int),
    before_a || '|' || before_b, '15. componentes exatos devolvidos');
  UPDATE channel_listings SET stock_sync_pending = false;
  PERFORM public.rpc_process_stock_availability_changes(1000, 'teste-15b');
  PERFORM pg_temp.eq((SELECT bool_and(stock_sync_pending) FROM channel_listings WHERE product_variation_id = pg_temp.c('v_kit')::int), true,
    '15. convergência inversa: as 2 ofertas do kit remarcadas após o cancelamento');
  PERFORM pg_temp.eq(public.rpc_cancel_channel_order(pg_temp.c('a')::int, co, pg_temp.c('ua')::uuid)->>'result', 'already_cancelled', '15. 2º cancelamento é NO-OP');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM stock_movements WHERE reference_id = sid::text AND movement_type = 'cancel'), 2, '15. devolução registrada uma única vez (2 componentes)');
END $$;

-- ─── 11. Multi-tenant ──────────────────────────────────────────────────────
DO $$
DECLARE ok boolean;
BEGIN
  PERFORM pg_temp.expect_error(format('SELECT public.rpc_import_channel_order(%s, %s, %L::uuid, %L::jsonb)',
    pg_temp.c('b'), pg_temp.c('co1'), pg_temp.c('ub'), pg_temp.pay(50)::text), 'não encontrado', '11. empresa B não importa pedido da A');
  PERFORM pg_temp.expect_error(format('SELECT public.rpc_cancel_channel_order(%s, %s, %L::uuid)',
    pg_temp.c('b'), pg_temp.c('co1'), pg_temp.c('ub')), 'não encontrado', '11. empresa B não cancela pedido da A');
  PERFORM pg_temp.expect_error(format($q$SELECT pg_temp.upsert(%L::jsonb, '[]'::jsonb, %s, %s)$q$,
    pg_temp.order_json('3000001', 10, 1, 0)::text, pg_temp.c('a'), pg_temp.c('ib')), 'não pertence', '11. integração de outra empresa recusada');
  PERFORM pg_temp.expect_error(format($q$SELECT pg_temp.upsert(%L::jsonb, %L::jsonb)$q$,
    pg_temp.order_json('3000002', 10, 1, 0)::text,
    jsonb_build_array(pg_temp.item_json('X', 'CO-B-1', 1, 10, 1, pg_temp.c('v_b')::int, NULL))::text), 'não pertence', '11. variação de outra empresa recusada');
  PERFORM pg_temp.eq(public.rpc_set_channel_order_state(pg_temp.c('b')::int, pg_temp.c('co1')::bigint, 'ignored'), false, '11. empresa B não muda estado da A');
  PERFORM pg_temp.eq(public.rpc_set_channel_order_state(pg_temp.c('a')::int, pg_temp.c('co1')::bigint, 'needs_attention', 'x', 'y'), false, '11. importado não volta para needs_attention');
  PERFORM pg_temp.expect_error(format($q$SELECT public.rpc_set_channel_order_state(%s, %s, 'imported')$q$, pg_temp.c('a'), pg_temp.c('co1')), 'não permitido', '11. imported só pela importação');
END $$;

-- ─── 12. Outros canais: cashback inalterado ────────────────────────────────
DO $$
DECLARE r jsonb; cust int;
BEGIN
  INSERT INTO customers (name, company_id) VALUES ('Cliente PDV', pg_temp.c('a')::int) RETURNING id INTO cust;
  r := public.rpc_create_sale(
    p_customer_id => cust, p_seller_id => pg_temp.c('ua')::uuid, p_payment_method => 'pix', p_sale_origin => NULL,
    p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0, p_notes => 'PDV', p_system_user_id => pg_temp.c('ua')::uuid,
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', pg_temp.c('v_ca')::int, 'quantity', 1, 'unit_price', 10, 'unit_cost', 5)),
    p_payments => jsonb_build_array(jsonb_build_object('method', 'pix', 'net_amount', 10, 'amount_tendered', 10)),
    p_sales_channel => 'pos');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM cashback_transactions WHERE sale_id = (r->>'id')::int AND type = 'earn'), 1, '12. PDV continua gerando cashback (default preservado)');
END $$;

-- ─── 13. RLS / grants ──────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.eq((SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.channel_orders'::regclass, 'public.channel_order_items'::regclass, 'public.inbound_events'::regclass)), true, '13. RLS ligado');
  PERFORM pg_temp.eq(has_table_privilege('authenticated', 'public.channel_orders', 'SELECT'), false, '13. authenticated sem SELECT direto');
  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.rpc_import_channel_order(int, bigint, uuid, jsonb)', 'EXECUTE'), false, '13. authenticated não importa');
  PERFORM pg_temp.eq(has_function_privilege('anon', 'public.rpc_enqueue_inbound_event(text, text, text, text, text, text, jsonb)', 'EXECUTE'), false, '13. anon não enfileira direto');
  PERFORM pg_temp.eq(has_function_privilege('service_role', 'public.rpc_cancel_channel_order(int, bigint, uuid, text)', 'EXECUTE'), true, '13. service_role cancela');
END $$;

DO $$ BEGIN RAISE NOTICE 'channel_orders: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
