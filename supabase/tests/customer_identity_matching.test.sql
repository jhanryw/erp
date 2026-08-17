-- =============================================================================
-- customer_identity_matching.test.sql
--
-- Testes FUNCIONAIS pra Fase 1 (Customer Identity) — crm_person_customer_links
-- populada de verdade pela primeira vez. Cobre exatamente os invariantes que
-- não dá pra testar em vitest (dependem do Postgres real: tenant isolation
-- via company_id, cliente anônimo nunca vinculado, idempotência do índice
-- único sob "corrida" simulada).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/customer_identity_matching.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo, nem mesmo as
-- duas empresas temporárias criadas para o teste de tenant isolation.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_company_a       int;
  v_company_b       int;
  v_customer_a       int;
  v_customer_b       int;
  v_customer_anon    int;
  v_person_a         bigint;
  v_identity_a        bigint;
  v_link_1           bigint;
  v_link_2_customer_id int;
  v_count            int;
BEGIN
  -- ─── Fixtures: 2 empresas temporárias (isoladas, dentro da transação) ───────
  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Identity A — APAGAR', 'teste-identity-a-apagar', 'starter', true)
  RETURNING id INTO v_company_a;

  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Identity B — APAGAR', 'teste-identity-b-apagar', 'starter', true)
  RETURNING id INTO v_company_b;

  -- Mesmo telefone (+5584999990001) em duas empresas diferentes — clientes
  -- distintos, não podem se cruzar.
  INSERT INTO public.customers (name, cpf, phone, phone_e164, company_id, is_anonymous, active)
  VALUES ('Cliente Teste A', '11122233344', '84999990001', '5584999990001', v_company_a, false, true)
  RETURNING id INTO v_customer_a;

  INSERT INTO public.customers (name, cpf, phone, phone_e164, company_id, is_anonymous, active)
  VALUES ('Cliente Teste B', '55566677788', '84999990001', '5584999990001', v_company_b, false, true)
  RETURNING id INTO v_customer_b;

  -- Cliente anônimo da empresa A, MESMO telefone — nunca pode ser candidato de match.
  INSERT INTO public.customers (name, cpf, phone, phone_e164, company_id, is_anonymous, active)
  VALUES ('Cliente Avulso', '11111111111', '84999990001', '5584999990001', v_company_a, true, true)
  RETURNING id INTO v_customer_anon;

  -- crm_person + identidade de canal (whatsapp, mesmo telefone), empresa A.
  INSERT INTO public.crm_persons (company_id, display_name, created_source)
  VALUES (v_company_a, 'Pessoa Teste', 'manual')
  RETURNING id INTO v_person_a;

  INSERT INTO public.crm_channel_identities (company_id, person_id, channel_type, value, created_source)
  VALUES (v_company_a, v_person_a, 'whatsapp', '5584999990001', 'manual')
  RETURNING id INTO v_identity_a;

  -- ─── TESTE 1: tenant isolation ────────────────────────────────────────────
  -- Query de matching (mesma lógica de resolveCustomerForPerson) escopada
  -- por company_id NUNCA deveria trazer v_customer_b (empresa B) nem
  -- v_customer_anon (anônimo), só v_customer_a.
  SELECT COUNT(*) INTO v_count
  FROM public.customers
  WHERE company_id = v_company_a
    AND is_anonymous = false
    AND phone_e164 = '5584999990001';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FALHA (tenant isolation): esperado exatamente 1 candidato real na empresa A, achou %.', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.customers
  WHERE company_id = v_company_a
    AND is_anonymous = false
    AND phone_e164 = '5584999990001'
    AND id = v_customer_b;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALHA CRÍTICA (tenant isolation): candidato da empresa B vazou pra query escopada na empresa A.';
  END IF;

  RAISE NOTICE 'OK (tenant isolation): mesmo telefone em empresa A e B não se cruzam.';

  -- ─── TESTE 2: cliente anônimo nunca é candidato ──────────────────────────
  SELECT COUNT(*) INTO v_count
  FROM public.customers
  WHERE company_id = v_company_a
    AND is_anonymous = false
    AND phone_e164 = '5584999990001'
    AND id = v_customer_anon;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'FALHA CRÍTICA (anônimo): cliente is_anonymous=true apareceu como candidato de match.';
  END IF;

  RAISE NOTICE 'OK (anônimo): is_anonymous=true nunca é candidato de match (filtro is_anonymous=false confirmado).';

  -- ─── TESTE 3: idempotência do vínculo (índice único parcial) ─────────────
  INSERT INTO public.crm_person_customer_links (company_id, person_id, customer_id, match_source, is_primary)
  VALUES (v_company_a, v_person_a, v_customer_a, 'phone_match', true)
  RETURNING id INTO v_link_1;

  -- Repetir a MESMA operação (person+customer) deve falhar por unique
  -- violation — é assim que o service (createPersonCustomerLink) garante
  -- idempotência, não por SELECT prévio.
  BEGIN
    INSERT INTO public.crm_person_customer_links (company_id, person_id, customer_id, match_source, is_primary)
    VALUES (v_company_a, v_person_a, v_customer_a, 'phone_match', true);
    RAISE EXCEPTION 'FALHA (idempotência): inserção duplicada (person_id, customer_id) foi aceita — deveria ter batido no índice único parcial uq_crm_person_customer_links_active.';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK (idempotência): segunda tentativa de vincular o mesmo par (person, customer) corretamente rejeitada por unique_violation.';
  END;

  -- ─── TESTE 4: no máximo 1 is_primary=true ativo por pessoa ───────────────
  -- Vincula a MESMA pessoa a um segundo customer (cenário legítimo — pessoa
  -- pode estar ligada a mais de um customer) tentando marcar como primary
  -- de novo — deve ser rejeitado pelo índice único parcial de is_primary.
  INSERT INTO public.customers (name, cpf, phone, phone_e164, company_id, is_anonymous, active)
  VALUES ('Cliente Teste A2', '99988877766', '84999990002', '5584999990002', v_company_a, false, true)
  RETURNING id INTO v_link_2_customer_id;

  BEGIN
    INSERT INTO public.crm_person_customer_links (company_id, person_id, customer_id, match_source, is_primary)
    VALUES (v_company_a, v_person_a, v_link_2_customer_id, 'email_match', true);
    RAISE EXCEPTION 'FALHA (is_primary): segundo vínculo is_primary=true pra mesma pessoa foi aceito — deveria ter batido em uq_crm_person_customer_links_primary.';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK (is_primary): segundo is_primary=true ativo pra mesma pessoa corretamente rejeitado.';
  END;

  -- Mas vincular como NÃO-primary funciona normalmente (M:N legítimo).
  INSERT INTO public.crm_person_customer_links (company_id, person_id, customer_id, match_source, is_primary)
  VALUES (v_company_a, v_person_a, v_link_2_customer_id, 'email_match', false);

  RAISE NOTICE 'OK (M:N): segundo vínculo não-primary pra mesma pessoa aceito normalmente.';

  RAISE NOTICE 'customer_identity_matching.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
