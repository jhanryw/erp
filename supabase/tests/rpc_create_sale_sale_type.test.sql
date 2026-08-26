-- =============================================================================
-- rpc_create_sale_sale_type.test.sql
--
-- Fundação varejo/atacado (2026-08-31) — prova as garantias da nova
-- dimensão comercial `sales.sale_type` (retail/wholesale):
--   1. Venda sem p_sale_type → default 'retail'.
--   2. Venda com p_sale_type='wholesale' → persiste corretamente.
--   3. Valor inválido → rejeitado com P0001 (nunca aceita silenciosamente).
--   4. Cancelamento preserva sale_type/sales_channel (rpc_cancel_sale só
--      faz UPDATE na linha existente — nunca deveria mudar a modalidade).
--   5. Devolução preserva sale_type/sales_channel (mesma garantia).
--   6. Troca (rpc_process_exchange, devolução total) preserva sale_type/
--      sales_channel na venda original e carrega ambos no evento outbox
--      sale.refunded.
--   7. sale.completed carrega sale_type/sales_channel no payload —
--      consumidor futuro não precisa reconsultar `sales`.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_sale_type.test.sql
--
-- Mesmo padrão de fixture de integration_outbox_sale_events.test.sql —
-- company_id=1, precisa de Estoque Loja configurado.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_category_id   INT;
  v_test_user_id  UUID;
  v_main_store_id INT;
  v_product_id    INT;
  v_variation_id  INT;
  v_sale_result   JSONB;
  v_sale_id_retail    INT;
  v_sale_id_wholesale INT;
  v_sale_id_exchange  INT;
  v_persisted_type    TEXT;
  v_persisted_channel TEXT;
  v_event         RECORD;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO: empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente.';
    RETURN;
  END IF;

  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo admin/gerente encontrado na empresa 1.';
    RETURN;
  END IF;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Sale Type — APAGAR', 'teste-sale-type-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-sale-type-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Sale Type', 'TESTE-SALETYPE-0001', v_category_id, 1, 'x', 'y', '2026', 10, 50, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-SALETYPE-0001-V1', true)
  RETURNING id INTO v_variation_id;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_id, v_main_store_id, 100, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 100;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 1 — sem p_sale_type → default 'retail'
  -- ═══════════════════════════════════════════════════════════════════════
  v_sale_result := public.rpc_create_sale(
    NULL, v_test_user_id, 'pix', 'store', 0, 0, 0, 'teste sale_type — default retail — apagar',
    jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
    v_test_user_id
  );
  v_sale_id_retail := (v_sale_result->>'id')::int;

  SELECT sale_type, sales_channel INTO v_persisted_type, v_persisted_channel FROM public.sales WHERE id = v_sale_id_retail;
  IF v_persisted_type IS DISTINCT FROM 'retail' THEN
    RAISE EXCEPTION 'FALHA (teste 1): esperado sale_type default = retail, veio %.', v_persisted_type;
  END IF;
  IF v_persisted_channel IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA (teste 1): esperado sales_channel default = NULL, veio %.', v_persisted_channel;
  END IF;
  RAISE NOTICE 'OK (teste 1): sem p_sale_type/p_sales_channel → default retail/NULL.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 2 — p_sale_type='wholesale' explícito → persiste
  -- ═══════════════════════════════════════════════════════════════════════
  v_sale_result := public.rpc_create_sale(
    p_customer_id => NULL, p_seller_id => v_test_user_id, p_payment_method => 'pix',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
    p_notes => 'teste sale_type — wholesale explícito — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 1, 'unit_price', 45, 'unit_cost', 10, 'discount_amount', 0)),
    p_system_user_id => v_test_user_id,
    p_sale_type => 'wholesale', p_sales_channel => 'pos'
  );
  v_sale_id_wholesale := (v_sale_result->>'id')::int;

  SELECT sale_type, sales_channel INTO v_persisted_type, v_persisted_channel FROM public.sales WHERE id = v_sale_id_wholesale;
  IF v_persisted_type IS DISTINCT FROM 'wholesale' THEN
    RAISE EXCEPTION 'FALHA (teste 2): esperado sale_type=wholesale, veio %.', v_persisted_type;
  END IF;
  IF v_persisted_channel IS DISTINCT FROM 'pos' THEN
    RAISE EXCEPTION 'FALHA (teste 2): esperado sales_channel=pos, veio %.', v_persisted_channel;
  END IF;
  RAISE NOTICE 'OK (teste 2): p_sale_type=wholesale/p_sales_channel=pos persistem corretamente.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 3 — valor inválido rejeitado (P0001, nunca aceito silenciosamente)
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rpc_create_sale(
      NULL, v_test_user_id, 'pix', 'store', 0, 0, 0, 'teste sale_type inválido — apagar',
      jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 1, 'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0)),
      v_test_user_id, 0, 0, NULL, NULL, 'main_store', NULL, NULL, 'atacado_errado'
    );
    RAISE EXCEPTION 'FALHA (teste 3): p_sale_type inválido deveria ter sido rejeitado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%p_sale_type inválido%' THEN
        RAISE NOTICE 'OK (teste 3): p_sale_type inválido corretamente rejeitado (%).', SQLERRM;
      ELSE
        RAISE;
      END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 4 — cancelamento preserva sale_type/sales_channel + outbox carrega ambos
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_cancel_sale(v_sale_id_wholesale, v_test_user_id);

  SELECT sale_type, sales_channel INTO v_persisted_type, v_persisted_channel FROM public.sales WHERE id = v_sale_id_wholesale;
  IF v_persisted_type IS DISTINCT FROM 'wholesale' THEN
    RAISE EXCEPTION 'FALHA (teste 4): cancelamento não deveria alterar sale_type, veio %.', v_persisted_type;
  END IF;

  SELECT * INTO v_event FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id_wholesale::text AND event_type = 'sale.cancelled';
  IF v_event.payload->>'sale_type' IS DISTINCT FROM 'wholesale' THEN
    RAISE EXCEPTION 'FALHA (teste 4): payload de sale.cancelled deveria carregar sale_type=wholesale, veio %.', v_event.payload->>'sale_type';
  END IF;
  IF v_event.payload->>'sales_channel' IS DISTINCT FROM 'pos' THEN
    RAISE EXCEPTION 'FALHA (teste 4): payload de sale.cancelled deveria carregar sales_channel=pos, veio %.', v_event.payload->>'sales_channel';
  END IF;
  RAISE NOTICE 'OK (teste 4): cancelamento preserva sale_type/sales_channel e o outbox sale.cancelled carrega ambos.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 5 — devolução preserva sale_type/sales_channel (venda nova, retail)
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_return_sale(v_sale_id_retail, v_test_user_id);

  SELECT sale_type INTO v_persisted_type FROM public.sales WHERE id = v_sale_id_retail;
  IF v_persisted_type IS DISTINCT FROM 'retail' THEN
    RAISE EXCEPTION 'FALHA (teste 5): devolução não deveria alterar sale_type, veio %.', v_persisted_type;
  END IF;

  SELECT * INTO v_event FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id_retail::text AND event_type = 'sale.refunded';
  IF v_event.payload->>'sale_type' IS DISTINCT FROM 'retail' THEN
    RAISE EXCEPTION 'FALHA (teste 5): payload de sale.refunded deveria carregar sale_type=retail, veio %.', v_event.payload->>'sale_type';
  END IF;
  RAISE NOTICE 'OK (teste 5): devolução preserva sale_type e o outbox sale.refunded carrega o valor correto.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 6 — troca (devolução total) preserva sale_type/sales_channel de
  -- uma venda de atacado e o evento sale.refunded emitido por
  -- rpc_process_exchange carrega ambos.
  -- ═══════════════════════════════════════════════════════════════════════
  DECLARE
    v_customer_id  INT;
    v_sale_item_id INT;
    v_exchange_result JSONB;
  BEGIN
    INSERT INTO public.customers (cpf, name, phone, company_id)
    VALUES ('22233344400', 'Cliente Teste Sale Type', '84999990000', 1)
    ON CONFLICT (cpf, company_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_customer_id;

    v_sale_result := public.rpc_create_sale(
      p_customer_id => v_customer_id, p_seller_id => v_test_user_id, p_payment_method => 'pix',
      p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
      p_notes => 'teste sale_type — venda para troca (atacado) — apagar',
      p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 2, 'unit_price', 45, 'unit_cost', 10, 'discount_amount', 0)),
      p_system_user_id => v_test_user_id,
      p_sale_type => 'wholesale', p_sales_channel => 'wholesale_site'
    );
    v_sale_id_exchange := (v_sale_result->>'id')::int;

    SELECT id INTO v_sale_item_id FROM public.sale_items WHERE sale_id = v_sale_id_exchange LIMIT 1;

    v_exchange_result := public.rpc_process_exchange(
      1, v_sale_id_exchange, v_customer_id,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_sale_item_id, 'quantity_returned', 2)),
      'teste sale_type — troca total — apagar',
      v_test_user_id
    );

    SELECT sale_type, sales_channel INTO v_persisted_type, v_persisted_channel FROM public.sales WHERE id = v_sale_id_exchange;
    IF v_persisted_type IS DISTINCT FROM 'wholesale' THEN
      RAISE EXCEPTION 'FALHA (teste 6): troca total não deveria alterar sale_type da venda original, veio %.', v_persisted_type;
    END IF;

    SELECT * INTO v_event FROM public.integration_outbox
    WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id_exchange::text AND event_type = 'sale.refunded';
    IF v_event.payload->>'sale_type' IS DISTINCT FROM 'wholesale' THEN
      RAISE EXCEPTION 'FALHA (teste 6): payload de sale.refunded (via troca) deveria carregar sale_type=wholesale, veio %.', v_event.payload->>'sale_type';
    END IF;
    IF v_event.payload->>'sales_channel' IS DISTINCT FROM 'wholesale_site' THEN
      RAISE EXCEPTION 'FALHA (teste 6): payload de sale.refunded (via troca) deveria carregar sales_channel=wholesale_site, veio %.', v_event.payload->>'sales_channel';
    END IF;
    RAISE NOTICE 'OK (teste 6): troca total preserva sale_type/sales_channel da venda original e o outbox sale.refunded (rpc_process_exchange) carrega ambos.';
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 7 — sale.completed sempre carrega sale_type/sales_channel
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT * INTO v_event FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id_wholesale::text AND event_type = 'sale.completed';
  IF v_event.payload->>'sale_type' IS DISTINCT FROM 'wholesale' THEN
    RAISE EXCEPTION 'FALHA (teste 7): payload de sale.completed deveria carregar sale_type=wholesale, veio %.', v_event.payload->>'sale_type';
  END IF;
  IF v_event.payload->>'sales_channel' IS DISTINCT FROM 'pos' THEN
    RAISE EXCEPTION 'FALHA (teste 7): payload de sale.completed deveria carregar sales_channel=pos, veio %.', v_event.payload->>'sales_channel';
  END IF;
  RAISE NOTICE 'OK (teste 7): sale.completed carrega sale_type/sales_channel no payload.';

  RAISE NOTICE 'rpc_create_sale_sale_type.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
