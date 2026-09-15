-- =============================================================================
-- 20260915_fix_rpc_process_exchange_no_returned_status.sql
--
-- Correção de modelagem conceitual (auditoria 2026-09-14/15, ticket
-- "troca total virando Devolvido indevidamente no faturamento"):
--
-- PROBLEMA: rpc_process_exchange, quando a quantidade trocada cobre 100%
-- da quantidade original da venda ("troca total"), marcava a venda
-- ORIGINAL como status='returned' — o MESMO sinal usado por
-- rpc_return_sale para uma devolução financeira real (dinheiro
-- devolvido). Consequência: getTodayRevenue/vw_dre_mensal/dashboard etc.
-- excluíam a receita da venda original mesmo quando NENHUM dinheiro saiu
-- do caixa (o valor virou crédito de troca, imediatamente consumido por
-- uma venda-filha).
--
-- REGRA DEFINITIVA (decisão de negócio, auditoria conceitual completa):
-- troca — parcial OU total — NUNCA altera sales.status da venda
-- original. A existência e os detalhes da troca ficam inteiramente
-- representados por exchanges/exchange_items, que já existiam e já
-- eram a fonte de verdade para tudo (estoque, crédito, elegibilidade de
-- novo troca). Devolução financeira real continua sendo
-- EXCLUSIVAMENTE responsabilidade de rpc_return_sale; cancelamento,
-- de rpc_cancel_sale. Esta migration não toca em nenhuma das duas.
--
-- MUDANÇA, EXCLUSIVAMENTE:
--   - Remove o bloco `IF v_total_exch_qty >= v_total_orig_qty THEN
--     UPDATE sales SET status='returned', returned_at=..., returned_by=...`
--     e o evento de outbox 'sale.refunded' que o acompanhava (o evento
--     descrevia exatamente essa transição de status que deixou de
--     existir — mantê-lo emitiria um evento "sale.refunded" falso para
--     consumidores como o fan-out Chatwoot, que tratariam uma troca como
--     se fosse uma devolução financeira real).
--   - Remove as variáveis v_total_orig_qty/v_total_exch_qty (só existiam
--     para essa condição, ficam mortas sem ela).
--
-- NADA MAIS muda: exchanges, exchange_items, restauração de estoque,
-- geração do crédito de troca (cashback_transactions type='earn',
-- exchange_id preenchido), guards de venda cancelada/devolvida/itens
-- indisponíveis — tudo idêntico à versão vigente
-- (202608311202_sale_lifecycle_outbox_sale_type.sql).
--
-- Assinatura INALTERADA — CREATE OR REPLACE é seguro, sem risco de
-- overload novo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_process_exchange(
  p_company_id  int,
  p_sale_id     int,
  p_customer_id int,
  p_items       jsonb,
  p_notes       text,
  p_user_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale           record;
  v_sale_item      record;
  v_el             jsonb;
  v_qty_ret        int;
  v_already_ret    int;
  v_prev_qty       int;
  v_total_credit   numeric(10,2) := 0;
  v_exchange_id    int;
  v_main_store_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, company_id, customer_id, status, sale_number, sale_type, sales_channel
  INTO v_sale
  FROM sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'Cliente não corresponde à venda.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda cancelada não pode ser trocada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda já foi devolvida e não pode ser trocada novamente.' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um item para trocar.' USING ERRCODE = 'P0001';
  END IF;

  v_main_store_id := public.fn_main_store_id(p_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      p_company_id USING ERRCODE = 'P0001';
  END IF;

  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.sale_id, si.quantity, si.unit_price,
           si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int
      AND si.sale_id = p_sale_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % não pertence à venda.', (v_el->>'sale_item_id')
        USING ERRCODE = 'P0001';
    END IF;
    IF v_qty_ret <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(ei.quantity_returned), 0)
    INTO v_already_ret
    FROM exchange_items ei
    JOIN exchanges ex ON ex.id = ei.exchange_id
    WHERE ei.sale_item_id = v_sale_item.id
      AND ex.status = 'completed';

    IF v_qty_ret > (v_sale_item.quantity - v_already_ret) THEN
      RAISE EXCEPTION
        'Quantidade (%) excede o disponível para troca (%) no item %.',
        v_qty_ret, (v_sale_item.quantity - v_already_ret), v_sale_item.id
        USING ERRCODE = 'P0001';
    END IF;

    v_total_credit := v_total_credit + (v_qty_ret * v_sale_item.unit_price);
  END LOOP;

  INSERT INTO exchanges (
    company_id, original_sale_id, customer_id,
    returned_amount, credit_issued, notes, created_by
  )
  VALUES (
    p_company_id, p_sale_id, p_customer_id,
    v_total_credit, v_total_credit, p_notes, p_user_id
  )
  RETURNING id INTO v_exchange_id;

  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.quantity, si.unit_price, si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int;

    INSERT INTO exchange_items (
      exchange_id, sale_item_id, product_variation_id,
      quantity_returned, unit_price, total_returned
    )
    VALUES (
      v_exchange_id, v_sale_item.id, v_sale_item.product_variation_id,
      v_qty_ret, v_sale_item.unit_price, v_qty_ret * v_sale_item.unit_price
    );

    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_sale_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_sale_item.product_variation_id, v_main_store_id, v_qty_ret, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_qty_ret,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_sale_item.product_variation_id, pv.product_id,
      'return', v_qty_ret,
      v_prev_qty, v_prev_qty + v_qty_ret,
      v_sale_item.unit_cost, p_sale_id::text,
      p_company_id, v_main_store_id, 'exchange', 'sale', p_user_id
    FROM product_variations pv
    WHERE pv.id = v_sale_item.product_variation_id;
  END LOOP;

  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id,
    type, amount, status, release_date, exchange_id
  )
  VALUES (
    p_customer_id, p_company_id, p_sale_id,
    'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id
  );

  -- Fim — troca (parcial ou total) NUNCA altera sales.status/returned_at/
  -- returned_by da venda original. A venda continua com seu status
  -- comercial anterior; exchanges/exchange_items (já gravados acima) são
  -- a única fonte de verdade sobre a troca ter acontecido. Devolução
  -- financeira real permanece exclusiva de rpc_return_sale.

  RETURN jsonb_build_object(
    'exchange_id',   v_exchange_id,
    'credit_amount', v_total_credit
  );
END;
$$;

-- Nenhum GRANT aqui — assinatura inalterada, permissões existentes preservadas por CREATE OR REPLACE.
