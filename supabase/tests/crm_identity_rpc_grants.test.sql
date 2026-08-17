-- =============================================================================
-- crm_identity_rpc_grants.test.sql
--
-- Teste de regressão para 20260816_fix_crm_identity_rpc_grants_tenant.sql —
-- confirma que `authenticated` NÃO pode mais chamar diretamente as RPCs da
-- camada de identidade/conversação do CRM (fechando o vetor de
-- personificação cross-tenant via `p_company_id` forjado), e que
-- `service_role` continua podendo (o app não deve quebrar).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/crm_identity_rpc_grants.test.sql
--
-- Só leitura de metadados de privilégio (has_function_privilege) — não
-- insere/altera nenhum dado, não precisa de BEGIN/ROLLBACK.
-- =============================================================================

DO $$
DECLARE
  v_fn      TEXT;
  v_ok      BOOLEAN;
BEGIN
  -- 1. rpc_find_or_create_crm_person_by_identity
  v_fn := 'public.rpc_find_or_create_crm_person_by_identity(int, crm_channel_type, text, text, text, text)';
  v_ok := has_function_privilege('authenticated', v_fn, 'EXECUTE');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA: authenticated ainda pode executar %', v_fn;
  END IF;
  v_ok := has_function_privilege('service_role', v_fn, 'EXECUTE');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: service_role NÃO pode mais executar % (quebraria o app)', v_fn;
  END IF;
  RAISE NOTICE 'OK: %', v_fn;

  -- 2. rpc_apply_crm_message_status
  v_fn := 'public.rpc_apply_crm_message_status(int, bigint, text, timestamptz, text, text)';
  v_ok := has_function_privilege('authenticated', v_fn, 'EXECUTE');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA: authenticated ainda pode executar %', v_fn;
  END IF;
  v_ok := has_function_privilege('service_role', v_fn, 'EXECUTE');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: service_role NÃO pode mais executar % (quebraria o app)', v_fn;
  END IF;
  RAISE NOTICE 'OK: %', v_fn;

  -- 3. rpc_search_crm_conversations
  v_fn := 'public.rpc_search_crm_conversations(int, text)';
  v_ok := has_function_privilege('authenticated', v_fn, 'EXECUTE');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA: authenticated ainda pode executar %', v_fn;
  END IF;
  v_ok := has_function_privilege('service_role', v_fn, 'EXECUTE');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: service_role NÃO pode mais executar % (quebraria o app)', v_fn;
  END IF;
  RAISE NOTICE 'OK: %', v_fn;

  RAISE NOTICE 'crm_identity_rpc_grants.test.sql: todos os 3 GRANTs corretos.';
END $$;
