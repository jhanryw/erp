-- =============================================================================
-- cash_register_sessions_secure_view.test.sql
--
-- Teste de regressão para 20260910_blind_cash_close.sql — confirma que:
--   1. Nem `authenticated` nem `anon` conseguem mais SELECT direto na
--      tabela base cash_register_sessions, nem EXECUTE em
--      rpc_close_cash_session (fecha o vetor de leitura via Supabase
--      REST/JS client, e a lacuna de PUBLIC que 20260811_fix_rpc_identity_
--      grants_tenant.sql sozinho não fechava — REVOKE FROM authenticated
--      não remove um grant concedido a PUBLIC).
--   2. `authenticated` consegue SELECT na view
--      cash_register_sessions_secure; `anon` não.
--   3. `service_role` continua com SELECT na tabela base e EXECUTE na RPC
--      (a API server-side inteira usa createAdminClient() — não pode
--      quebrar).
--   4. Comportamental: um usuário 'usuario' (seller) lendo a view não
--      recebe expected_cash/cash_difference (NULL); um 'gerente' lendo a
--      MESMA linha recebe os valores reais.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/cash_register_sessions_secure_view.test.sql
--
-- O bloco 4 é comportamental e precisa de fixtures (1 sessão fechada real).
-- Se não encontrar dados suficientes, avisa e pula — não inventa dados em
-- uma tabela com FKs pra companies/users que este script não controla.
-- =============================================================================

