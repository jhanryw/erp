-- =============================================================================
-- channel_listings.test.sql — vínculo genérico de anúncios (202609251000).
-- BEGIN/ROLLBACK, empresas próprias. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/channel_listings.test.sql
-- Sucesso = "channel_listings: TODOS OS CENÁRIOS PASSARAM".
-- =============================================================================
BEGIN;

CREATE FUNCTION pg_temp.eq(actual anyelement, expected anyelement, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FALHOU [%]: esperado %, obtido %', label, expected, actual; END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text) ON COMMIT DROP;
DO $$
DECLARE a int; b int; ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  cat_a int; cat_b int; p_a int; p_b int; v1 int; v2 int; vb int; ia bigint; ib bigint; ns bigint;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE CL A', 'teste-cl-a-' || ua) RETURNING id INTO a;
  INSERT INTO companies (name, slug) VALUES ('TESTE CL B', 'teste-cl-b-' || ub) RETURNING id INTO b;
  INSERT INTO auth.users (id) VALUES (ua), (ub);
  INSERT INTO categories (name, slug, company_id) VALUES ('Cat A', 'cl-a-' || a, a) RETURNING id INTO cat_a;
  INSERT INTO categories (name, slug, company_id) VALUES ('Cat B', 'cl-b-' || b, b) RETURNING id INTO cat_b;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Sutiã TESTE', 'CL-SUT', cat_a, 10, 49.9, a, 'sutia', 'teste', '2026') RETURNING id INTO p_a;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_a, 'CL-SUT-P') RETURNING id INTO v1;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_a, 'CL-SUT-M') RETURNING id INTO v2;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Outro', 'CL-OUT', cat_b, 5, 20, b, 'calcinha', 'teste', '2026') RETURNING id INTO p_b;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p_b, 'CL-OUT-U') RETURNING id INTO vb;
  INSERT INTO company_integrations (company_id, provider, status) VALUES (a, 'mercadolivre', 'active') RETURNING id INTO ia;
  INSERT INTO company_integrations (company_id, provider, status) VALUES (b, 'mercadolivre', 'active') RETURNING id INTO ib;
  INSERT INTO company_integrations (company_id, provider, status) VALUES (a, 'nuvemshop', 'active') RETURNING id INTO ns;
  INSERT INTO ctx VALUES ('a', a), ('b', b), ('ua', ua), ('p_a', p_a), ('p_b', p_b), ('v1', v1), ('v2', v2), ('vb', vb), ('ia', ia), ('ib', ib), ('ns', ns);
