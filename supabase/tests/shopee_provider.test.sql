-- =============================================================================
-- shopee_provider.test.sql — migration 202609281000 (provider/canal 'shopee'
-- e rpc_upsert_oauth_account_integration multi-loja) + reuso das RPCs
-- genéricas de OAuth/lease (202609241000) pelo provider 'shopee'.
-- BEGIN/ROLLBACK, empresas próprias. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/shopee_provider.test.sql
-- Sucesso = "shopee_provider: TODOS OS CENÁRIOS PASSARAM".
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
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE SHOPEE A', 'teste-shopee-a-' || ua) RETURNING id INTO a;
  INSERT INTO companies (name, slug) VALUES ('TESTE SHOPEE B', 'teste-shopee-b-' || ub) RETURNING id INTO b;
  INSERT INTO auth.users (id) VALUES (ua), (ub);
  INSERT INTO ctx VALUES ('a', a), ('b', b), ('ua', ua), ('ub', ub);
END $$;
CREATE FUNCTION pg_temp.c(k text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM ctx WHERE ctx.k = $1 $$;

-- ─── 1. company_integrations.provider ───────────────────────────────────────
DO $$
DECLARE p text; ok boolean;
BEGIN
  FOREACH p IN ARRAY ARRAY['chatwoot','meta','nuvemshop','focus_nfe','fiscal_certificate','mercadolivre','shopee'] LOOP
    INSERT INTO company_integrations (company_id, provider, status) VALUES (pg_temp.c('a')::int, p, 'pending');
  END LOOP;
  PERFORM pg_temp.eq(1, 1, 'provider aceita os 6 valores antigos + shopee');
  ok := false;
  BEGIN
    INSERT INTO company_integrations (company_id, provider, status) VALUES (pg_temp.c('a')::int, 'amazon', 'pending');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  PERFORM pg_temp.eq(ok, true, 'provider desconhecido continua recusado');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'public.company_integrations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ~* '\mstatus\M'), 1, 'CHECK de status preservado');
END $$;

-- ─── 2. sales.sales_channel (CHECKs copiados para tabela temporária) ─────────
CREATE TEMP TABLE sales_chk (LIKE public.sales INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP;
DO $$
DECLARE ch text; ok boolean;
BEGIN
  PERFORM pg_temp.eq((SELECT convalidated FROM pg_constraint WHERE conname = 'sales_sales_channel_valid' AND conrelid = 'public.sales'::regclass), true, 'sales_sales_channel_valid validada');
  FOREACH ch IN ARRAY ARRAY['pos','manual','whatsapp','nuvemshop','wholesale_site','mercadolivre','shopee'] LOOP
    INSERT INTO sales_chk (company_id, customer_id, seller_id, payment_method, sales_channel)
    VALUES (pg_temp.c('a')::int, 1, pg_temp.c('ua')::uuid, 'pix', ch);
  END LOOP;
  INSERT INTO sales_chk (company_id, customer_id, seller_id, payment_method, sales_channel) VALUES (pg_temp.c('a')::int, 1, pg_temp.c('ua')::uuid, 'pix', NULL);
  PERFORM pg_temp.eq(1, 1, 'sales_channel aceita NULL, os 6 valores antigos e shopee');
  ok := false;
  BEGIN
    INSERT INTO sales_chk (company_id, customer_id, seller_id, payment_method, sales_channel) VALUES (pg_temp.c('a')::int, 1, pg_temp.c('ua')::uuid, 'pix', 'amazon');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  PERFORM pg_temp.eq(ok, true, 'sales_channel desconhecido continua recusado');
END $$;

DELETE FROM company_integrations WHERE company_id = pg_temp.c('a')::int;

-- ─── 3. state OAuth com provider shopee ─────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO integration_oauth_states (provider, state_hash, company_id, user_id, expires_at)
  VALUES ('shopee', 'shp-hash-1', pg_temp.c('a')::int, pg_temp.c('ua')::uuid, NOW() + interval '10 minutes');
  r := rpc_consume_oauth_state('mercadolivre', 'shp-hash-1');
  PERFORM pg_temp.eq(r->>'status', 'not_found', 'state shopee não é consumível como mercadolivre');
  r := rpc_consume_oauth_state('shopee', 'shp-hash-1');
  PERFORM pg_temp.eq(r->>'status', 'ok', 'state shopee consumido');
  PERFORM pg_temp.eq((r->>'company_id')::int, pg_temp.c('a')::int, 'company_id vem do state');
  r := rpc_consume_oauth_state('shopee', 'shp-hash-1');
  PERFORM pg_temp.eq(r->>'status', 'consumed', 'state shopee de uso único');
END $$;

-- ─── 4. multi-loja: rpc_upsert_oauth_account_integration ─────────────────────
DO $$
DECLARE r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; ok boolean; a int := pg_temp.c('a')::int; b int := pg_temp.c('b')::int;
BEGIN
  r1 := rpc_upsert_oauth_account_integration(a, 'shopee', '1001', '{"shop_id":"1001"}', 'acc1', 'ref1', 1, NOW() + interval '4 hours', NULL, pg_temp.c('ua')::uuid);
  r2 := rpc_upsert_oauth_account_integration(a, 'shopee', '1002', '{"shop_id":"1002"}', 'acc2', 'ref2', 1, NOW() + interval '4 hours', NULL, pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq((r1->>'reconnected')::boolean, false, 'loja 1001 conectada (nova)');
  PERFORM pg_temp.eq((r2->>'reconnected')::boolean, false, 'loja 1002 conectada (nova, não substitui 1001)');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM company_integrations WHERE company_id = a AND provider = 'shopee' AND status = 'active'), 2, 'empresa A com 2 lojas ativas');

  r3 := rpc_upsert_oauth_account_integration(a, 'shopee', '1001', '{}', 'acc1b', 'ref1b', 1, NOW() + interval '4 hours', NULL, pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq(r3->>'integration_id', r1->>'integration_id', 'reconectar 1001 reaproveita a linha');
  PERFORM pg_temp.eq((SELECT ciphertext FROM integration_secrets WHERE integration_id = (r1->>'integration_id')::bigint AND key = 'refresh_token'), 'ref1b', 'refresh_token substituído');

  PERFORM rpc_disconnect_oauth_integration((r1->>'integration_id')::bigint, a, pg_temp.c('ua')::uuid);
  r4 := rpc_upsert_oauth_account_integration(a, 'shopee', '1001', '{}', 'acc1c', 'ref1c', 1, NOW() + interval '4 hours', NULL, pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq(r4->>'integration_id', r1->>'integration_id', 'reconectar após desconexão reaproveita a linha (previous_external_account_id)');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = (r1->>'integration_id')::bigint), 'active', 'loja 1001 ativa de novo');

  ok := false;
  BEGIN
    PERFORM rpc_upsert_oauth_account_integration(b, 'shopee', '1002', '{}', 'x', 'y', 1, NOW(), NULL, pg_temp.c('ub')::uuid);
  EXCEPTION WHEN raise_exception THEN ok := SQLERRM = 'account_linked_to_other_company';
  END;
  PERFORM pg_temp.eq(ok, true, 'loja de A não pode ser conectada por B');

  -- mesma conta externa em providers diferentes não colide
  PERFORM rpc_upsert_oauth_account_integration(b, 'mercadolivre', '1002', '{}', 'x', 'y', 1, NOW(), NULL, pg_temp.c('ub')::uuid);
  PERFORM pg_temp.eq(1, 1, 'external_account_id igual em provider diferente é permitido');
  INSERT INTO ctx VALUES ('i1', r1->>'integration_id');
END $$;

-- ─── 5. lease/refresh genéricos numa integração shopee ──────────────────────
DO $$
DECLARE r jsonb; i bigint := pg_temp.c('i1')::bigint; a int := pg_temp.c('a')::int; b int := pg_temp.c('b')::int;
BEGIN
  r := rpc_claim_integration_token_refresh(i, b, 'w-b', 60);
  PERFORM pg_temp.eq(r->>'status', 'not_found', 'empresa B não obtém lease da loja de A');
  r := rpc_claim_integration_token_refresh(i, a, 'w1', 60);
  PERFORM pg_temp.eq((r->>'claimed')::boolean, true, 'w1 ganha o lease');
  r := rpc_claim_integration_token_refresh(i, a, 'w2', 60);
  PERFORM pg_temp.eq((r->>'claimed')::boolean, false, 'w2 não ganha lease ocupado');
  PERFORM pg_temp.eq(rpc_complete_integration_token_refresh(i, a, 'w2', 'x', 'y', 1, NOW(), NULL), false, 'fencing: w2 não grava');
  PERFORM pg_temp.eq(rpc_complete_integration_token_refresh(i, a, 'w1', 'acc-new', 'ref-new', 1, NOW() + interval '4 hours', NULL), true, 'w1 grava o par novo');
  PERFORM pg_temp.eq((SELECT ciphertext FROM integration_secrets WHERE integration_id = i AND key = 'refresh_token'), 'ref-new', 'refresh_token rotacionado');

  r := rpc_claim_integration_token_refresh(i, a, 'w3', 60);
  PERFORM rpc_fail_integration_token_refresh(i, a, 'w3', false, 'server');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = i), 'active', 'falha transitória mantém active');
  r := rpc_claim_integration_token_refresh(i, a, 'w4', 60);
  PERFORM rpc_fail_integration_token_refresh(i, a, 'w4', true, 'reauth_required');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = i), 'needs_reauth', 'recusa do refresh → needs_reauth');
  PERFORM pg_temp.eq(rpc_disconnect_oauth_integration(i, b, pg_temp.c('ub')::uuid), false, 'empresa B não desconecta loja de A');
END $$;

DO $$ BEGIN RAISE NOTICE 'shopee_provider: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
