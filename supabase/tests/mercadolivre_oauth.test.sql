-- =============================================================================
-- mercadolivre_oauth.test.sql — RPCs de OAuth/tokens (202609241000).
-- BEGIN/ROLLBACK, empresas próprias. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/mercadolivre_oauth.test.sql
-- Sucesso = "mercadolivre_oauth: TODOS OS CENÁRIOS PASSARAM".
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
  INSERT INTO companies (name, slug) VALUES ('TESTE ML A', 'teste-ml-a-' || ua) RETURNING id INTO a;
  INSERT INTO companies (name, slug) VALUES ('TESTE ML B', 'teste-ml-b-' || ub) RETURNING id INTO b;
  INSERT INTO auth.users (id) VALUES (ua), (ub);
  INSERT INTO ctx VALUES ('a', a), ('b', b), ('ua', ua), ('ub', ub);
END $$;
CREATE FUNCTION pg_temp.c(k text) RETURNS text LANGUAGE sql AS $$ SELECT v FROM ctx WHERE ctx.k = $1 $$;

-- ─── state ───────────────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO integration_oauth_states (provider, state_hash, company_id, user_id, expires_at)
  VALUES ('mercadolivre', 'hash-ok', pg_temp.c('a')::int, pg_temp.c('ua')::uuid, NOW() + interval '10 minutes'),
         ('mercadolivre', 'hash-exp', pg_temp.c('a')::int, pg_temp.c('ua')::uuid, NOW() - interval '1 second');

  r := rpc_consume_oauth_state('mercadolivre', 'hash-ok');
  PERFORM pg_temp.eq(r->>'status', 'ok', 'state válido consumido');
  PERFORM pg_temp.eq((r->>'company_id')::int, pg_temp.c('a')::int, 'state devolve a empresa vinculada');
  PERFORM pg_temp.eq(rpc_consume_oauth_state('mercadolivre', 'hash-ok')->>'status', 'consumed', 'state é de uso único');
  PERFORM pg_temp.eq(rpc_consume_oauth_state('mercadolivre', 'hash-exp')->>'status', 'expired', 'state expirado recusado');
  PERFORM pg_temp.eq(rpc_consume_oauth_state('mercadolivre', 'forjado')->>'status', 'not_found', 'state manipulado recusado');
  PERFORM pg_temp.eq(rpc_consume_oauth_state('nuvemshop', 'hash-exp')->>'status', 'not_found', 'state de outro provider não serve');
END $$;

-- ─── conexão / conflito ─────────────────────────────────────────────────────
DO $$
DECLARE r jsonb; id1 bigint;
BEGIN
  r := rpc_upsert_oauth_integration(pg_temp.c('a')::int, 'mercadolivre', '555', '{"nickname":"LOJA"}',
        'ct-access-1', 'ct-refresh-1', 1, NOW() + interval '6 hours', ARRAY['read','write'], pg_temp.c('ua')::uuid);
  id1 := (r->>'integration_id')::bigint;
  INSERT INTO ctx VALUES ('int_a', id1);
  PERFORM pg_temp.eq(r->>'reconnected', 'false', 'primeira conexão cria integração');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = id1), 'active', 'status active');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM integration_secrets WHERE integration_id = id1), 2, 'access+refresh gravados');
  PERFORM pg_temp.eq((SELECT settings->>'access_token' FROM company_integrations WHERE id = id1), NULL, 'token nunca vai para settings');

  r := rpc_upsert_oauth_integration(pg_temp.c('a')::int, 'mercadolivre', '555', '{"nickname":"LOJA2"}',
        'ct-access-2', 'ct-refresh-2', 1, NOW() + interval '6 hours', ARRAY['read'], pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq((r->>'integration_id')::bigint, id1, 'reconexão reutiliza a mesma integração');
  PERFORM pg_temp.eq((SELECT ciphertext FROM integration_secrets WHERE integration_id = id1 AND key = 'access_token'), 'ct-access-2', 'reconexão troca tokens');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM company_integrations WHERE company_id = pg_temp.c('a')::int AND provider = 'mercadolivre'), 1, 'sem duplicar');

  BEGIN
    PERFORM rpc_upsert_oauth_integration(pg_temp.c('b')::int, 'mercadolivre', '555', '{}', 'x', 'y', 1, NOW(), NULL, pg_temp.c('ub')::uuid);
    RAISE EXCEPTION 'FALHOU [conflito]: deveria recusar';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'FALHOU%' THEN RAISE; END IF;
    PERFORM pg_temp.eq(SQLERRM, 'account_linked_to_other_company', 'mesma conta ML não conecta em outra empresa');
  END;
  PERFORM pg_temp.eq((SELECT count(*)::int FROM integration_secrets WHERE company_id = pg_temp.c('b')::int), 0, 'empresa B não recebeu segredo');
END $$;

