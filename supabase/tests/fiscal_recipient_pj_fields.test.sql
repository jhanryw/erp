-- =============================================================================
-- fiscal_recipient_pj_fields.test.sql
--
-- Fase Fiscal 6 (PDV — comprovante/NFC-e/NF-e) — prova as duas mudanças de
-- 202609021000_fiscal_recipient_pj_fields.sql:
--   1. sale_recipients aceita uma linha com SÓ CPF, sem nenhum endereço
--      (cenário NFC-e de balcão — requisito 6 do pedido).
--   2. inscricao_estadual/indicador_ie existem e o CHECK de indicador_ie
--      só aceita 1/2/9.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/fiscal_recipient_pj_fields.test.sql
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_sale_id       INT;
  v_customer_id   INT;
  v_test_user_id  UUID;
  v_recipient_id  INT;
  v_rejected      BOOLEAN := false;
BEGIN
  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo na empresa 1.';
    RETURN;
  END IF;

  INSERT INTO public.customers (cpf, name, phone, company_id, is_anonymous)
  VALUES (NULL, 'Cliente Teste Fiscal 6 — APAGAR', '84999997777', 1, false)
  RETURNING id INTO v_customer_id;

  -- Venda mínima só pra ter um sale_id real pra referenciar (FK de
  -- sale_recipients.sale_id) — não usa rpc_create_sale aqui de propósito,
  -- este teste é só sobre o SCHEMA de sale_recipients, não sobre o fluxo
  -- de venda completo (já coberto por pdv_wholesale_retail_shared_stock.
  -- test.sql). INSERT direto, dados mínimos plausíveis.
  INSERT INTO public.sales (customer_id, seller_id, company_id, status, payment_method, subtotal, total, sale_type, sales_channel, sale_origin, sale_number, receipt_token)
  VALUES (v_customer_id, v_test_user_id, 1, 'paid', 'pix', 10, 10, 'retail', 'pos', 'store', 'TESTE-FISCAL6-' || floor(random()*1000000)::text, gen_random_uuid())
  RETURNING id INTO v_sale_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- 1. Linha só com CPF, SEM nenhum campo de endereço/nome — precisa
  --    aceitar (NFC-e de balcão, requisito 6 do pedido).
  -- ═══════════════════════════════════════════════════════════════════════
  INSERT INTO public.sale_recipients (sale_id, company_id, cpf)
  VALUES (v_sale_id, 1, '11144477735')
  RETURNING id INTO v_recipient_id;

  IF v_recipient_id IS NULL THEN
    RAISE EXCEPTION 'FALHA: sale_recipients deveria aceitar uma linha só com CPF (sem endereço).';
  END IF;
  RAISE NOTICE 'OK: sale_recipients aceita linha com só CPF, sem endereço/nome.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- 2. inscricao_estadual/indicador_ie existem e persistem valor válido.
  -- ═══════════════════════════════════════════════════════════════════════
  UPDATE public.sale_recipients
  SET cnpj = '11222333000181', inscricao_estadual = '123456789', indicador_ie = 1
  WHERE id = v_recipient_id;

  PERFORM 1 FROM public.sale_recipients
  WHERE id = v_recipient_id AND inscricao_estadual = '123456789' AND indicador_ie = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA: inscricao_estadual/indicador_ie não persistiram como esperado.';
  END IF;
  RAISE NOTICE 'OK: inscricao_estadual/indicador_ie persistem valor válido (indicador_ie=1).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- 3. indicador_ie rejeita valor fora de {1,2,9}.
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    UPDATE public.sale_recipients SET indicador_ie = 5 WHERE id = v_recipient_id;
    v_rejected := false;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHA: indicador_ie deveria rejeitar valor 5 (só aceita 1/2/9).';
  END IF;
  RAISE NOTICE 'OK: indicador_ie rejeita valor fora de {1,2,9} (CHECK ativo).';

  -- ═══════════════════════════════════════════════════════════════════════
  -- 4. UNIQUE(sale_id) preservado — segunda linha pra mesma venda ainda
  --    falha (upsertSaleRecipient depende disso pra ON CONFLICT(sale_id)).
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.sale_recipients (sale_id, company_id, cpf) VALUES (v_sale_id, 1, '11144477735');
    v_rejected := false;
  EXCEPTION WHEN unique_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FALHA: UNIQUE(sale_id) deveria impedir uma segunda linha pra mesma venda.';
  END IF;
  RAISE NOTICE 'OK: UNIQUE(sale_id) preservado — upsertSaleRecipient pode confiar em ON CONFLICT(sale_id).';

  RAISE NOTICE 'fiscal_recipient_pj_fields.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
