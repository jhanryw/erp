-- =============================================================================
-- rpc_return_cancel_guard_against_exchanges.test.sql
--
-- Valida a correção de 20260915b_guard_cancel_return_against_exchanged_sales.sql:
-- rpc_return_sale/rpc_cancel_sale rejeitam qualquer venda com troca
-- (parcial OU total) já registrada, e uma tentativa rejeitada não produz
-- NENHUM efeito colateral (estoque, cashback, finance_entries, status).
--
-- Cenários (pedido do usuário, 2026-09-15):
--   1. venda normal -> devolução funciona.
--   2. venda normal -> cancelamento funciona.
--   3. troca total -> devolução rejeitada.
--   4. troca total -> cancelamento rejeitado.
--   5-8. nenhuma tentativa rejeitada altera estoque/cashback/finance_entries/status.
--   9. troca parcial -> mesma proteção conservadora (ver nota abaixo).
--
-- NOTA sobre o cenário 9: a arquitetura atual de rpc_return_sale/
-- rpc_cancel_sale opera SEMPRE na venda inteira (todos os sale_items,
-- cashback/finance/outbox no nível da venda) — não existe granularidade
-- por item. Corrigir isso pra devolver/cancelar só a "quantidade
-- remanescente" de uma troca parcial exigiria reconciliar cashback/
-- estoque/finance/fiscal entre a venda original e a(s) venda(s)-filha —
-- fora de escopo (mesma decisão já tomada pra devolução financeira
-- parcial). O limite identificado é exatamente esse: hoje NENHUMA
-- devolução/cancelamento parcial por quantidade é suportada — a proteção
-- mais conservadora contra corrupção é bloquear inteiramente sempre que
-- QUALQUER troca (parcial ou total) já exista, o que este cenário prova.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_return_cancel_guard_against_exchanges.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_main_store_id INT;
  v_test_user_id  UUID;
  v_customer_id   INT;
  v_category_id   INT;
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

  INSERT INTO public.customers (name, company_id, is_anonymous, active)
  VALUES ('TESTE Guard Cancel/Return — APAGAR', 1, false, true)
  RETURNING id INTO v_customer_id;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Guard Cancel/Return — APAGAR', 'teste-guard-cancel-return-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-guard-cancel-return-apagar';

  CREATE TEMP TABLE guard_test_fixture (main_store_id int, user_id uuid, customer_id int, category_id int);
  INSERT INTO guard_test_fixture VALUES (v_main_store_id, v_test_user_id, v_customer_id, v_category_id);

  RAISE NOTICE 'Fixture: main_store=%, user=%, customer=%', v_main_store_id, v_test_user_id, v_customer_id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.make_guard_test_variation(p_sku text, p_cost numeric, p_qty int) RETURNS int AS $$
DECLARE
  v_category_id int;
  v_main_store_id int;
  v_product_id int;
  v_variation_id int;
BEGIN
  SELECT category_id, main_store_id INTO v_category_id, v_main_store_id FROM guard_test_fixture;

  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, active)
  VALUES ('TESTE ' || p_sku, p_sku, v_category_id, 1, 'x', 'y', '2026', p_cost, p_cost * 2, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, p_sku || '-V1', true)
  RETURNING id INTO v_variation_id;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_id, v_main_store_id, p_qty, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = p_qty;

  RETURN v_variation_id;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- Cenários 1 e 2 — venda NORMAL (sem nenhuma troca): devolução e
-- cancelamento continuam funcionando exatamente como antes.
-- =============================================================================
SAVEPOINT cenario_1_2;

DO $$
DECLARE
  v_user uuid; v_customer int; v_var int;
  v_sale_result jsonb; v_sale_id int;
  v_sale record;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM guard_test_fixture;
  v_var := pg_temp.make_guard_test_variation('CEN-1', 8, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario 1 — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  PERFORM public.rpc_return_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);

  SELECT status, returned_at INTO v_sale FROM public.sales WHERE id = v_sale_id;
  IF v_sale.status <> 'returned' OR v_sale.returned_at IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 1: devolução de venda normal deveria ter funcionado (status=%, returned_at=%).', v_sale.status, v_sale.returned_at;
  END IF;

  RAISE NOTICE 'OK — Cenário 1 (venda normal: devolução funciona)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1_2;

