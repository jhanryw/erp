-- =============================================================================
-- 20260915b_guard_cancel_return_against_exchanged_sales.sql
--
-- Prioridade 1 da auditoria pré-deploy (2026-09-15) da correção de troca
-- total: com 20260915_fix_rpc_process_exchange_no_returned_status.sql,
-- uma venda com troca (parcial OU total) deixa de ficar protegida por
-- `status='returned'` contra um cancelamento/devolução posterior — antes,
-- esse status (mesmo indevido) bloqueava `rpc_cancel_sale`/
-- `rpc_return_sale` via seus próprios guards de status terminal.
--
-- RISCO CONCRETO sem esta correção: `rpc_return_sale`/`rpc_cancel_sale`
-- operam na VENDA INTEIRA — para CADA `sale_items`, restauram a
-- quantidade ORIGINAL vendida ao estoque, sem saber que parte (ou tudo)
-- dessa quantidade JÁ voltou ao estoque via `rpc_process_exchange`.
-- Chamar devolução/cancelamento numa venda já trocada duplicaria a
-- restauração de estoque (estoque fica MAIOR do que deveria) e geraria
-- reversão de cashback/outbox sobre uma venda cuja história real já
-- divergiu para uma venda-filha separada.
--
-- POR QUE BLOQUEAR TAMBÉM TROCA PARCIAL (não só total): uma devolução
-- financeira real ou um cancelamento pressupõem desfazer a venda INTEIRA
-- como se nada tivesse saído da loja. Isso deixa de ser verdade no
-- instante em que QUALQUER item já foi trocado — parte do valor virou
-- crédito de troca, possivelmente já gasto numa venda-filha com sua
-- própria existência financeira/fiscal separada. Tratar corretamente uma
-- devolução/cancelamento PARCIAL, coexistindo com uma troca já
-- processada, exigiria redesenhar rpc_return_sale/rpc_cancel_sale pra
-- operar por item e reconciliar cashback/finance/fiscal entre a venda
-- original e a(s) venda(s)-filha — exatamente o tipo de funcionalidade
-- grande que NÃO deve ser inventada agora (mesma decisão já tomada pra
-- devolução financeira parcial, fora de escopo). A proteção mais
-- conservadora contra corrupção de dado é bloquear inteiramente quando
-- QUALQUER exchange completed existir — o que, na prática, NÃO regride
-- nenhum fluxo hoje funcional: a UI (`vendas/[id]/page.tsx`) já esconde o
-- botão "Devolver" com `!sale.hasExchanges`, independente de status —
-- esta migration só torna essa mesma regra válida também na API/RPC
-- (camada mais forte), fechando o caminho de quem chamar a rota direto.
--
-- Cancelamento (`rpc_cancel_sale`) recebe a MESMA proteção — cancelar
-- pressupõe que a venda nunca "aconteceu de verdade", incompatível com
-- qualquer troca já registrada sobre ela.
--
-- MUDANÇA, EXCLUSIVAMENTE: um novo guard em cada RPC, logo depois dos
-- guards de status existentes, ANTES de qualquer efeito colateral
-- (estoque/cashback/outbox). Nenhuma outra linha alterada.
--
-- Assinaturas INALTERADAS — CREATE OR REPLACE seguro.
-- =============================================================================

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
  v_caller_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used, sale_type, sales_channel
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida e não pode ser cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Prioridade 1 (2026-09-15) — venda com QUALQUER troca (parcial ou
  -- total) registrada não pode ser cancelada: parte (ou tudo) dela já
  -- não está mais com o cliente pelo caminho original, e cancelar
  -- restauraria estoque/reverteria efeitos que a troca já processou
  -- separadamente.
  IF EXISTS (
    SELECT 1 FROM exchanges WHERE original_sale_id = p_sale_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Venda #% (%) já teve item(ns) trocado(s) — não pode ser cancelada. A troca já é a operação registrada para essa mercadoria (ver exchanges).',
      p_sale_id, v_sale.sale_number USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_system_user_id, updated_at = NOW()
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
      v_sale.company_id, v_main_store_id, 'cancel', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Cancelamento da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

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

  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_sale.company_id,
    'sale:' || p_sale_id || ':cancelled',
    'sale.cancelled',
    'sale',
    p_sale_id::text,
    jsonb_build_object(
      'sale_id',       p_sale_id,
      'sale_number',   v_sale.sale_number,
      'customer_id',   v_sale.customer_id,
      'total',         v_sale.total,
      'cancelled_by',  p_system_user_id,
      'sale_type',     v_sale.sale_type,
      'sales_channel', v_sale.sales_channel
    )
  );
END;
$$;

-- Nenhum GRANT aqui — assinatura inalterada, permissões existentes preservadas por CREATE OR REPLACE.


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
  v_caller_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used, sale_type, sales_channel
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% está cancelada e não pode ser devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Prioridade 1 (2026-09-15) — mesma proteção de rpc_cancel_sale: venda
  -- com QUALQUER troca (parcial ou total) já registrada não pode ser
  -- devolvida financeiramente. Devolução financeira parcial coexistindo
  -- com troca já processada exigiria reconciliar cashback/estoque/
  -- finance/fiscal entre a venda original e a(s) venda(s)-filha — fora de
  -- escopo (mesma decisão já tomada para "devolução financeira parcial").
  -- A UI já bloqueia isso via `!sale.hasExchanges`, independente de
  -- status — este guard só torna a mesma regra válida na API/RPC.
  IF EXISTS (
    SELECT 1 FROM exchanges WHERE original_sale_id = p_sale_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Venda #% (%) já teve item(ns) trocado(s) — não pode ser devolvida. A troca já é a operação registrada para essa mercadoria (ver exchanges).',
      p_sale_id, v_sale.sale_number USING ERRCODE = 'P0001';
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

  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Devolução da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

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

  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_sale.company_id,
    'sale:' || p_sale_id || ':refunded',
    'sale.refunded',
    'sale',
    p_sale_id::text,
    jsonb_build_object(
      'sale_id',      p_sale_id,
      'sale_number',  v_sale.sale_number,
      'customer_id',  v_sale.customer_id,
      'total',        v_sale.total,
      'returned_by',  p_system_user_id,
      'source',       'rpc_return_sale',
      'sale_type',     v_sale.sale_type,
      'sales_channel', v_sale.sales_channel
    )
  );
END;
$$;

-- Nenhum GRANT aqui — assinatura inalterada, permissões existentes preservadas por CREATE OR REPLACE.
