-- =============================================================================
-- channel_listings_reconcile.test.sql — claim da reconciliação periódica
-- (202609271000). BEGIN/ROLLBACK, empresas próprias. Ambiente de TESTE apenas:
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/channel_listings_reconcile.test.sql
-- Sucesso = "channel_listings_reconcile: TODOS OS CENÁRIOS PASSARAM".
-- =============================================================================
BEGIN;

CREATE FUNCTION pg_temp.eq(actual anyelement, expected anyelement, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FALHOU [%]: esperado %, obtido %', label, expected, actual; END IF;
  RAISE NOTICE 'ok  %', label;
END $$;

-- isola de dados pré-existentes do banco de teste
UPDATE channel_listings SET last_reconciled_at = NOW() + interval '10 years';

DO $$
DECLARE a int; u uuid := gen_random_uuid(); cat int; p int; v1 int; v2 int; v3 int; v4 int; ia bigint;
  got text[]; n int; old_ts timestamptz;
BEGIN
  INSERT INTO companies (name, slug) VALUES ('TESTE REC', 'teste-rec-' || u) RETURNING id INTO a;
  INSERT INTO categories (name, slug, company_id) VALUES ('Cat', 'rec-' || a, a) RETURNING id INTO cat;
  INSERT INTO products (name, sku, category_id, base_cost, base_price, company_id, tipo, modelo, ano)
  VALUES ('Sutiã REC', 'REC-SUT', cat, 10, 49.9, a, 'sutia', 'teste', '2026') RETURNING id INTO p;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'REC-1') RETURNING id INTO v1;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'REC-2') RETURNING id INTO v2;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'REC-3') RETURNING id INTO v3;
  INSERT INTO product_variations (product_id, sku_variation) VALUES (p, 'REC-4') RETURNING id INTO v4;
  INSERT INTO company_integrations (company_id, provider, status) VALUES (a, 'mercadolivre', 'active') RETURNING id INTO ia;

  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, offer_key, local_status, external_listing_id, last_reconciled_at)
  VALUES (a, ia, 'mercadolivre', p, v1, 'REC-1', 'x', 'active', 'MLBR1', NULL),                          -- nunca reconciliado
         (a, ia, 'mercadolivre', p, v2, 'REC-2', 'x', 'paused', 'MLBR2', NOW() - interval '2 hours'),   -- vencido
         (a, ia, 'mercadolivre', p, v3, 'REC-3', 'x', 'active', 'MLBR3', NOW() - interval '5 minutes'), -- recente
         (a, ia, 'mercadolivre', p, v4, 'REC-4', 'x', 'closed', 'MLBR4', NULL);                        -- fechado
  INSERT INTO channel_listings (company_id, integration_id, provider, product_id, product_variation_id, seller_sku, offer_key, local_status)
  VALUES (a, ia, 'mercadolivre', p, v3, 'REC-3', 'y', 'draft');                                          -- sem id externo

  SELECT array_agg(external_listing_id::text ORDER BY external_listing_id) INTO got
  FROM (SELECT external_listing_id FROM rpc_claim_channel_listings_reconcile(10, 3600)) t;
  PERFORM pg_temp.eq(array_to_string(got, ','), 'MLBR1,MLBR2', 'claim: só vivos com id externo, vencidos ou nunca reconciliados');
  PERFORM pg_temp.eq((SELECT count(*)::int FROM channel_listings WHERE company_id = a AND last_reconciled_at > NOW() - interval '1 minute'), 2, 'claim carimba last_reconciled_at');

  SELECT count(*) INTO n FROM rpc_claim_channel_listings_reconcile(10, 3600);
  PERFORM pg_temp.eq(n, 0, 'segunda chamada imediata não repega (idade mínima)');

  -- ordem: nunca reconciliado primeiro, limite respeitado
  UPDATE channel_listings SET last_reconciled_at = NULL WHERE company_id = a AND external_listing_id = 'MLBR3';
  UPDATE channel_listings SET last_reconciled_at = NOW() - interval '3 hours' WHERE company_id = a AND external_listing_id IN ('MLBR1', 'MLBR2');
  PERFORM pg_temp.eq((SELECT external_listing_id FROM rpc_claim_channel_listings_reconcile(1, 3600)), 'MLBR3', 'limite 1: o nunca reconciliado primeiro');

  -- idade mínima nunca abaixo de 60 s
  UPDATE channel_listings SET last_reconciled_at = NOW() - interval '30 seconds' WHERE company_id = a AND external_listing_id = 'MLBR1';
  SELECT count(*) INTO n FROM rpc_claim_channel_listings_reconcile(10, 0) WHERE external_listing_id = 'MLBR1';
  PERFORM pg_temp.eq(n, 0, 'idade mínima mínima de 60 s');

  -- trigger touch_updated_at: claim muda updated_at (base da trava otimista do serviço)
  -- (NOW() é fixo na transação: parte de um updated_at antigo gravado sem o trigger)
  ALTER TABLE channel_listings DISABLE TRIGGER trg_channel_listings_touch_updated_at;
  UPDATE channel_listings SET updated_at = '2000-01-01', last_reconciled_at = NULL WHERE company_id = a AND external_listing_id = 'MLBR2';
  ALTER TABLE channel_listings ENABLE TRIGGER trg_channel_listings_touch_updated_at;
  old_ts := '2000-01-01';
  PERFORM rpc_claim_channel_listings_reconcile(10, 3600);
  PERFORM pg_temp.eq((SELECT updated_at > old_ts FROM channel_listings WHERE company_id = a AND external_listing_id = 'MLBR2'), true, 'claim atualiza updated_at');

  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.rpc_claim_channel_listings_reconcile(int, int)', 'EXECUTE'), false, 'authenticated não executa claim');
  PERFORM pg_temp.eq(has_function_privilege('anon', 'public.rpc_claim_channel_listings_reconcile(int, int)', 'EXECUTE'), false, 'anon não executa claim');
  PERFORM pg_temp.eq(has_function_privilege('service_role', 'public.rpc_claim_channel_listings_reconcile(int, int)', 'EXECUTE'), true, 'service_role executa claim');
END $$;

DO $$ BEGIN RAISE NOTICE 'channel_listings_reconcile: TODOS OS CENÁRIOS PASSARAM'; END $$;
ROLLBACK;
