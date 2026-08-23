-- =============================================================================
-- rpc_create_sale_recipient_atomicity.test.sql
--
-- Valida o Blocker 1 da revisão da Fase Fiscal 5C: o snapshot de
-- destinatário/endereço de entrega (`sale_recipients`) é gravado na MESMA
-- transação de `rpc_create_sale` — nunca uma venda órfã sem snapshot, nunca
-- um snapshot sem venda, qualquer erro desfaz TUDO.
--
-- Cobre:
--   1. Sucesso — novo endereço, sem salvar reutilizável: sale + sale_recipients
--      nascem juntos, source_address_id NULL.
--   2. Sucesso — novo endereço COM save_as_customer_address=true: sale +
--      sale_recipients + customer_addresses (nova linha) nascem juntos,
--      source_address_id aponta pra ela.
--   3. Sucesso — customer_address_id de um endereço já existente: o
--      snapshot usa os dados do BANCO (customer_addresses), não os campos
--      enviados em paralelo no JSON (prova que não confia no payload
--      quando um endereço já cadastrado foi selecionado).
--   4. Falha/atomicidade — payload de destinatário com campo NOT NULL
--      ausente (logradouro) → toda a transação sofre ROLLBACK: nenhuma
--      linha em sales/sale_items/stock_movements/sale_recipients sobrevive,
--      e o estoque não é decrementado.
--   5. Isolamento por company_id — p_customer_id de OUTRA empresa é
--      rejeitado antes de qualquer escrita (achado adicional corrigido
--      nesta revisão).
--   6. Isolamento por company_id — customer_address_id de um cliente
--      DIFERENTE do p_customer_id da venda é rejeitado (nunca usa endereço
--      de outro cliente, mesmo dentro da mesma empresa).
--
-- Usa company_id=1 (Santtorini, mesmo padrão de
-- integration_outbox_sale_events.test.sql) para v_company_a/v_user — essa
-- empresa já tem "Estoque Loja" e usuário admin/gerente ativo configurados
-- no ambiente de teste, evitando o problema conhecido de criar um usuário
-- sintético em `public.users` (FK direta pra `auth.users`). `company_b` é
-- criada nova só para os cenários de isolamento (5/6) — não precisa de
-- usuário próprio, só de um `customers` row.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_recipient_atomicity.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_company_b       int;
  v_customer_a      int;
  v_customer_a2     int;  -- segundo cliente da MESMA empresa 1, pra cenário 6
  v_customer_b      int;  -- cliente de OUTRA empresa, pra cenário 5
  v_category_id     int;
  v_product_id      int;
  v_variation       int;
  v_main_store_id   int;
  v_address_a       int;  -- endereço reutilizável do cliente A
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO: empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente, não relacionado ao snapshot de destinatário.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE company_id = 1 AND active = true) THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo encontrado na empresa 1.';
    RETURN;
  END IF;

  INSERT INTO public.companies (name, slug, plan, active)
  VALUES ('TESTE Atomicidade 5C B — APAGAR', 'teste-atomicidade-5c-b-apagar', 'starter', true)
  RETURNING id INTO v_company_b;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente A — APAGAR', '99988877744', '84999990077', 1, true)
  RETURNING id INTO v_customer_a;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente A2 — APAGAR', '99988877733', '84999990066', 1, true)
  RETURNING id INTO v_customer_a2;

  INSERT INTO public.customers (name, cpf, phone, company_id, active)
  VALUES ('Cliente B — APAGAR', '99988877722', '84999990055', v_company_b, true)
  RETURNING id INTO v_customer_b;

  INSERT INTO public.customer_addresses (customer_id, cep, street, number, neighborhood, city, state, municipio_ibge, ibge_source)
  VALUES (v_customer_a, '59000000', 'Rua Original', '10', 'Centro', 'Natal', 'RN', '2408102', 'viacep')
  RETURNING id INTO v_address_a;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Atomicidade 5C — APAGAR', 'teste-atomicidade-5c-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-atomicidade-5c-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Atomicidade', 'TESTE-ATOM-5C-0001', v_category_id, 1, 'x', 'y', '2026', 10, 50, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-ATOM-5C-0001-V1', true)
  RETURNING id INTO v_variation;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation, v_main_store_id, 20, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 20;

  CREATE TEMP TABLE atomicity_test_fixture (
    company_a int, company_b int, customer_a int, customer_a2 int, customer_b int,
    variation int, main_store_id int, address_a int
  );
  INSERT INTO atomicity_test_fixture VALUES (
    1, v_company_b, v_customer_a, v_customer_a2, v_customer_b,
    v_variation, v_main_store_id, v_address_a
  );

  RAISE NOTICE 'Fixture: company_a=1, customer_a=%, variation=%, main_store_id=%, address_a=%',
    v_customer_a, v_variation, v_main_store_id, v_address_a;
