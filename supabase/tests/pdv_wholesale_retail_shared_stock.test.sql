-- =============================================================================
-- pdv_wholesale_retail_shared_stock.test.sql
--
-- PDV atacado/varejo (2026-09-02) — prova literal do cenário pedido:
--   10 unidades disponíveis
--   Venda atacado 3   → saldo final 7
--   Venda varejo  2   → saldo final 5
-- Sem estoque separado por modalidade — mesmo stock_balances, mesma
-- rpc_create_sale, único mecanismo de baixa (não alterado nesta fase).
--
-- Nota: o bloqueio de "produto sem preço de atacado" (requisito 6 do
-- pedido) acontece na camada de aplicação (buildProductSearchItem/
-- resolveSalePrice, GET /api/produtos/buscar), NUNCA em rpc_create_sale —
-- a RPC sempre confiou no unit_price enviado pelo caller, pra varejo e
-- atacado igualmente (achado da auditoria original, não alterado aqui).
-- Coberto por src/app/api/produtos/buscar/buildProductSearchItem.test.ts.
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/pdv_wholesale_retail_shared_stock.test.sql
-- =============================================================================

BEGIN;

INSERT INTO public.categories (name, slug, company_id, active)
VALUES ('TESTE PDV Estoque Compartilhado — APAGAR', 'teste-pdv-estoque-compartilhado-apagar', 1, true)
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_category_id   INT;
  v_test_user_id  UUID;
  v_main_store_id INT;
  v_product_id    INT;
  v_variation_id  INT;
  v_sale_result   JSONB;
  v_stock_qty     INT;
