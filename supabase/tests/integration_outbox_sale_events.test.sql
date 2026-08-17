-- =============================================================================
-- integration_outbox_sale_events.test.sql
--
-- Prova transacional (seção 40 do pedido da Fase 2): venda e evento de
-- domínio nascem atomicamente. Cobre: sale.completed criado por
-- rpc_create_sale, sale.cancelled criado por rpc_cancel_sale,
-- company_id/aggregate_id/event_id corretos, UNIQUE(event_id) bloqueando
-- duplicata, e — por construção, já que o arquivo inteiro roda dentro de
-- BEGIN...ROLLBACK — que nenhum evento nem venda sobrevive fora da
-- transação.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/integration_outbox_sale_events.test.sql
--
-- Usa company_id=1 (Santtorini, mesmo padrão de product_sku_identity.test.sql
-- e rpc_import_products_batch.test.sql) — precisa de um "Estoque Loja"
-- (stock_locations.is_main_store=true) já configurado para essa empresa; se
-- não houver, o teste avisa e para (não é uma falha do outbox, é
-- pré-requisito de ambiente).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_category_id     INT;
  v_test_user_id    UUID;
  v_main_store_id   INT;
  v_product_id      INT;
  v_variation_id    INT;
  v_sale_result     JSONB;
  v_sale_id         INT;
  v_event_count     INT;
  v_event           RECORD;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO: empresa 1 sem Estoque Loja configurado — pré-requisito de ambiente, não relacionado ao outbox.';
    RETURN;
  END IF;

  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND role IN ('admin','gerente') AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo admin/gerente encontrado na empresa 1.';
    RETURN;
  END IF;

  -- ─── Fixture: categoria + produto + variação + estoque ───────────────────
  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Outbox — APAGAR', 'teste-outbox-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-outbox-apagar';

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('Produto Teste Outbox', 'TESTE-OUTBOX-SKU-0001', v_category_id, 1, 'x', 'y', '2026', 10, 50, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-OUTBOX-SKU-0001-V1', true)
  RETURNING id INTO v_variation_id;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_id, v_main_store_id, 10, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 10;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 1 — rpc_create_sale gera exatamente 1 evento sale.completed
  -- ═══════════════════════════════════════════════════════════════════════
  v_sale_result := public.rpc_create_sale(
    NULL, NULL, 'pix', 'store', 0, 0, 0, 'venda de teste — outbox',
    jsonb_build_array(jsonb_build_object(
      'product_variation_id', v_variation_id, 'quantity', 1,
      'unit_price', 50, 'unit_cost', 10, 'discount_amount', 0
    )),
    v_test_user_id
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT COUNT(*) INTO v_event_count
  FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id::text AND event_type = 'sale.completed';

  IF v_event_count <> 1 THEN
    RAISE EXCEPTION 'FALHA: esperado exatamente 1 evento sale.completed para a venda #%, achou %.', v_sale_id, v_event_count;
  END IF;

  SELECT * INTO v_event FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id::text AND event_type = 'sale.completed';

  IF v_event.event_id <> ('sale:' || v_sale_id || ':completed') THEN
    RAISE EXCEPTION 'FALHA: event_id esperado sale:%:completed, veio %.', v_sale_id, v_event.event_id;
  END IF;
  IF v_event.company_id <> 1 THEN
    RAISE EXCEPTION 'FALHA: company_id do evento deveria ser 1, veio %.', v_event.company_id;
  END IF;
  IF v_event.status <> 'pending' THEN
    RAISE EXCEPTION 'FALHA: evento deveria nascer status=pending, veio %.', v_event.status;
  END IF;
  IF (v_event.payload->>'sale_id')::int <> v_sale_id THEN
    RAISE EXCEPTION 'FALHA: payload.sale_id não bate com a venda criada.';
  END IF;

  RAISE NOTICE 'OK (sale.completed): venda #% gerou exatamente 1 evento, event_id=%, company_id correto, payload correto.', v_sale_id, v_event.event_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 2 — UNIQUE(event_id) bloqueia duplicata (idempotência na raiz)
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    INSERT INTO public.integration_outbox (company_id, event_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES (1, v_event.event_id, 'sale.completed', 'sale', v_sale_id::text, '{}'::jsonb);
    RAISE EXCEPTION 'FALHA (idempotência): inserir event_id duplicado foi aceito — UNIQUE(event_id) não bloqueou.';
  EXCEPTION
    WHEN unique_violation THEN
      RAISE NOTICE 'OK (idempotência): event_id duplicado corretamente rejeitado por unique_violation.';
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 3 — rpc_cancel_sale gera exatamente 1 evento sale.cancelled
  -- ═══════════════════════════════════════════════════════════════════════
  PERFORM public.rpc_cancel_sale(v_sale_id, v_test_user_id);

  SELECT COUNT(*) INTO v_event_count
  FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id::text AND event_type = 'sale.cancelled';

  IF v_event_count <> 1 THEN
    RAISE EXCEPTION 'FALHA: esperado exatamente 1 evento sale.cancelled para a venda #%, achou %.', v_sale_id, v_event_count;
  END IF;

  SELECT * INTO v_event FROM public.integration_outbox
  WHERE aggregate_type = 'sale' AND aggregate_id = v_sale_id::text AND event_type = 'sale.cancelled';

  IF v_event.event_id <> ('sale:' || v_sale_id || ':cancelled') THEN
    RAISE EXCEPTION 'FALHA: event_id esperado sale:%:cancelled, veio %.', v_sale_id, v_event.event_id;
  END IF;

  RAISE NOTICE 'OK (sale.cancelled): cancelamento da venda #% gerou exatamente 1 evento, event_id correto.', v_sale_id;

  -- ═══════════════════════════════════════════════════════════════════════
  -- TESTE 4 — recancelar a mesma venda falha ANTES de chegar no outbox
  -- (a guarda de estado terminal já existente impede — não é o outbox que
  -- protege isso, mas confirma que não há caminho de gerar 2 eventos
  -- sale.cancelled para a mesma venda).
  -- ═══════════════════════════════════════════════════════════════════════
  BEGIN
    PERFORM public.rpc_cancel_sale(v_sale_id, v_test_user_id);
    RAISE EXCEPTION 'FALHA: recancelar venda já cancelada deveria ter sido rejeitado pela guarda de estado.';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%já foi cancelada%' THEN
        RAISE NOTICE 'OK: recancelamento rejeitado pela guarda de estado (não chegou a tentar novo evento).';
      ELSE
        RAISE;
      END IF;
  END;

  RAISE NOTICE 'integration_outbox_sale_events.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
