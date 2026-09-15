-- =============================================================================
-- rpc_process_exchange_no_returned_status.test.sql
--
-- Valida a correção de 20260915_fix_rpc_process_exchange_no_returned_status.sql:
-- troca (parcial OU total) NUNCA altera sales.status/returned_at/returned_by
-- da venda original. exchanges/exchange_items são a única fonte de verdade
-- sobre a troca; devolução financeira real (rpc_return_sale) e cancelamento
-- (rpc_cancel_sale) continuam funcionando exatamente como antes.
--
-- "Faturamento" é reproduzido aqui pela MESMA regra de getTodayRevenue()
-- (src/lib/analytics/todayRevenue.ts): SUM(total) WHERE status NOT IN
-- ('cancelled','returned') — não existe outra fórmula, não inventamos uma
-- nova para o teste.
--
-- Cenários (pedido do usuário, 2026-09-15):
--   A. Venda R$29,99, troca total por R$29,99 — original não vira
--      returned, faturamento permanece R$29,99, sem duplicação.
--   B. Venda R$29,99, troca total por R$39,99 (diferença R$10) — original
--      permanece ativa, faturamento final R$39,99.
--   C. Venda R$100 (2 itens de R$30/R$70... aqui simplificado a 1 item de
--      R$30 + 1 item de R$70), troca PARCIAL do item de R$30 por um novo
--      de R$40 com diferença de R$10 — comportamento já correto hoje,
--      preservado: faturamento R$110.
--   D. Devolução real (rpc_return_sale) — continua marcando returned,
--      continua excluída do faturamento.
--   E. Cancelamento (rpc_cancel_sale) — continua cancelled, continua
--      excluído do faturamento.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_process_exchange_no_returned_status.test.sql
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
  VALUES ('TESTE Troca Total — APAGAR', 1, false, true)
  RETURNING id INTO v_customer_id;

  INSERT INTO public.categories (name, slug, company_id, active)
  VALUES ('TESTE Troca Total — APAGAR', 'teste-troca-total-apagar', 1, true)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-troca-total-apagar';

  CREATE TEMP TABLE exchange_test_fixture (main_store_id int, user_id uuid, customer_id int, category_id int);
  INSERT INTO exchange_test_fixture VALUES (v_main_store_id, v_test_user_id, v_customer_id, v_category_id);

  RAISE NOTICE 'Fixture: main_store=%, user=%, customer=%', v_main_store_id, v_test_user_id, v_customer_id;
END $$;


-- Helper: cria 1 produto/variação de teste com estoque e devolve o id da variação.
CREATE OR REPLACE FUNCTION pg_temp.make_test_variation(p_sku text, p_cost numeric, p_qty int) RETURNS int AS $$
DECLARE
  v_category_id int;
  v_main_store_id int;
  v_product_id int;
  v_variation_id int;
BEGIN
  SELECT category_id, main_store_id INTO v_category_id, v_main_store_id FROM exchange_test_fixture;

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
-- Cenário A — troca total por valor equivalente (R$29,99 → R$29,98,
-- crédito cobre 100%): original NÃO vira returned, faturamento permanece
-- R$29,99, sem duplicação (a venda-filha não soma R$29,98 a mais).
-- =============================================================================
SAVEPOINT cenario_a;