DO $$
DECLARE
  v_user uuid; v_customer int; v_var int;
  v_sale_result jsonb; v_sale_id int;
  v_sale record;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM guard_test_fixture;
  v_var := pg_temp.make_guard_test_variation('CEN-2', 8, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario 2 — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  PERFORM public.rpc_cancel_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);

  SELECT status, cancelled_at INTO v_sale FROM public.sales WHERE id = v_sale_id;
  IF v_sale.status <> 'cancelled' OR v_sale.cancelled_at IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário 2: cancelamento de venda normal deveria ter funcionado (status=%, cancelled_at=%).', v_sale.status, v_sale.cancelled_at;
  END IF;

  RAISE NOTICE 'OK — Cenário 2 (venda normal: cancelamento funciona)';
END $$;

ROLLBACK TO SAVEPOINT cenario_1_2;


-- =============================================================================
-- Cenários 3, 4, 5, 6, 7, 8 — troca TOTAL: devolução e cancelamento
-- posteriores são rejeitados, e a rejeição não altera estoque, cashback,
-- finance_entries nem status.
-- =============================================================================
SAVEPOINT cenario_3_a_8;

DO $$
DECLARE
  v_user uuid; v_customer int;
  v_var_original int; v_var_nova int;
  v_sale_result jsonb; v_sale_id int;
  v_stock_before numeric; v_stock_after numeric;
  v_cashback_count_before int; v_cashback_count_after int;
  v_finance_count_before int; v_finance_count_after int;
  v_status_before text; v_status_after text;
  v_raised boolean;
  v_main_store_id int;