END $$;
CREATE FUNCTION pg_temp.c(k text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM ctx WHERE ctx.k = $1 $$;
CREATE FUNCTION pg_temp.begin_pub(company int, integ bigint, product int, variation int, attempt uuid, lease int DEFAULT 60)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT rpc_begin_channel_listing_publish(company, integ, 'mercadolivre', product, variation, 'CL-SUT-P', attempt, lease, NULL, '{"category_id":"MLB1"}'::jsonb, pg_temp.c('ua')::uuid)
$$;
CREATE FUNCTION pg_temp.complete_pub(company int, listing bigint, attempt uuid, ext text)
RETURNS boolean LANGUAGE sql AS $$
  SELECT rpc_complete_channel_listing_publish(company, listing, attempt, ext, NULL, 'MLBU1', '99', '{"user_product_id":"MLBU1","family_id":"99"}'::jsonb,
    'MLB1', 'active', ARRAY[]::text[], 'https://p/' || ext, 49.9, 7, NULL)
$$;

-- ─── begin / complete / fail com fencing ────────────────────────────────────
DO $$
DECLARE r jsonb; lid bigint; att1 uuid := gen_random_uuid(); att2 uuid := gen_random_uuid();
  a int := pg_temp.c('a')::int; ia bigint := pg_temp.c('ia')::bigint; p int := pg_temp.c('p_a')::int; v1 int := pg_temp.c('v1')::int;
BEGIN
  r := pg_temp.begin_pub(a, ia, p, v1, att1);
  PERFORM pg_temp.eq(r->>'result', 'claimed', 'primeira reserva → claimed');
  lid := (r->>'listing_id')::bigint;
  INSERT INTO ctx VALUES ('l1', lid);
  PERFORM pg_temp.eq((SELECT local_status FROM channel_listings WHERE id = lid), 'publishing', 'linha em publishing com lease');

  PERFORM pg_temp.eq(pg_temp.begin_pub(a, ia, p, v1, att2)->>'result', 'in_progress', 'segunda reserva com lease vivo → in_progress');
  PERFORM pg_temp.eq(pg_temp.complete_pub(a, lid, att2, 'MLB999'), false, 'attempt que não é dono não completa (fencing)');
  PERFORM pg_temp.eq(rpc_fail_channel_listing_publish(a, lid, att2, 'x'), false, 'attempt que não é dono não falha');
  PERFORM pg_temp.eq(pg_temp.complete_pub(pg_temp.c('b')::int, lid, att1, 'MLB999'), false, 'outra empresa não completa');

  PERFORM pg_temp.eq(pg_temp.complete_pub(a, lid, att1, 'MLB100'), true, 'dono completa');
  PERFORM pg_temp.eq((SELECT local_status || '|' || external_listing_id || '|' || external_product_id || '|' || external_group_id || '|' || (external_ids->>'user_product_id') || '|' || synced_quantity
                      FROM channel_listings WHERE id = lid), 'active|MLB100|MLBU1|99|MLBU1|7', 'ids externos (User Products) persistidos');
  PERFORM pg_temp.eq((SELECT publish_attempt_id IS NULL AND publish_lease_until IS NULL FROM channel_listings WHERE id = lid), true, 'lease liberado');
  PERFORM pg_temp.eq(pg_temp.begin_pub(a, ia, p, v1, gen_random_uuid())->>'result', 'already_published', 'publicação duplicada → already_published');
  PERFORM pg_temp.eq(pg_temp.complete_pub(a, lid, att1, 'MLB101'), false, 'complete repetido não sobrescreve');
END $$;

-- ─── erro → nova tentativa reaproveita a linha ─────────────────────────────
DO $$
DECLARE r jsonb; lid bigint; att uuid := gen_random_uuid();
  a int := pg_temp.c('a')::int; ia bigint := pg_temp.c('ia')::bigint; p int := pg_temp.c('p_a')::int; v2 int := pg_temp.c('v2')::int;
BEGIN
  r := pg_temp.begin_pub(a, ia, p, v2, att);
  lid := (r->>'listing_id')::bigint;
  PERFORM pg_temp.eq(rpc_fail_channel_listing_publish(a, lid, att, 'ML 400'), true, 'dono registra falha');
  PERFORM pg_temp.eq((SELECT local_status || '|' || last_error FROM channel_listings WHERE id = lid), 'error|ML 400', 'status error + last_error');
  r := pg_temp.begin_pub(a, ia, p, v2, gen_random_uuid());
  PERFORM pg_temp.eq(r->>'result', 'claimed', 'após erro, nova reserva é permitida');
  PERFORM pg_temp.eq((r->>'listing_id')::bigint, lid, 'mesma linha reaproveitada (sem duplicar)');
  PERFORM pg_temp.eq((SELECT last_error FROM channel_listings WHERE id = lid), NULL, 'last_error limpo ao reservar');
  INSERT INTO ctx VALUES ('l2', lid);
END $$;

-- ─── queda no meio: lease vencido → needs_reconciliation ───────────────────
DO $$
DECLARE lid bigint := pg_temp.c('l2')::bigint;
  a int := pg_temp.c('a')::int; ia bigint := pg_temp.c('ia')::bigint; p int := pg_temp.c('p_a')::int; v2 int := pg_temp.c('v2')::int;
BEGIN
  PERFORM pg_temp.eq(pg_temp.complete_pub(a, lid, NULL, 'MLB200'), false, 'reconciliação não assume lease VIVO');
  UPDATE channel_listings SET publish_lease_until = NOW() - interval '1 second' WHERE id = lid;
  PERFORM pg_temp.eq(pg_temp.begin_pub(a, ia, p, v2, gen_random_uuid())->>'result', 'needs_reconciliation', 'lease vencido em publishing → needs_reconciliation (nunca republica às cegas)');
  PERFORM pg_temp.eq(pg_temp.complete_pub(a, lid, NULL, 'MLB200'), true, 'reconciliação (attempt NULL) vincula o anúncio achado por SKU');
  PERFORM pg_temp.eq((SELECT local_status || '|' || external_listing_id FROM channel_listings WHERE id = lid), 'active|MLB200', 'vínculo reconciliado');
END $$;

-- ─── unicidade e multi-tenant ──────────────────────────────────────────────
DO $$
DECLARE ok boolean;
  a int := pg_temp.c('a')::int; b int := pg_temp.c('b')::int; ia bigint := pg_temp.c('ia')::bigint; ib bigint := pg_temp.c('ib')::bigint;
  p int := pg_temp.c('p_a')::int; pb int := pg_temp.c('p_b')::int; v1 int := pg_temp.c('v1')::int; vb int := pg_temp.c('vb')::int;
BEGIN
  ok := false;
  BEGIN
    INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, local_status, external_listing_id)
    VALUES (a, ia, 'mercadolivre', p, v1, 'CL-SUT-P', 'active', 'MLB300');
  EXCEPTION WHEN unique_violation THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, '1 vínculo vivo por variação × integração');

  ok := false;
  BEGIN
    UPDATE channel_listings SET external_listing_id = 'MLB100' WHERE id = pg_temp.c('l2')::bigint;
  EXCEPTION WHEN unique_violation THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'mesmo anúncio externo não vincula duas vezes');

  ok := false;
  BEGIN PERFORM pg_temp.begin_pub(a, ib, p, v1, gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'integração de outra empresa recusada (trigger)');

  ok := false;
  BEGIN PERFORM pg_temp.begin_pub(a, ia, pb, vb, gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'produto/variação de outra empresa recusado (trigger)');

  ok := false;
  BEGIN PERFORM pg_temp.begin_pub(a, pg_temp.c('ns')::bigint, p, v1, gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'integração de outro provider recusada (trigger)');

  -- empresa B com integração/produto de A: não enxerga a linha de A e o INSERT é recusado
  ok := false;
  BEGIN PERFORM pg_temp.begin_pub(b, ia, p, pg_temp.c('v2')::int, gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'empresa B não reserva recurso da empresa A (trigger)');
  PERFORM pg_temp.eq(rpc_fail_channel_listing_publish(b, pg_temp.c('l1')::bigint, NULL, 'x'), false, 'empresa B não altera vínculo de A');