DO $$
DECLARE
  v_user uuid; v_customer int;
  v_var_original int; v_var_nova int;
  v_sale_result jsonb; v_sale_id int; v_exchange_result jsonb;
  v_new_sale_result jsonb; v_new_sale_id int;
  v_original record;
  v_faturamento numeric;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;

  v_var_original := pg_temp.make_test_variation('CEN-A-ORIG', 8, 10);
  v_var_nova      := pg_temp.make_test_variation('CEN-A-NOVA', 5, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario A — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_original, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  SELECT status, total, returned_at, returned_by INTO v_original FROM public.sales WHERE id = v_sale_id;
  IF v_original.total <> 29.99 THEN
    RAISE EXCEPTION 'FALHA Cenário A (pré-troca): total esperado 29.99, veio %.', v_original.total;
  END IF;

  v_exchange_result := public.rpc_process_exchange(
    p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object('sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id), 'quantity_returned', 1)),
    p_notes => 'teste cenario A — apagar', p_user_id => v_user
  );

  SELECT status, total, returned_at, returned_by INTO v_original FROM public.sales WHERE id = v_sale_id;
  IF v_original.status = 'returned' THEN
    RAISE EXCEPTION 'FALHA Cenário A: venda original virou returned — troca total NÃO deve mais fazer isso.';
  END IF;
  IF v_original.returned_at IS NOT NULL OR v_original.returned_by IS NOT NULL THEN
    RAISE EXCEPTION 'FALHA Cenário A: returned_at/returned_by preenchidos indevidamente.';
  END IF;
  IF v_original.total <> 29.99 THEN
    RAISE EXCEPTION 'FALHA Cenário A: total da venda original foi alterado (esperado 29.99, veio %).', v_original.total;
  END IF;

  v_new_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'pix',
    p_sale_origin => NULL, p_discount_amount => 0, p_cashback_used => (v_exchange_result->>'credit_amount')::numeric,
    p_shipping_charged => 0, p_notes => 'Troca — Venda #' || v_sale_id,
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_nova, 'quantity', 1, 'unit_price', 29.98, 'unit_cost', 5)),
    p_system_user_id => v_user
  );
  v_new_sale_id := (v_new_sale_result->>'id')::int;

  IF (v_new_sale_result->>'total')::numeric <> 0 THEN
    RAISE EXCEPTION 'FALHA Cenário A: total da venda-filha esperado 0 (crédito cobre 100%%), veio %.', v_new_sale_result->>'total';
  END IF;

  -- Faturamento = MESMA regra de getTodayRevenue: SUM(total) WHERE status NOT IN ('cancelled','returned')
  SELECT COALESCE(SUM(total), 0) INTO v_faturamento
  FROM public.sales WHERE id IN (v_sale_id, v_new_sale_id) AND status NOT IN ('cancelled', 'returned');

  IF v_faturamento <> 29.99 THEN
    RAISE EXCEPTION 'FALHA Cenário A: faturamento esperado 29.99 (sem perda, sem duplicação), veio %.', v_faturamento;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.exchanges WHERE original_sale_id = v_sale_id AND status = 'completed') THEN
    RAISE EXCEPTION 'FALHA Cenário A: exchanges não registrou a troca.';
  END IF;

  RAISE NOTICE 'OK — Cenário A (troca total valor equivalente: original ativa, faturamento=29.99, sem duplicação)';
END $$;

ROLLBACK TO SAVEPOINT cenario_a;


-- =============================================================================
-- Cenário B — troca total por produto mais caro (R$29,99 → R$39,99,
-- diferença R$10): original permanece ativa, faturamento final R$39,99
-- (29,99 preservados + 10,00 incrementais — nunca 29,99+10 tratado como
-- perda de 19,99 nem como 69,98 duplicado).
-- =============================================================================
SAVEPOINT cenario_b;

DO $$
DECLARE
  v_user uuid; v_customer int;
  v_var_original int; v_var_nova int;
  v_sale_result jsonb; v_sale_id int; v_exchange_result jsonb;
  v_new_sale_result jsonb; v_new_sale_id int;
  v_original record;
  v_faturamento numeric;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;

  v_var_original := pg_temp.make_test_variation('CEN-B-ORIG', 8, 10);
  v_var_nova      := pg_temp.make_test_variation('CEN-B-NOVA', 10, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario B — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_original, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  v_exchange_result := public.rpc_process_exchange(
    p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object('sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id), 'quantity_returned', 1)),
    p_notes => 'teste cenario B — apagar', p_user_id => v_user
  );

  SELECT status INTO v_original FROM public.sales WHERE id = v_sale_id;
  IF v_original.status = 'returned' THEN
    RAISE EXCEPTION 'FALHA Cenário B: venda original virou returned.';
  END IF;

  v_new_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => NULL, p_discount_amount => 0, p_cashback_used => (v_exchange_result->>'credit_amount')::numeric,
    p_shipping_charged => 0, p_notes => 'Troca — Venda #' || v_sale_id,
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_nova, 'quantity', 1, 'unit_price', 39.99, 'unit_cost', 10)),
    p_system_user_id => v_user
  );
  v_new_sale_id := (v_new_sale_result->>'id')::int;

  IF (v_new_sale_result->>'total')::numeric <> 10.00 THEN
    RAISE EXCEPTION 'FALHA Cenário B: total da venda-filha esperado 10.00 (diferença), veio %.', v_new_sale_result->>'total';
  END IF;

  -- finance_entries da venda-filha deve existir e ser SOMENTE a diferença (v_total > 0 → insere)
  IF NOT EXISTS (SELECT 1 FROM public.finance_entries WHERE sale_id = v_new_sale_id AND amount = 10.00) THEN
    RAISE EXCEPTION 'FALHA Cenário B: finance_entries da venda-filha deveria existir com amount=10.00 (só a diferença).';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_faturamento
  FROM public.sales WHERE id IN (v_sale_id, v_new_sale_id) AND status NOT IN ('cancelled', 'returned');

  IF v_faturamento <> 39.99 THEN
    RAISE EXCEPTION 'FALHA Cenário B: faturamento esperado 39.99 (29.99 original + 10.00 diferença), veio %.', v_faturamento;
  END IF;

  RAISE NOTICE 'OK — Cenário B (troca com diferença: original ativa, faturamento=39.99, finance_entries só da diferença)';