END $$;


-- =============================================================================
-- Cenário 1 — sucesso, novo endereço sem salvar reutilizável
-- =============================================================================
SAVEPOINT cenario_1;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid;
  v_sale_result jsonb;
  v_sale_id int;
  v_recip record;
BEGIN
  SELECT variation, main_store_id INTO v_variation, v_main_store_id FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 1: empresa de teste sem Estoque Loja configurado (fn_main_store_id retornou NULL para a empresa nova) — pré-requisito de ambiente não atendido por esta fixture isolada.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 1: nenhum usuário ativo na empresa de teste nova (users não é criado por este fixture — só company/customer/product).';
    RETURN;
  END IF;

  v_sale_result := public.rpc_create_sale(
    p_customer_id      => (SELECT customer_a FROM atomicity_test_fixture),
    p_seller_id        => NULL,
    p_payment_method   => 'pix',
    p_sale_origin      => 'store',
    p_discount_amount  => 0,
    p_cashback_used    => 0,
    p_shipping_charged => 0,
    p_notes            => 'teste atomicidade cenario 1 — apagar',
    p_items            => jsonb_build_array(
      jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)
    ),
    p_system_user_id   => v_user,
    p_delivery_recipient => jsonb_build_object(
      'nome', 'Destinatário Teste', 'cep', '59100000', 'logradouro', 'Rua Nova',
      'numero', '200', 'bairro', 'Centro', 'municipio', 'Natal', 'uf', 'RN',
      'municipio_ibge', '2408102', 'ibge_source', 'viacep', 'save_as_customer_address', false
    )
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT * INTO v_recip FROM public.sale_recipients WHERE sale_id = v_sale_id;

  IF v_recip IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 1: sale_recipients não foi criado junto com a venda.';
  END IF;
  IF v_recip.logradouro <> 'Rua Nova' OR v_recip.source_address_id IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 1: snapshot não bate com o esperado (logradouro=%, source_address_id=%).', v_recip.logradouro, v_recip.source_address_id;
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (sale + sale_recipients criados atomicamente, novo endereço sem salvar reutilizável)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1;


-- =============================================================================
-- Cenário 2 — sucesso, novo endereço COM save_as_customer_address=true
-- =============================================================================
SAVEPOINT cenario_2;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid; v_customer int;
  v_sale_result jsonb;
  v_sale_id int;
  v_recip record;
  v_new_addr_count int;