BEGIN
  v_main_store_id := public.fn_main_store_id(1);
  IF v_main_store_id IS NULL THEN
    RAISE NOTICE 'PULADO: empresa 1 sem Estoque Loja configurado.';
    RETURN;
  END IF;

  SELECT id INTO v_test_user_id FROM public.users WHERE company_id = 1 AND active = true LIMIT 1;
  IF v_test_user_id IS NULL THEN
    RAISE NOTICE 'PULADO: nenhum usuário ativo na empresa 1.';
    RETURN;
  END IF;

  SELECT id INTO v_category_id FROM public.categories WHERE slug = 'teste-pdv-estoque-compartilhado-apagar';

  -- Produto A: tem preço de atacado cadastrado — usado no cenário principal.
  INSERT INTO public.products (name, sku, category_id, company_id, tipo, modelo, ano, base_cost, base_price, wholesale_price, active)
  VALUES ('Produto Teste Estoque Compartilhado', 'TESTE-PDV-ESTOQUE-A', v_category_id, 1, 'x', 'y', '2026', 10, 69.90, 49.90, true)
  RETURNING id INTO v_product_id;

  INSERT INTO public.product_variations (product_id, sku_variation, active)
  VALUES (v_product_id, 'TESTE-PDV-ESTOQUE-A-V1', true)
  RETURNING id INTO v_variation_id;

  INSERT INTO public.stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
  VALUES (v_variation_id, v_main_store_id, 10, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE SET quantity = 10;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Estoque inicial: 10 unidades (produto A)
  -- ═══════════════════════════════════════════════════════════════════════
  SELECT quantity INTO v_stock_qty FROM public.stock_balances
  WHERE product_variation_id = v_variation_id AND stock_location_id = v_main_store_id;
  IF v_stock_qty <> 10 THEN
    RAISE EXCEPTION 'FALHA (setup): esperado estoque inicial=10, veio %.', v_stock_qty;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- Venda ATACADO de 3 unidades → saldo final 7
  -- ═══════════════════════════════════════════════════════════════════════
  v_sale_result := public.rpc_create_sale(
    p_customer_id => NULL, p_seller_id => v_test_user_id, p_payment_method => 'pix',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
    p_notes => 'teste PDV — venda atacado 3un, estoque compartilhado — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 3, 'unit_price', 49.90, 'unit_cost', 10, 'discount_amount', 0)),
    p_system_user_id => v_test_user_id,
    p_sale_type => 'wholesale', p_sales_channel => 'pos'
  );
  IF (v_sale_result->>'id') IS NULL THEN
    RAISE EXCEPTION 'FALHA: venda atacado não foi criada.';
  END IF;

  SELECT quantity INTO v_stock_qty FROM public.stock_balances
  WHERE product_variation_id = v_variation_id AND stock_location_id = v_main_store_id;
  IF v_stock_qty <> 7 THEN
    RAISE EXCEPTION 'FALHA: após venda atacado de 3un, esperado saldo=7, veio %.', v_stock_qty;
  END IF;
  RAISE NOTICE 'OK: venda atacado (3un) debitou do MESMO pool de estoque — saldo 10 → 7.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Venda VAREJO de 2 unidades (MESMO produto/variação) → saldo final 5
  -- ═══════════════════════════════════════════════════════════════════════
  v_sale_result := public.rpc_create_sale(
    p_customer_id => NULL, p_seller_id => v_test_user_id, p_payment_method => 'pix',
    p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
    p_notes => 'teste PDV — venda varejo 2un, estoque compartilhado — apagar',
    p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 2, 'unit_price', 69.90, 'unit_cost', 10, 'discount_amount', 0)),
    p_system_user_id => v_test_user_id,
    p_sale_type => 'retail', p_sales_channel => 'pos'
  );
  IF (v_sale_result->>'id') IS NULL THEN
    RAISE EXCEPTION 'FALHA: venda varejo não foi criada.';
  END IF;

  SELECT quantity INTO v_stock_qty FROM public.stock_balances
  WHERE product_variation_id = v_variation_id AND stock_location_id = v_main_store_id;
  IF v_stock_qty <> 5 THEN
    RAISE EXCEPTION 'FALHA: após venda varejo de 2un (mesmo produto), esperado saldo=5, veio %.', v_stock_qty;
  END IF;
  RAISE NOTICE 'OK: venda varejo (2un) debitou do MESMO pool de estoque que a venda atacado — saldo 7 → 5. Nenhum estoque separado por modalidade.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Nenhuma coluna/estrutura de "estoque por modalidade" foi criada — prova
  -- estrutural: stock_balances não tem NENHUMA coluna sale_type/wholesale.
  -- ═══════════════════════════════════════════════════════════════════════
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stock_balances'
      AND (column_name ILIKE '%sale_type%' OR column_name ILIKE '%wholesale%')
  ) THEN
    RAISE EXCEPTION 'FALHA: stock_balances não deveria ter nenhuma coluna relacionada a modalidade/atacado.';
  END IF;
  RAISE NOTICE 'OK: stock_balances confirmadamente sem nenhuma coluna de modalidade — pool único, como exigido.';

  -- ═══════════════════════════════════════════════════════════════════════
  -- Regressão — cliente SEM CPF (fundação Fase 1) não quebra venda de
  -- atacado no PDV. customers.cpf já é nullable desde 20260521; aqui
  -- confirmamos que uma venda wholesale completa normalmente pra um
  -- cliente cadastrado sem CPF.
  -- ═══════════════════════════════════════════════════════════════════════
  DECLARE
    v_customer_no_cpf_id INT;
  BEGIN
    INSERT INTO public.customers (cpf, name, phone, company_id)
    VALUES (NULL, 'Cliente Teste Sem CPF — Atacado', '84999998888', 1)
    RETURNING id INTO v_customer_no_cpf_id;

    v_sale_result := public.rpc_create_sale(
      p_customer_id => v_customer_no_cpf_id, p_seller_id => v_test_user_id, p_payment_method => 'pix',
      p_sale_origin => 'store', p_discount_amount => 0, p_cashback_used => 0, p_shipping_charged => 0,
      p_notes => 'teste PDV — cliente sem CPF, venda atacado — apagar',
      p_items => jsonb_build_array(jsonb_build_object('product_variation_id', v_variation_id, 'quantity', 1, 'unit_price', 49.90, 'unit_cost', 10, 'discount_amount', 0)),
      p_system_user_id => v_test_user_id,
      p_sale_type => 'wholesale', p_sales_channel => 'pos'
    );
    IF (v_sale_result->>'id') IS NULL THEN
      RAISE EXCEPTION 'FALHA: venda atacado pra cliente sem CPF deveria ter sido criada normalmente.';
    END IF;
    RAISE NOTICE 'OK: cliente sem CPF completa venda de atacado no PDV normalmente (fundação Fase 1 intacta).';
  END;

  RAISE NOTICE 'pdv_wholesale_retail_shared_stock.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