END $$;

ROLLBACK TO SAVEPOINT cenario_b;


-- =============================================================================
-- Cenário C — troca PARCIAL (venda R$100 = item R$30 + item R$70; devolve
-- só o de R$30, leva um novo de R$40, paga R$10 de diferença): já era
-- correto antes desta correção (não passa pela condição de troca total) —
-- confirma que continua correto (não regrediu).
-- =============================================================================
SAVEPOINT cenario_c;

DO $$
DECLARE
  v_user uuid; v_customer int;
  v_var_a int; v_var_b int; v_var_nova int;
  v_sale_result jsonb; v_sale_id int; v_exchange_result jsonb;
  v_new_sale_result jsonb; v_new_sale_id int;
  v_original record;
  v_faturamento numeric;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;

  v_var_a    := pg_temp.make_test_variation('CEN-C-A', 10, 10);
  v_var_b    := pg_temp.make_test_variation('CEN-C-B', 20, 10);
  v_var_nova := pg_temp.make_test_variation('CEN-C-NOVA', 12, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario C — apagar',
    p_items => jsonb_build_array(
      jsonb_build_object('product_variation_id', v_var_a, 'quantity', 1, 'unit_price', 30, 'unit_cost', 10),
      jsonb_build_object('product_variation_id', v_var_b, 'quantity', 1, 'unit_price', 70, 'unit_cost', 20)
    ),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  v_exchange_result := public.rpc_process_exchange(
    p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
    p_items => jsonb_build_array(jsonb_build_object(
      'sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id AND product_variation_id = v_var_a),
      'quantity_returned', 1
    )),
    p_notes => 'teste cenario C — apagar', p_user_id => v_user
  );

  SELECT status, total INTO v_original FROM public.sales WHERE id = v_sale_id;
  IF v_original.status = 'returned' THEN
    RAISE EXCEPTION 'FALHA Cenário C: troca PARCIAL não deveria nunca ter marcado returned (nem antes, nem depois desta correção).';
  END IF;
  IF v_original.total <> 100 THEN
    RAISE EXCEPTION 'FALHA Cenário C: total da venda original alterado (esperado 100), veio %.', v_original.total;
  END IF;

  v_new_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => NULL, p_discount_amount => 0, p_cashback_used => (v_exchange_result->>'credit_amount')::numeric,
    p_shipping_charged => 0, p_notes => 'Troca — Venda #' || v_sale_id,
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var_nova, 'quantity', 1, 'unit_price', 40, 'unit_cost', 12)),
    p_system_user_id => v_user
  );
  v_new_sale_id := (v_new_sale_result->>'id')::int;

  IF (v_new_sale_result->>'total')::numeric <> 10.00 THEN
    RAISE EXCEPTION 'FALHA Cenário C: total da venda-filha esperado 10.00, veio %.', v_new_sale_result->>'total';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_faturamento
  FROM public.sales WHERE id IN (v_sale_id, v_new_sale_id) AND status NOT IN ('cancelled', 'returned');

  IF v_faturamento <> 110 THEN
    RAISE EXCEPTION 'FALHA Cenário C: faturamento esperado 110 (100 original + 10 diferença), veio %.', v_faturamento;
  END IF;

  RAISE NOTICE 'OK — Cenário C (troca parcial: comportamento pré-existente preservado, faturamento=110)';
END $$;

ROLLBACK TO SAVEPOINT cenario_c;


-- =============================================================================
-- Cenário D — devolução financeira real (rpc_return_sale) continua
-- marcando returned e continua excluída do faturamento. Esta correção não
-- toca em rpc_return_sale — confirma não-regressão.
-- =============================================================================
SAVEPOINT cenario_d;

DO $$
DECLARE
  v_user uuid; v_customer int; v_var int;
  v_sale_result jsonb; v_sale_id int;
  v_sale record;
  v_faturamento numeric;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;
  v_var := pg_temp.make_test_variation('CEN-D', 8, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario D — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  PERFORM public.rpc_return_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);

  SELECT status, returned_at, returned_by INTO v_sale FROM public.sales WHERE id = v_sale_id;
  IF v_sale.status <> 'returned' THEN
    RAISE EXCEPTION 'FALHA Cenário D: devolução real deveria marcar status=returned, veio %.', v_sale.status;
  END IF;
  IF v_sale.returned_at IS NULL OR v_sale.returned_by IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário D: returned_at/returned_by deveriam estar preenchidos numa devolução real.';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_faturamento
  FROM public.sales WHERE id = v_sale_id AND status NOT IN ('cancelled', 'returned');

  IF v_faturamento <> 0 THEN
    RAISE EXCEPTION 'FALHA Cenário D: devolução real deveria continuar excluída do faturamento, veio %.', v_faturamento;
  END IF;

  RAISE NOTICE 'OK — Cenário D (devolução financeira real: rpc_return_sale não regrediu)';