BEGIN
  SELECT variation, main_store_id, customer_a INTO v_variation, v_main_store_id, v_customer FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 2: sem Estoque Loja na empresa de teste.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 2: nenhum usuário ativo na empresa de teste.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_new_addr_count FROM public.customer_addresses WHERE customer_id = v_customer;

  v_sale_result := public.rpc_create_sale(
    v_customer, NULL, 'pix', 'store', 0, 0, 0, 'teste atomicidade cenario 2 — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
    v_user, 0, 0, NULL, NULL, 'main_store', NULL,
    jsonb_build_object(
      'nome', 'Destinatário Teste 2', 'cep', '59200000', 'logradouro', 'Rua Reutilizável',
      'numero', '300', 'bairro', 'Centro', 'municipio', 'Natal', 'uf', 'RN',
      'municipio_ibge', '2408102', 'save_as_customer_address', true
    )
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT * INTO v_recip FROM public.sale_recipients WHERE sale_id = v_sale_id;

  IF v_recip.source_address_id IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 2: source_address_id deveria apontar pro novo customer_addresses criado, veio NULL.';
  END IF;

  IF (SELECT COUNT(*) FROM public.customer_addresses WHERE customer_id = v_customer) <> v_new_addr_count + 1 THEN
    RAISE EXCEPTION 'FALHA Cenário 2: esperava exatamente 1 novo customer_addresses criado.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_recip.source_address_id AND street = 'Rua Reutilizável') THEN
    RAISE EXCEPTION 'FALHA Cenário 2: customer_addresses novo não tem os dados esperados.';
  END IF;

  RAISE NOTICE 'OK — Cenário 2 (sale + sale_recipients + customer_addresses novo, todos atômicos)';
END $$;

ROLLBACK TO SAVEPOINT cenario_2;


-- =============================================================================
-- Cenário 3 — customer_address_id de endereço já existente: snapshot usa o
-- BANCO, ignora campos conflitantes enviados em paralelo no JSON
-- =============================================================================
SAVEPOINT cenario_3;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid; v_customer int; v_address int;
  v_sale_result jsonb;
  v_sale_id int;
  v_recip record;
BEGIN
  SELECT variation, main_store_id, customer_a, address_a INTO v_variation, v_main_store_id, v_customer, v_address FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 3: sem Estoque Loja na empresa de teste.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 3: nenhum usuário ativo na empresa de teste.';
    RETURN;
  END IF;

  v_sale_result := public.rpc_create_sale(
    v_customer, NULL, 'pix', 'store', 0, 0, 0, 'teste atomicidade cenario 3 — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
    v_user, 0, 0, NULL, NULL, 'main_store', NULL,
    jsonb_build_object(
      'nome', 'Destinatário Teste 3',
      'customer_address_id', v_address,
      -- Campos de endereço DIVERGENTES enviados em paralelo — devem ser
      -- IGNORADOS; o snapshot precisa refletir o que está em
      -- customer_addresses (Rua Original), nunca isto aqui.
      'cep', '00000000', 'logradouro', 'Rua Forjada (não deveria aparecer)',
      'numero', '999', 'bairro', 'Bairro Forjado', 'municipio', 'Cidade Forjada', 'uf', 'XX'
    )
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT * INTO v_recip FROM public.sale_recipients WHERE sale_id = v_sale_id;

  IF v_recip.logradouro <> 'Rua Original' THEN
    RAISE EXCEPTION 'FALHA Cenário 3: snapshot deveria usar o endereço do banco ("Rua Original"), veio "%" — payload forjado vazou pro snapshot.', v_recip.logradouro;
  END IF;
  IF v_recip.source_address_id <> v_address THEN
    RAISE EXCEPTION 'FALHA Cenário 3: source_address_id deveria ser %, veio %.', v_address, v_recip.source_address_id;
  END IF;

  RAISE NOTICE 'OK — Cenário 3 (customer_address_id: snapshot vem do banco, payload paralelo forjado é ignorado)';
END $$;

ROLLBACK TO SAVEPOINT cenario_3;


-- =============================================================================
-- Cenário 4 — ATOMICIDADE: campo NOT NULL ausente (logradouro) → ROLLBACK
-- de TUDO (sale, sale_items, stock_movements, estoque não decrementado)
-- =============================================================================
SAVEPOINT cenario_4;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid; v_customer int;
  v_qty_before int;
  v_qty_after int;
  v_sales_before int;
  v_sales_after int;
  v_caught boolean := false;
  v_marker text := 'teste atomicidade cenario 4 (deve falhar) — apagar';
BEGIN
  SELECT variation, main_store_id, customer_a INTO v_variation, v_main_store_id, v_customer FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 4: sem Estoque Loja na empresa de teste.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 4: nenhum usuário ativo na empresa de teste.';
    RETURN;
  END IF;

  SELECT quantity INTO v_qty_before FROM public.stock_balances WHERE product_variation_id = v_variation AND stock_location_id = v_main_store_id;
  SELECT COUNT(*) INTO v_sales_before FROM public.sales WHERE notes = v_marker;

  BEGIN
    PERFORM public.rpc_create_sale(
      v_customer, NULL, 'pix', 'store', 0, 0, 0, v_marker,
      jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
      v_user, 0, 0, NULL, NULL, 'main_store', NULL,
      jsonb_build_object(
        'nome', 'Destinatário Sem Logradouro',
        'cep', '59100000',
        -- 'logradouro' PROPOSITALMENTE ausente — sale_recipients.logradouro é NOT NULL
        'numero', '200', 'bairro', 'Centro', 'municipio', 'Natal', 'uf', 'RN'
      )
    );
  EXCEPTION WHEN not_null_violation THEN
    v_caught := true;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 4: esperava not_null_violation (logradouro ausente) e a chamada não falhou como esperado.';
  END IF;

  SELECT COUNT(*) INTO v_sales_after FROM public.sales WHERE notes = v_marker;
  SELECT quantity INTO v_qty_after FROM public.stock_balances WHERE product_variation_id = v_variation AND stock_location_id = v_main_store_id;

  IF v_sales_after <> v_sales_before THEN
    RAISE EXCEPTION 'FALHA Cenário 4: venda órfã sobrou depois do erro no snapshot — atomicidade quebrada (sales_before=%, sales_after=%).', v_sales_before, v_sales_after;
  END IF;
  IF v_qty_after <> v_qty_before THEN
    RAISE EXCEPTION 'FALHA Cenário 4: estoque foi decrementado mesmo com a venda inteira tendo sofrido rollback (antes=%, depois=%).', v_qty_before, v_qty_after;
  END IF;

  RAISE NOTICE 'OK — Cenário 4 (erro no snapshot de destinatário desfaz TUDO: venda, itens, estoque — nenhuma venda órfã, nenhum efeito colateral)';
END $$;

ROLLBACK TO SAVEPOINT cenario_4;


-- =============================================================================
-- Cenário 5 — isolamento por company_id: p_customer_id de OUTRA empresa é
-- rejeitado (achado adicional corrigido nesta revisão)
-- =============================================================================
SAVEPOINT cenario_5;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid; v_customer_b int;
  v_caught boolean := false;
BEGIN
  SELECT variation, main_store_id, customer_b INTO v_variation, v_main_store_id, v_customer_b FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 5: sem Estoque Loja na empresa de teste.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 5: nenhum usuário ativo na empresa de teste.';
    RETURN;
  END IF;

  BEGIN
    -- v_user pertence à empresa A, mas v_customer_b pertence à empresa B —
    -- deve ser rejeitado ANTES de qualquer escrita.
    PERFORM public.rpc_create_sale(
      v_customer_b, NULL, 'pix', 'store', 0, 0, 0, 'teste atomicidade cenario 5 (deve falhar) — apagar',
      jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
      v_user
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%não pertence à empresa%' THEN
      v_caught := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 5: cliente de outra empresa deveria ser rejeitado com "Cliente não pertence à empresa.", não foi.';
  END IF;

  RAISE NOTICE 'OK — Cenário 5 (customer_id de outra empresa rejeitado antes de qualquer escrita)';
END $$;

ROLLBACK TO SAVEPOINT cenario_5;


-- =============================================================================
-- Cenário 6 — isolamento: customer_address_id de um cliente DIFERENTE do
-- p_customer_id da venda (mesma empresa) é rejeitado
-- =============================================================================
SAVEPOINT cenario_6;

DO $$
DECLARE
  v_variation int; v_main_store_id int; v_user uuid; v_customer_a2 int; v_address_a int;
  v_caught boolean := false;
BEGIN
  SELECT variation, main_store_id, customer_a2, address_a INTO v_variation, v_main_store_id, v_customer_a2, v_address_a FROM atomicity_test_fixture;
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 6: sem Estoque Loja na empresa de teste.';
    RETURN;
  END IF;

  SELECT id INTO v_user FROM public.users WHERE company_id = (SELECT company_a FROM atomicity_test_fixture) AND active = true LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'PULADO Cenário 6: nenhum usuário ativo na empresa de teste.';
    RETURN;
  END IF;

  BEGIN
    -- v_address_a pertence ao Cliente A, mas a venda é para o Cliente A2
    -- (mesma empresa) — deve ser rejeitado.
    PERFORM public.rpc_create_sale(
      v_customer_a2, NULL, 'pix', 'store', 0, 0, 0, 'teste atomicidade cenario 6 (deve falhar) — apagar',
      jsonb_build_array(jsonb_build_object('product_variation_id', v_variation, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
      v_user, 0, 0, NULL, NULL, 'main_store', NULL,
      jsonb_build_object('nome', 'Teste', 'customer_address_id', v_address_a)
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%Endereço de entrega selecionado não encontrado%' THEN
      v_caught := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_caught THEN
    RAISE EXCEPTION 'FALHA Cenário 6: customer_address_id de outro cliente deveria ser rejeitado, não foi.';
  END IF;

  RAISE NOTICE 'OK — Cenário 6 (customer_address_id de outro cliente rejeitado, nunca usa endereço de terceiros)';
END $$;

ROLLBACK TO SAVEPOINT cenario_6;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM (ou foram pulados por falta de pré-requisito de ambiente — ver NOTICEs acima) ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO).
-- =============================================================================