-- ─── Bloco 1-3: privilégios (só leitura de metadados, sem side effect) ──────
DO $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  v_ok := has_table_privilege('authenticated', 'public.cash_register_sessions', 'SELECT');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA: authenticated ainda consegue SELECT direto em cash_register_sessions — vazamento de expected_cash/cash_difference via REST/JS client não foi fechado.';
  END IF;
  RAISE NOTICE 'OK: authenticated sem SELECT direto na tabela base.';

  v_ok := has_table_privilege('anon', 'public.cash_register_sessions', 'SELECT');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: anon (não autenticado) consegue SELECT direto em cash_register_sessions.';
  END IF;
  RAISE NOTICE 'OK: anon sem SELECT direto na tabela base.';

  v_ok := has_table_privilege('authenticated', 'public.cash_register_sessions_secure', 'SELECT');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: authenticated não consegue SELECT na view segura — quebraria qualquer leitura direta legítima (ex.: gerente).';
  END IF;
  RAISE NOTICE 'OK: authenticated com SELECT na view cash_register_sessions_secure.';

  v_ok := has_table_privilege('anon', 'public.cash_register_sessions_secure', 'SELECT');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA: anon consegue SELECT na view segura — mesmo com o WHERE current_company_id() devolvendo 0 linhas, o privilégio não deveria existir.';
  END IF;
  RAISE NOTICE 'OK: anon sem SELECT na view segura.';

  v_ok := has_table_privilege('service_role', 'public.cash_register_sessions', 'SELECT');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: service_role perdeu SELECT na tabela base — quebraria toda a API (createAdminClient()).';
  END IF;
  RAISE NOTICE 'OK: service_role continua com SELECT na tabela base.';

  -- Achado desta revisão: 20260811_fix_rpc_identity_grants_tenant.sql só
  -- revogou EXECUTE de `authenticated`, nunca de PUBLIC — se a função
  -- tivesse (como confirmado ao vivo para rpc_create_sale em
  -- 20260828_rpc_create_sale_pricing_and_products_total.sql) um grant
  -- explícito a PUBLIC/anon desde a criação, authenticated continuaria
  -- executando por herança de PUBLIC. Este é o teste que efetivamente
  -- fecha essa lacuna.
  v_ok := has_function_privilege('authenticated', 'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: authenticated consegue EXECUTE direto em rpc_close_cash_session — bypassa toda a filtragem de src/app/api/caixa/fechar/route.ts (a RPC devolve expected_cash/cash_difference completos pra quem a chamar).';
  END IF;
  RAISE NOTICE 'OK: authenticated sem EXECUTE em rpc_close_cash_session.';

  v_ok := has_function_privilege('anon', 'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE');
  IF v_ok THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: anon (não autenticado) consegue EXECUTE em rpc_close_cash_session.';
  END IF;
  RAISE NOTICE 'OK: anon sem EXECUTE em rpc_close_cash_session.';

  v_ok := has_function_privilege('service_role', 'public.rpc_close_cash_session(bigint, uuid, numeric, text)', 'EXECUTE');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'FALHA: service_role perdeu EXECUTE em rpc_close_cash_session — quebraria o fechamento de caixa inteiro.';
  END IF;
  RAISE NOTICE 'OK: service_role continua com EXECUTE em rpc_close_cash_session.';
END $$;

-- ─── Bloco 4: comportamental — masking real por role de aplicação ───────────
-- Simula a sessão de um usuário via request.jwt.claim.sub (é isso que
-- public.get_user_role()/public.current_company_id() leem através de
-- auth.uid() em produção, via PostgREST).
DO $$
DECLARE
  v_company        int;
  v_seller_id      uuid;
  v_gerente_id     uuid;
  v_closed_session int;
  v_seller_row     record;
  v_gerente_row    record;
BEGIN
  SELECT crs.company_id, crs.id
  INTO   v_company, v_closed_session
  FROM   public.cash_register_sessions crs
  WHERE  crs.status = 'closed'
  ORDER  BY crs.id DESC
  LIMIT  1;

  IF v_closed_session IS NULL THEN
    RAISE NOTICE 'PULADO: nenhuma sessão de caixa fechada encontrada — feche um caixa de teste e rode este bloco de novo pra validar o masking comportamental.';
    RETURN;
  END IF;

  SELECT id INTO v_seller_id  FROM public.users WHERE company_id = v_company AND role = 'usuario' LIMIT 1;
  SELECT id INTO v_gerente_id FROM public.users WHERE company_id = v_company AND role IN ('gerente','admin') LIMIT 1;

  IF v_seller_id IS NULL OR v_gerente_id IS NULL THEN
    RAISE NOTICE 'PULADO: precisa de pelo menos 1 usuário "usuario" e 1 "gerente"/"admin" na empresa % pra validar o masking comportamental.', v_company;
    RETURN;
  END IF;

  -- Simula a requisição autenticada do seller
  PERFORM set_config('request.jwt.claim.sub', v_seller_id::text, true);
  SET LOCAL ROLE authenticated;
  SELECT expected_cash, cash_difference
  INTO   v_seller_row
  FROM   public.cash_register_sessions_secure
  WHERE  id = v_closed_session;
  RESET ROLE;

  IF v_seller_row.expected_cash IS NOT NULL OR v_seller_row.cash_difference IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA DE SEGURANÇA: usuario/seller (%) leu expected_cash=% cash_difference=% da sessão % pela view segura — deveria ser NULL.',
      v_seller_id, v_seller_row.expected_cash, v_seller_row.cash_difference, v_closed_session;
  END IF;
  RAISE NOTICE 'OK: seller vê expected_cash/cash_difference = NULL na view segura.';

  -- Simula a requisição autenticada do gerente/admin
  PERFORM set_config('request.jwt.claim.sub', v_gerente_id::text, true);
  SET LOCAL ROLE authenticated;
  SELECT expected_cash, cash_difference
  INTO   v_gerente_row
  FROM   public.cash_register_sessions_secure
  WHERE  id = v_closed_session;
  RESET ROLE;

  IF v_gerente_row.expected_cash IS NULL THEN
    RAISE EXCEPTION 'FALHA: gerente/admin (%) não conseguiu ler expected_cash da sessão % pela view segura — degradou a experiência gerencial.', v_gerente_id, v_closed_session;
  END IF;
  RAISE NOTICE 'OK: gerente/admin vê expected_cash=% cash_difference=% normalmente.', v_gerente_row.expected_cash, v_gerente_row.cash_difference;
END $$;