END $$;

ROLLBACK TO SAVEPOINT cenario_d;


-- =============================================================================
-- Cenário E — cancelamento (rpc_cancel_sale) continua cancelled e
-- continua excluído do faturamento. Não tocamos em rpc_cancel_sale.
-- =============================================================================
SAVEPOINT cenario_e;

DO $$
DECLARE
  v_user uuid; v_customer int; v_var int;
  v_sale_result jsonb; v_sale_id int;
  v_sale record;
  v_faturamento numeric;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;
  v_var := pg_temp.make_test_variation('CEN-E', 8, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario E — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  PERFORM public.rpc_cancel_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);

  SELECT status, cancelled_at, cancelled_by INTO v_sale FROM public.sales WHERE id = v_sale_id;
  IF v_sale.status <> 'cancelled' THEN
    RAISE EXCEPTION 'FALHA Cenário E: cancelamento deveria marcar status=cancelled, veio %.', v_sale.status;
  END IF;
  IF v_sale.cancelled_at IS NULL OR v_sale.cancelled_by IS NULL THEN
    RAISE EXCEPTION 'FALHA Cenário E: cancelled_at/cancelled_by deveriam estar preenchidos.';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_faturamento
  FROM public.sales WHERE id = v_sale_id AND status NOT IN ('cancelled', 'returned');

  IF v_faturamento <> 0 THEN
    RAISE EXCEPTION 'FALHA Cenário E: cancelamento deveria continuar excluído do faturamento, veio %.', v_faturamento;
  END IF;

  RAISE NOTICE 'OK — Cenário E (cancelamento: rpc_cancel_sale não regrediu)';
END $$;

ROLLBACK TO SAVEPOINT cenario_e;


-- =============================================================================
-- Cenário extra — guard de venda já devolvida continua bloqueando nova
-- troca (rpc_process_exchange nunca deve permitir "trocar" uma venda já
-- returned via rpc_return_sale, mesmo depois desta correção).
-- =============================================================================
SAVEPOINT cenario_guard;

DO $$
DECLARE
  v_user uuid; v_customer int; v_var int;
  v_sale_result jsonb; v_sale_id int;
  v_raised boolean := false;
BEGIN
  SELECT user_id, customer_id INTO v_user, v_customer FROM exchange_test_fixture;
  v_var := pg_temp.make_test_variation('CEN-GUARD', 8, 10);

  v_sale_result := public.rpc_create_sale(
    p_customer_id => v_customer, p_seller_id => v_user, p_payment_method => 'cash',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0,
    p_shipping_charged => 0, p_notes => 'teste cenario guard — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_var, 'quantity', 1, 'unit_price', 29.99, 'unit_cost', 8)),
    p_system_user_id => v_user
  );
  v_sale_id := (v_sale_result->>'id')::int;

  PERFORM public.rpc_return_sale(p_sale_id => v_sale_id, p_system_user_id => v_user);

  BEGIN
    PERFORM public.rpc_process_exchange(
      p_company_id => 1, p_sale_id => v_sale_id, p_customer_id => v_customer,
      p_items => jsonb_build_array(jsonb_build_object('sale_item_id', (SELECT id FROM sale_items WHERE sale_id = v_sale_id), 'quantity_returned', 1)),
      p_notes => 'nao deveria funcionar', p_user_id => v_user
    );
  EXCEPTION WHEN OTHERS THEN
    v_raised := true;
  END;

  IF NOT v_raised THEN
    RAISE EXCEPTION 'FALHA Cenário guard: rpc_process_exchange deveria bloquear troca sobre venda já returned.';
  END IF;

  RAISE NOTICE 'OK — Cenário guard (venda já devolvida continua bloqueada para nova troca)';
END $$;

ROLLBACK TO SAVEPOINT cenario_guard;


DO $$
BEGIN
  RAISE NOTICE '=== TODOS OS CENÁRIOS PASSARAM (A, B, C, D, E, guard) ===';
END $$;

ROLLBACK;
-- =============================================================================
-- FIM — nada persistido (ROLLBACK final acima desfaz TUDO).
-- =============================================================================
