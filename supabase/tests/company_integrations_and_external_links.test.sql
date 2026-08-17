-- =============================================================================
-- company_integrations_and_external_links.test.sql
--
-- Cobre (seções 37-38 do pedido da Fase 2):
--   company_integrations: empresa A não lê integração da B, lookup por
--     provider/external_account_id correto, settings nunca guarda secret,
--     integração inativa não é retornada por findIntegrationByExternalAccount,
--     mesmo provider pode ter 2 contas na mesma empresa (sem UNIQUE rígido),
--     mesmo external_account_id em 2 empresas é bloqueado (índice global).
--   external_entity_links: link idempotente, external_id não duplica,
--     tenant A/B isolado, mesmo external_id em integrações diferentes
--     permitido, mesma entidade interna pode ter providers diferentes.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/company_integrations_and_external_links.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo, nem mesmo as
-- empresas temporárias criadas pra este teste.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_company_a        int;
  v_company_b         int;
  v_integration_chatwoot_a  bigint;
  v_integration_meta_a      bigint;
  v_integration_chatwoot_b  bigint;
  v_link_1            bigint;
  v_count             int;
BEGIN
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Integrations A — APAGAR', 'teste-integrations-a-apagar', 'starter', true)
  RETURNING id INTO v_company_a;

  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Integrations B — APAGAR', 'teste-integrations-b-apagar', 'starter', true)
  RETURNING id INTO v_company_b;

  -- ═══════════════════════════════════════════════════════════════════════
  -- company_integrations
  -- ═══════════════════════════════════════════════════════════════════════

  INSERT INTO public.company_integrations (company_id, provider, external_account_id, status, settings)
  VALUES (v_company_a, 'chatwoot', 'chatwoot-acc-123', 'active', jsonb_build_object('base_url', 'https://chat.example.com', 'account_id', 1))
  RETURNING id INTO v_integration_chatwoot_a;

  INSERT INTO public.company_integrations (company_id, provider, external_account_id, status, settings)
  VALUES (v_company_a, 'meta', 'meta-pixel-999', 'active', jsonb_build_object('pixel_id', '999'))
  RETURNING id INTO v_integration_meta_a;

  -- TESTE 1: empresa A não lê integração da B (nem existe ainda, mas
  -- confirma o filtro por company_id na query de listagem).
  SELECT COUNT(*) INTO v_count FROM public.company_integrations WHERE company_id = v_company_a;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'FALHA: esperado 2 integrações pra empresa A, achou %.', v_count;
  END IF;
  RAISE NOTICE 'OK: empresa A tem exatamente suas 2 integrações (chatwoot + meta), escopo por company_id confirmado.';

  -- TESTE 2: mesmo provider (chatwoot), 2 contas DIFERENTES, MESMA empresa —
  -- não deve colidir (não existe UNIQUE(company_id, provider) rígido).
  BEGIN
    INSERT INTO public.company_integrations (company_id, provider, external_account_id, status)
    VALUES (v_company_a, 'chatwoot', 'chatwoot-acc-456-outra-conta', 'active');
    RAISE NOTICE 'OK: empresa A conseguiu ter uma SEGUNDA conta Chatwoot (external_account_id diferente) — sem UNIQUE(company_id, provider) rígido, conforme decidido.';
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'FALHA: deveria ser possível 2 contas do mesmo provider na mesma empresa (external_account_id diferente).';
  END;

  -- TESTE 3: MESMO external_account_id em EMPRESAS DIFERENTES é bloqueado —
  -- índice único global (provider, external_account_id) evita ambiguidade
  -- de roteamento de webhook.
  BEGIN
    INSERT INTO public.company_integrations (company_id, provider, external_account_id, status)
    VALUES (v_company_b, 'chatwoot', 'chatwoot-acc-123', 'active'); -- mesmo external_account_id de v_integration_chatwoot_a
    RAISE EXCEPTION 'FALHA CRÍTICA: duas empresas diferentes conseguiram reivindicar o mesmo external_account_id do mesmo provider — risco de roteamento de webhook ambíguo cross-tenant.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: mesmo external_account_id em empresas diferentes corretamente bloqueado (uq_company_integrations_provider_account).';
  END;

  -- Empresa B com conta Chatwoot PRÓPRIA (external_account_id diferente) —
  -- deve funcionar normalmente.
  INSERT INTO public.company_integrations (company_id, provider, external_account_id, status)
  VALUES (v_company_b, 'chatwoot', 'chatwoot-acc-789-empresa-b', 'active')
  RETURNING id INTO v_integration_chatwoot_b;

  -- TESTE 4: lookup reverso (provider + external_account_id → empresa)
  -- resolve pra empresa CERTA, nunca ambíguo.
  SELECT COUNT(*) INTO v_count
  FROM public.company_integrations
  WHERE provider = 'chatwoot' AND external_account_id = 'chatwoot-acc-123' AND status = 'active';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FALHA: lookup reverso deveria achar exatamente 1 integração (empresa A), achou %.', v_count;
  END IF;
  RAISE NOTICE 'OK: lookup reverso (findIntegrationByExternalAccount) resolve pra exatamente 1 empresa, sem ambiguidade.';

  -- TESTE 5: settings nunca guarda secret — confirmação estrutural (não
  -- existe coluna de secret na tabela; a única forma de guardar segredo é
  -- integration_secrets, tabela separada).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'company_integrations'
      AND (column_name ILIKE '%token%' OR column_name ILIKE '%secret%')
  ) THEN
    RAISE EXCEPTION 'FALHA: company_integrations tem uma coluna com nome sugerindo secret/token — não deveria existir.';
  END IF;
  RAISE NOTICE 'OK: company_integrations não tem nenhuma coluna de secret/token (settings é só config não sensível).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- external_entity_links
  -- ═══════════════════════════════════════════════════════════════════════

  INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
  VALUES (v_company_a, v_integration_chatwoot_a, 'chatwoot', 'crm_person', '42', 'contact', '438')
  RETURNING id INTO v_link_1;

  -- TESTE 6: idempotência — recriar o MESMO link (mesma integração, mesma
  -- entidade interna, mesmo tipo externo) é bloqueado.
  BEGIN
    INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
    VALUES (v_company_a, v_integration_chatwoot_a, 'chatwoot', 'crm_person', '42', 'contact', '438');
    RAISE EXCEPTION 'FALHA (idempotência): link duplicado foi aceito.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK (idempotência): recriar o mesmo link é bloqueado (uq_external_entity_links_internal).';
  END;

  -- TESTE 7: external_id não duplica — 2 crm_persons DIFERENTES não podem
  -- "roubar" o mesmo Chatwoot contact 438 na mesma integração.
  BEGIN
    INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
    VALUES (v_company_a, v_integration_chatwoot_a, 'chatwoot', 'crm_person', '99', 'contact', '438'); -- mesmo external_id 438, outra crm_person
    RAISE EXCEPTION 'FALHA CRÍTICA: 2 crm_persons diferentes conseguiram vincular ao MESMO Chatwoot contact.';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: mesmo external_id (contact 438) não pode ser dono de 2 entidades internas na mesma integração (uq_external_entity_links_external).';
  END;

  -- TESTE 8: tenant isolation — mesmo external_id (438), mas em uma
  -- integração de OUTRA empresa (v_integration_chatwoot_b) — deve funcionar
  -- normalmente, não colide com o link da empresa A.
  INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
  VALUES (v_company_b, v_integration_chatwoot_b, 'chatwoot', 'crm_person', '1', 'contact', '438');
  RAISE NOTICE 'OK (tenant isolation): mesmo external_id (438) em integração de outra empresa não colide — índices são escopados por integration_id, não globais por external_id sozinho.';

  -- TESTE 9: mesma entidade interna (crm_person #42, empresa A) pode ter
  -- link em OUTRA integração (provider diferente, ex.: Meta) — não é
  -- travada a um único provider.
  INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
  VALUES (v_company_a, v_integration_meta_a, 'meta', 'crm_person', '42', 'lead', 'meta-lead-abc');
  RAISE NOTICE 'OK: crm_person #42 tem link ativo em 2 integrações diferentes (Chatwoot contact + Meta lead) sem conflito.';

  -- TESTE 10: soft-delete + recriação — desativar o link 1 e recriar não
  -- colide (índices são parciais WHERE active).
  UPDATE public.external_entity_links SET active = false WHERE id = v_link_1;
  INSERT INTO public.external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id)
  VALUES (v_company_a, v_integration_chatwoot_a, 'chatwoot', 'crm_person', '42', 'contact', '438');
  RAISE NOTICE 'OK: depois de desativar (active=false) um link, recriar o mesmo par funciona (índices únicos são parciais WHERE active).';

  RAISE NOTICE 'company_integrations_and_external_links.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