-- ─── lease de refresh ───────────────────────────────────────────────────────
DO $$
DECLARE id1 bigint := pg_temp.c('int_a')::bigint; a int := pg_temp.c('a')::int; b int := pg_temp.c('b')::int;
BEGIN
  PERFORM pg_temp.eq((rpc_claim_integration_token_refresh(id1, a, 'w1', 60)->>'claimed')::boolean, true, 'worker 1 ganha o lease');
  PERFORM pg_temp.eq((rpc_claim_integration_token_refresh(id1, a, 'w2', 60)->>'claimed')::boolean, false, 'worker 2 não ganha lease ocupado');
  PERFORM pg_temp.eq((rpc_claim_integration_token_refresh(id1, b, 'wx', 60)->>'status'), 'not_found', 'outra empresa não enxerga a integração');

  PERFORM pg_temp.eq(rpc_complete_integration_token_refresh(id1, a, 'w2', 'ct-a3', 'ct-r3', 1, NOW() + interval '6 hours', NULL), false, 'fencing: não-dono não grava');
  PERFORM pg_temp.eq(rpc_complete_integration_token_refresh(id1, b, 'w1', 'ct-a3', 'ct-r3', 1, NOW() + interval '6 hours', NULL), false, 'fencing: outra empresa não grava');
  PERFORM pg_temp.eq(rpc_complete_integration_token_refresh(id1, a, 'w1', 'ct-a3', 'ct-r3', 1, NOW() + interval '6 hours', ARRAY['read']), true, 'dono grava o par novo');
  PERFORM pg_temp.eq((SELECT ciphertext FROM integration_secrets WHERE integration_id = id1 AND key = 'refresh_token'), 'ct-r3', 'refresh_token rotacionado');
  PERFORM pg_temp.eq((SELECT refresh_lease_owner FROM company_integrations WHERE id = id1), NULL, 'lease liberado ao gravar');

  -- lease vencido pode ser retomado
  PERFORM rpc_claim_integration_token_refresh(id1, a, 'morto', 60);
  UPDATE company_integrations SET refresh_lease_until = NOW() - interval '1 second' WHERE id = id1;
  PERFORM pg_temp.eq((rpc_claim_integration_token_refresh(id1, a, 'vivo', 60)->>'claimed')::boolean, true, 'lease vencido é retomado');

  -- falha transitória mantém active
  PERFORM rpc_fail_integration_token_refresh(id1, a, 'vivo', false, 'server');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = id1), 'active', 'falha transitória mantém active');

  -- revogação → needs_reauth, e claim deixa de ser concedido
  PERFORM rpc_claim_integration_token_refresh(id1, a, 'w3', 60);
  PERFORM rpc_fail_integration_token_refresh(id1, a, 'w3', true, 'reauth_required:invalid_grant');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = id1), 'needs_reauth', 'invalid_grant → needs_reauth');
  PERFORM pg_temp.eq((rpc_claim_integration_token_refresh(id1, a, 'w4', 60)->>'claimed')::boolean, false, 'needs_reauth não permite novos refreshes');
END $$;

-- ─── desconexão / reconexão ─────────────────────────────────────────────────
DO $$
DECLARE id1 bigint := pg_temp.c('int_a')::bigint; a int := pg_temp.c('a')::int; b int := pg_temp.c('b')::int; r jsonb;
BEGIN
  PERFORM pg_temp.eq(rpc_disconnect_oauth_integration(id1, b, pg_temp.c('ub')::uuid), false, 'outra empresa não desconecta');
  PERFORM pg_temp.eq(rpc_disconnect_oauth_integration(id1, a, pg_temp.c('ua')::uuid), true, 'desconecta');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = id1), 'inactive', 'status inactive');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM integration_secrets WHERE integration_id = id1), 0, 'tokens apagados');
  PERFORM pg_temp.eq((SELECT settings->>'previous_external_account_id' FROM company_integrations WHERE id = id1), '555', 'conta anterior preservada para auditoria');

  r := rpc_upsert_oauth_integration(b, 'mercadolivre', '555', '{}', 'ct-b', 'ct-rb', 1, NOW() + interval '6 hours', NULL, pg_temp.c('ub')::uuid);
  PERFORM pg_temp.eq(r->>'reconnected', 'false', 'conta liberada pode conectar em outra empresa');

  r := rpc_upsert_oauth_integration(a, 'mercadolivre', '777', '{}', 'ct-a7', 'ct-r7', 1, NOW() + interval '6 hours', NULL, pg_temp.c('ua')::uuid);
  PERFORM pg_temp.eq((r->>'integration_id')::bigint, id1, 'empresa A reconecta (outra conta) no mesmo registro');
  PERFORM pg_temp.eq((SELECT status FROM company_integrations WHERE id = id1), 'active', 'reconexão reativa');
END $$;

-- ─── grants / RLS ───────────────────────────────────────────────────────────
DO $$
BEGIN
  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.rpc_upsert_oauth_integration(int, text, text, jsonb, text, text, int, timestamptz, text[], uuid)', 'EXECUTE'), false, 'authenticated não executa upsert');
  PERFORM pg_temp.eq(has_function_privilege('anon', 'public.rpc_consume_oauth_state(text, text)', 'EXECUTE'), false, 'anon não consome state');
  PERFORM pg_temp.eq(has_table_privilege('authenticated', 'public.integration_oauth_states', 'SELECT'), false, 'authenticated não lê states');
  PERFORM pg_temp.eq(has_table_privilege('authenticated', 'public.integration_secrets', 'SELECT'), false, 'authenticated não lê segredos');
END $$;

DO $$ BEGIN RAISE NOTICE 'mercadolivre_oauth: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
