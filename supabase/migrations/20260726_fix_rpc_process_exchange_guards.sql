-- =============================================================================
-- 20260726_fix_rpc_process_exchange_guards.sql
--
-- PROBLEMA 1: rpc_process_exchange bloqueava troca sobre venda `cancelled`, mas
--   não sobre venda `returned` — diferente de rpc_cancel_sale/rpc_return_sale,
--   que bloqueiam os dois status terminais. Uma venda já devolvida via
--   rpc_return_sale (sem passar por exchange_items) podia ser "trocada" de
--   novo: a validação de disponibilidade em rpc_process_exchange só olha
--   exchange_items, não sales.status, então o mecanismo aceitaria a operação
--   e restauraria o mesmo estoque uma segunda vez, além de emitir crédito
--   duplicado ao cliente.
--
-- PROBLEMA 2: quando uma troca devolve 100% dos itens da venda original,
--   rpc_process_exchange marca sales.status = 'returned' mas nunca preenche
--   returned_at/returned_by — colunas introduzidas em
--   20260721_sales_reversal_audit_columns.sql e passadas a ser preenchidas
--   por rpc_cancel_sale/rpc_return_sale desde
--   20260722_rpc_cancel_return_sale_no_finance_entry.sql. Essa lacuna nunca
--   foi estendida para rpc_process_exchange. Consequência: vw_dre_mensal
--   (20260724_vw_dre_mensal_v3_revenue_reversal.sql) só reverte receita de
--   vendas 'returned' com returned_at IS NOT NULL — uma venda 100% trocada
--   nunca tem sua receita revertida no DRE.
--
-- CORREÇÃO — exatamente duas mudanças em relação a
--   20260626_fix_exchange_stock_balances.sql:
--
--   1. Novo guard `IF v_sale.status = 'returned' THEN RAISE EXCEPTION`,
--      mesma semântica de proteção de rpc_cancel_sale/rpc_return_sale
--      (bloqueia os dois status terminais, não só 'cancelled').
--
--   2. O UPDATE final que marca a venda como 'returned' passa a preencher
--      returned_at = NOW() e returned_by = p_user_id — mesmo padrão de
--      rpc_return_sale. p_user_id já é parâmetro existente da função (é o
--      mesmo valor gravado em exchanges.created_by mais acima) — não é um
--      valor novo nem inventado.
--
-- NÃO ALTERA: validação de itens/quantidades, geração de crédito
--   (cashback_transactions), lógica de restauração de estoque em
--   stock_balances, parâmetros, permissões, RLS.
--
-- Trocas parciais (v_total_exch_qty < v_total_orig_qty) continuam
-- funcionando exatamente como antes — o bloco de returned_at só é atingido
-- quando a troca completa os itens da venda.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_process_exchange(
  p_company_id  int,
  p_sale_id     int,
  p_customer_id int,
  p_items       jsonb,  -- [{sale_item_id, quantity_returned}]
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
  v_total_orig_qty int;
  v_total_exch_qty int;
  v_main_store_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Travar e validar a venda
  SELECT id, company_id, customer_id, status
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

  -- Resolver Estoque Loja da empresa (fonte de verdade pós-20260610)
  v_main_store_id := public.fn_main_store_id(p_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      p_company_id USING ERRCODE = 'P0001';
  END IF;

  -- Validar itens e somar crédito
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

  -- Criar registro da troca
  INSERT INTO exchanges (
    company_id, original_sale_id, customer_id,
    returned_amount, credit_issued, notes, created_by
  )
  VALUES (
    p_company_id, p_sale_id, p_customer_id,
    v_total_credit, v_total_credit, p_notes, p_user_id
  )
  RETURNING id INTO v_exchange_id;

  -- Criar itens, restaurar estoque em stock_balances (Estoque Loja) e ledger
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

    -- Ler saldo atual no Estoque Loja com lock anti-concorrência
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_sale_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    -- Upsert: cria linha se nunca houve estoque neste local
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_sale_item.product_variation_id, v_main_store_id, v_qty_ret, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_qty_ret,
          last_updated = NOW();

    -- Ledger de movimentação (padrão do rpc_return_sale)
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

  -- Gerar crédito imediato (entra direto no available_balance da view)
  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id,
    type, amount, status, release_date, exchange_id
  )
  VALUES (
    p_customer_id, p_company_id, p_sale_id,
    'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id
  );

  -- Marcar venda como devolvida se todos os itens foram trocados
  SELECT SUM(quantity) INTO v_total_orig_qty
  FROM sale_items
  WHERE sale_id = p_sale_id;

  SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_total_exch_qty
  FROM exchange_items ei
  JOIN exchanges ex ON ex.id = ei.exchange_id
  WHERE ex.original_sale_id = p_sale_id
    AND ex.status = 'completed';

  IF v_total_exch_qty >= v_total_orig_qty THEN
    UPDATE sales
    SET status = 'returned', returned_at = NOW(), returned_by = p_user_id, updated_at = NOW()
    WHERE id = p_sale_id;
  END IF;

  RETURN jsonb_build_object(
    'exchange_id',   v_exchange_id,
    'credit_amount', v_total_credit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_process_exchange(int, int, int, jsonb, text, uuid) TO service_role, authenticated;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplique o CREATE OR REPLACE FUNCTION de
-- supabase/migrations/20260626_fix_exchange_stock_balances.sql.
-- Não há rollback de dados: esta migration não altera nenhuma linha
-- existente, só o comportamento futuro da função.
*/
