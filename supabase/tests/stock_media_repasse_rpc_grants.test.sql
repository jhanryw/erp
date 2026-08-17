-- =============================================================================
-- stock_media_repasse_rpc_grants.test.sql
--
-- Teste de regressão para
-- 20260816_fix_stock_media_repasse_rpc_grants_public.sql — confirma que nem
-- `anon` nem `authenticated` conseguem mais executar diretamente as 8 RPCs
-- corrigidas na Fase 0B, e que `service_role` continua podendo (o app não
-- deve quebrar).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/stock_media_repasse_rpc_grants.test.sql
--
-- Só leitura de metadados de privilégio (has_function_privilege) — não
-- insere/altera nenhum dado, não precisa de BEGIN/ROLLBACK.
-- =============================================================================

DO $$
DECLARE
  v_fn TEXT;
  v_ok BOOLEAN;

  -- assinatura -> nome, pra iterar sem repetir o bloco 8x
  v_functions TEXT[] := ARRAY[
    'public.rpc_pagar_repasse_motoboy(int, uuid)',
    'public.fn_main_store_id(int)',
    'public.rpc_stock_initialize(int, int, numeric, uuid, int)',
    'public.rpc_transfer_stock(int, int, int, int, text, uuid)',
    'public.rpc_decrease_online_sale_stock(int, int, int, text, uuid)',
    'public.rpc_stock_transfer_bulk(int, int, text, uuid, jsonb)',
    'public.rpc_reconcile_stock_divergence(text, uuid, boolean)',
    'public.rpc_set_primary_media(uuid, bigint, text, text)'
  ];
BEGIN
  FOREACH v_fn IN ARRAY v_functions LOOP
    v_ok := has_function_privilege('anon', v_fn, 'EXECUTE');
    IF v_ok THEN
      RAISE EXCEPTION 'FALHA: anon ainda pode executar %', v_fn;
    END IF;

    v_ok := has_function_privilege('authenticated', v_fn, 'EXECUTE');
    IF v_ok THEN
      RAISE EXCEPTION 'FALHA: authenticated ainda pode executar %', v_fn;
    END IF;

    v_ok := has_function_privilege('service_role', v_fn, 'EXECUTE');
    IF NOT v_ok THEN
      RAISE EXCEPTION 'FALHA: service_role NÃO pode mais executar % (quebraria o app)', v_fn;
    END IF;

    RAISE NOTICE 'OK: %', v_fn;
  END LOOP;

  RAISE NOTICE 'stock_media_repasse_rpc_grants.test.sql: todos os 8 GRANTs corretos (anon=false, authenticated=false, service_role=true).';
END $$;

-- =============================================================================
-- Teste comportamental adicional — cross-tenant em rpc_pagar_repasse_motoboy
--
-- O REVOKE acima já fecha o único vetor de exploração comprovado (chamada
-- direta via browser/authenticated). Este bloco valida, à parte, que a
-- guarda de negócio DENTRO da função (linhas 50-72 de
-- supabase/migrations/20260613_rpc_pagar_repasse.sql: "IF v_shipment.company_id
-- IS DISTINCT FROM v_company_id THEN RAISE EXCEPTION 'Acesso negado.'")
-- continua funcionando corretamente — defesa em profundidade, útil mesmo
-- que só service_role possa chamar a função hoje, caso uma rota futura
-- passe `p_system_user_id` de uma empresa errada por bug de aplicação.
--
-- Requer pelo menos 2 empresas distintas em `companies` para ser
-- significativo. Este projeto é documentadamente single-tenant hoje
-- ("Santtorini", ver auditoria — company_id=1 hardcoded em seeds/.env) — se
-- só existir 1 empresa no banco em que você rodar isto, o bloco abaixo
-- detecta isso e AVISA em vez de fingir que testou o cenário cross-tenant.
-- =============================================================================

DO $$
DECLARE
  v_company_count   int;
  v_company_a       int;
  v_company_b       int;
  v_user_b          uuid;
  v_shipment_a      int;
  v_raised          boolean := false;
BEGIN
  SELECT COUNT(DISTINCT id) INTO v_company_count FROM public.companies;

  IF v_company_count < 2 THEN
    RAISE NOTICE 'PULADO: só % empresa(s) em public.companies — teste cross-tenant real de rpc_pagar_repasse_motoboy precisa de pelo menos 2 empresas distintas para ser significativo. Rode este bloco de novo quando houver um segundo tenant.', v_company_count;
    RETURN;
  END IF;

  SELECT id INTO v_company_a FROM public.companies ORDER BY id LIMIT 1;
  SELECT id INTO v_company_b FROM public.companies WHERE id <> v_company_a ORDER BY id LIMIT 1;

  SELECT id INTO v_user_b FROM public.users WHERE company_id = v_company_b AND active = true LIMIT 1;
  IF v_user_b IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo encontrado para a empresa %.', v_company_b;
    RETURN;
  END IF;

  SELECT id INTO v_shipment_a FROM public.shipments
  WHERE company_id = v_company_a AND repasse_status = 'pending'
  LIMIT 1;
  IF v_shipment_a IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum envio com repasse_status=pending encontrado para a empresa % — não há fixture segura para testar sem inserir dados (shipments não tem migration de CREATE TABLE rastreável neste repo, então não arrisco um INSERT com schema desconhecido).', v_company_a;
    RETURN;
  END IF;

  BEGIN
    PERFORM public.rpc_pagar_repasse_motoboy(v_shipment_a, v_user_b);
    RAISE EXCEPTION 'FALHA DE SEGURANÇA: rpc_pagar_repasse_motoboy aceitou pagar repasse do envio % (empresa %) usando um usuário da empresa % — guarda cross-tenant não disparou.', v_shipment_a, v_company_a, v_company_b;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'Acesso negado.' THEN
        v_raised := true;
        RAISE NOTICE 'OK: rpc_pagar_repasse_motoboy recusou corretamente (Acesso negado) o repasse cross-tenant.';
      ELSE
        RAISE; -- erro inesperado, não o guard esperado — propaga pra investigação
      END IF;
  END;
END $$;
