-- =============================================================================
-- 20260722_rpc_cancel_return_sale_no_finance_entry.sql
--
-- Financeiro 2.1 — Estabilidade de competência do DRE (2/3)
--
-- Reescreve rpc_cancel_sale e rpc_return_sale a partir de
-- 20260613_fix_cancel_return_sale.sql, com exatamente duas mudanças:
--
--   1. O UPDATE de sales passa a preencher cancelled_at/cancelled_by
--      (ou returned_at/returned_by) — essa é a nova fonte de competência
--      da reversão, consumida por vw_dre_mensal numa migration futura.
--
--   2. O bloco final que inserVIA finance_entries(category='other_expense')
--      foi removido. A partir de agora, cancelamento/devolução não geram
--      mais nenhuma finance_entries automaticamente — só uma devolução
--      financeira real (Financeiro 2.2, futura) deve criar uma.
--
-- Estoque (stock_balances/stock_movements) e cashback (earn reversal +
-- restituição) permanecem BYTE-A-BYTE idênticos ao original.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. rpc_cancel_sale
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_cancel_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale            record;
  v_item            record;
  v_main_store_id   int;
  v_prev_qty        numeric := 0;
  v_brazil_date     date;
BEGIN
  -- Permite escrita em stock_balances (bypass do trigger de proteção)
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  -- ─── Lock + leitura da venda ───────────────────────────────────────────────
  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida e não pode ser cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ─── Cancelar venda ────────────────────────────────────────────────────────
  UPDATE sales
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_system_user_id, updated_at = NOW()
  WHERE id = p_sale_id;

  -- ─── Identificar local de estoque principal ────────────────────────────────
  v_main_store_id := public.fn_main_store_id(v_sale.company_id);

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Empresa % sem local de estoque principal configurado.', v_sale.company_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ─── Restaurar estoque em stock_balances ───────────────────────────────────
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    -- Upsert: cria linha se não existir (produto nunca teve estoque nesta loja)
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_item.product_variation_id, v_main_store_id, v_item.quantity, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_item.quantity,
          last_updated = NOW();

    -- Ledger de movimentação
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text,
      v_sale.company_id, v_main_store_id, 'cancel', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  -- ─── Cashback: cancelar earn gerado por esta venda ─────────────────────────
  -- Transações pending/available viram 'reversed' → saem do saldo do cliente
  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Cancelamento da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

  -- ─── Cashback: restituir valor usado pelo cliente nesta venda ──────────────
  -- Se o cliente pagou parte com cashback, devolvemos o valor como crédito imediato
  IF COALESCE(v_sale.cashback_used, 0) > 0 AND v_sale.customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      release_date, expiry_date, reverse_reason
    )
    VALUES (
      v_sale.customer_id, v_sale.company_id, p_sale_id,
      'earn', v_sale.cashback_used, 'available',
      v_brazil_date, NULL,
      'Restituição de cashback — cancelamento da venda ' || v_sale.sale_number
    );
  END IF;

  -- Financeiro 2.1: nenhuma finance_entries é criada aqui. A competência do
  -- cancelamento passa a ser sales.status/cancelled_at/cancelled_by, consumida
  -- por vw_dre_mensal. Uma devolução financeira real é escopo da Financeiro 2.2.
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale(int, uuid) TO service_role, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. rpc_return_sale
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_return_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale            record;
  v_item            record;
  v_main_store_id   int;
  v_prev_qty        numeric := 0;
  v_brazil_date     date;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% está cancelada e não pode ser devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status = 'returned', returned_at = NOW(), returned_by = p_system_user_id, updated_at = NOW()
  WHERE id = p_sale_id;

  v_main_store_id := public.fn_main_store_id(v_sale.company_id);

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Empresa % sem local de estoque principal configurado.', v_sale.company_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_item.product_variation_id, v_main_store_id, v_item.quantity, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text,
      v_sale.company_id, v_main_store_id, 'return', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  -- Cashback earn gerado pela venda → reverter
  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Devolução da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

  -- Cashback que o cliente usou → restituir como crédito imediato
  IF COALESCE(v_sale.cashback_used, 0) > 0 AND v_sale.customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      release_date, expiry_date, reverse_reason
    )
    VALUES (
      v_sale.customer_id, v_sale.company_id, p_sale_id,
      'earn', v_sale.cashback_used, 'available',
      v_brazil_date, NULL,
      'Restituição de cashback — devolução da venda ' || v_sale.sale_number
    );
  END IF;

  -- Financeiro 2.1: nenhuma finance_entries é criada aqui. A competência da
  -- devolução passa a ser sales.status/returned_at/returned_by, consumida
  -- por vw_dre_mensal. Uma devolução financeira real é escopo da Financeiro 2.2.
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_return_sale(int, uuid) TO service_role, authenticated;


-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplique o CREATE OR REPLACE FUNCTION de
-- supabase/migrations/20260613_fix_cancel_return_sale.sql para as duas
-- funções. Não há rollback de dados: vendas canceladas/devolvidas enquanto
-- esta versão esteve ativa simplesmente não geraram finance_entries — esse
-- é o comportamento pretendido da nova arquitetura, não uma perda de dado.
*/