BEGIN
  SELECT user_id, customer_id, main_store_id INTO v_user, v_customer, v_main_store_id FROM guard_test_fixture;

  v_var_original := pg_temp.make_guard_test_variation('CEN-3-ORIG', 8, 10);
  v_var_nova      := pg_temp.make_guard_test_variation('CEN-3-NOVA', 5, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario 3-8 — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_original, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  -- Troca TOTAL (1 de 1 unidade) — não altera status (correção já aplicada).
  PERFORM public.rpc_process_exchange(
    p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object('sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id), 'quantity_returned', 1)),
    p_notes => 'teste cenario 3-8 — apagar', p_user_id => v_user
  );

  -- ── Snapshot ANTES das tentativas rejeitadas ──
  SELECT quantity INTO v_stock_before FROM stock_balances WHERE product_variation_id = v_var_original AND stock_location_id = v_main_store_id;
  SELECT COUNT(*) INTO v_cashback_count_before FROM cashback_transactions WHERE sale_id = v_sale_id;
  SELECT COUNT(*) INTO v_finance_count_before FROM finance_entries WHERE sale_id = v_sale_id;
  SELECT status INTO v_status_before FROM sales WHERE id = v_sale_id;

  -- ── Cenário 3: devolução rejeitada ──
  v_raised := false;
  BEGIN
    PERFORM public.rpc_return_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM NOT ILIKE '%trocado%' THEN
      RAISE EXCEPTION 'FALHA Cenário 3: rejeitou por motivo inesperado: %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FALHA Cenário 3: devolução de venda com troca total deveria ter sido rejeitada.';
  END IF;
  RAISE NOTICE 'OK — Cenário 3 (troca total: devolução rejeitada)';

  -- ── Cenário 4: cancelamento rejeitado ──
  v_raised := false;
  BEGIN
    PERFORM public.rpc_cancel_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM NOT ILIKE '%trocado%' THEN
      RAISE EXCEPTION 'FALHA Cenário 4: rejeitou por motivo inesperado: %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FALHA Cenário 4: cancelamento de venda com troca total deveria ter sido rejeitado.';
  END IF;
  RAISE NOTICE 'OK — Cenário 4 (troca total: cancelamento rejeitado)';

  -- ── Cenários 5-8: nenhuma das duas tentativas rejeitadas alterou nada ──
  SELECT quantity INTO v_stock_after FROM stock_balances WHERE product_variation_id = v_var_original AND stock_location_id = v_main_store_id;
  SELECT COUNT(*) INTO v_cashback_count_after FROM cashback_transactions WHERE sale_id = v_sale_id;
  SELECT COUNT(*) INTO v_finance_count_after FROM finance_entries WHERE sale_id = v_sale_id;
  SELECT status INTO v_status_after FROM sales WHERE id = v_sale_id;

  IF v_stock_before <> v_stock_after THEN
    RAISE EXCEPTION 'FALHA Cenário 5: estoque mudou de % para % após tentativas rejeitadas.', v_stock_before, v_stock_after;
  END IF;
  RAISE NOTICE 'OK — Cenário 5 (tentativa rejeitada não altera estoque)';

  IF v_cashback_count_before <> v_cashback_count_after THEN
    RAISE EXCEPTION 'FALHA Cenário 6: cashback_transactions mudou de % para % linhas após tentativas rejeitadas.', v_cashback_count_before, v_cashback_count_after;
  END IF;
  RAISE NOTICE 'OK — Cenário 6 (tentativa rejeitada não altera cashback)';

  IF v_finance_count_before <> v_finance_count_after THEN
    RAISE EXCEPTION 'FALHA Cenário 7: finance_entries mudou de % para % linhas após tentativas rejeitadas.', v_finance_count_before, v_finance_count_after;
  END IF;
  RAISE NOTICE 'OK — Cenário 7 (tentativa rejeitada não cria finance_entry)';

  IF v_status_before <> v_status_after THEN
    RAISE EXCEPTION 'FALHA Cenário 8: status mudou de % para % após tentativas rejeitadas.', v_status_before, v_status_after;
  END IF;
  RAISE NOTICE 'OK — Cenário 8 (tentativa rejeitada não altera status — venda continua "%")', v_status_after;
END $$;

ROLLBACK TO SAVEPOINT cenario_3_a_8;


-- =============================================================================
-- Cenário 9 — troca PARCIAL: mesma proteção conservadora (limite
-- identificado documentado no cabeçalho deste arquivo).
-- =============================================================================
SAVEPOINT cenario_9;

DO $$
DECLARE
  v_user uuid; v_customer int;
  v_var_a int; v_var_b int; v_var_nova int;
  v_sale_result jsonb; v_sale_id int;
  v_raised boolean;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM guard_test_fixture;

  v_var_a    := pg_temp.make_guard_test_variation('CEN-9-A', 10, 10);
  v_var_b    := pg_temp.make_guard_test_variation('CEN-9-B', 20, 10);
  v_var_nova := pg_temp.make_guard_test_variation('CEN-9-NOVA', 12, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario 9 — apagar',
    p_items => jsonb_build_array(
      jsonb_build_object('product_variation_id', v_var_a, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10),
      jsonb_build_object('product_variation_id', v_var_b, 'quantity', 1, 'unit_price', 70, 'unit_cost', 20)
    ),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  -- Troca PARCIAL: só o item A (1 de 2 itens da venda).
  PERFORM public.rpc_process_exchange(
    p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id AND product_variation_id = v_var_a),
      'quantity_returned', 1
    )),
    p_notes => 'teste cenario 9 — apagar', p_user_id => v_user
  );

  -- Confirma que a venda continua ATIVA (não veio 'returned' da troca parcial).
  IF (SELECT status FROM sales WHERE id = v_sale_id) = 'returned' THEN
    RAISE EXCEPTION 'FALHA Cenário 9 (pré-condição): troca parcial não deveria ter marcado returned.';
  END IF;

  -- Devolução da venda inteira, com uma troca PARCIAL já registrada,
  -- também deve ser rejeitada — não há suporte a devolução só da
  -- quantidade remanescente (limite identificado, ver cabeçalho).
  v_raised := false;
  BEGIN
    PERFORM public.rpc_return_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
    IF SQLERRM NOT ILIKE '%trocado%' THEN
      RAISE EXCEPTION 'FALHA Cenário 9: rejeitou por motivo inesperado: %', SQLERRM;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'FALHA Cenário 9: devolução de venda com troca PARCIAL deveria ter sido rejeitada (proteção conservadora — sem suporte a devolução por quantidade remanescente).';
  END IF;

  RAISE NOTICE 'OK — Cenário 9 (troca parcial: mesma proteção conservadora aplicada, limite documentado)';
END $$;

ROLLBACK TO SAVEPOINT cenario_9;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM (1-9) ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO).
-- =============================================================================