END $$;

-- ─── CHECKs, RLS e grants ─────────────────────────────────────────────────
DO $$
DECLARE ok boolean;
BEGIN
  ok := false;
  BEGIN UPDATE channel_listings SET local_status = 'publicado' WHERE id = pg_temp.c('l1')::bigint;
  EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'local_status restrito');
  ok := false;
  BEGIN UPDATE channel_listings SET synced_quantity = -1 WHERE id = pg_temp.c('l1')::bigint;
  EXCEPTION WHEN check_violation THEN ok := true; END;
  PERFORM pg_temp.eq(ok, true, 'synced_quantity nunca negativa');

  PERFORM pg_temp.eq((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.channel_listings'::regclass), true, 'RLS ligado');
  PERFORM pg_temp.eq(has_table_privilege('authenticated', 'public.channel_listings', 'SELECT'), false, 'authenticated sem SELECT direto');
  PERFORM pg_temp.eq(has_table_privilege('anon', 'public.channel_listings', 'SELECT'), false, 'anon sem SELECT');
  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid)', 'EXECUTE'), false, 'authenticated não executa begin');
  PERFORM pg_temp.eq(has_function_privilege('anon', 'public.rpc_complete_channel_listing_publish(int, bigint, uuid, text, text, text, text, jsonb, text, text, text[], text, numeric, int, text)', 'EXECUTE'), false, 'anon não executa complete');
  PERFORM pg_temp.eq(has_function_privilege('service_role', 'public.rpc_fail_channel_listing_publish(int, bigint, uuid, text)', 'EXECUTE'), true, 'service_role executa fail');
END $$;

DO $$ BEGIN RAISE NOTICE 'channel_listings: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
