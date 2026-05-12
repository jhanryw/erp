-- =============================================================================
-- 007_rpc_concurrency_hardening.sql — Hardening contra race conditions nas RPCs
-- Santtorini ERP
--
-- Problemas corrigidos:
--   A. rpc_create_sale: deadlock quando duas vendas simultâneas compartilham
--      product_variation_ids na ordem inversa (lock adquirido na ordem do JSON
--      do cliente → ciclo de espera detectado pelo Postgres como deadlock 40P01).
--      Fix: pré-lock de TODAS as linhas de stock em ordem crescente de pvid
--      antes de qualquer processamento.
--
--   B. rpc_cancel_sale: sem ORDER BY no loop de sale_items → ordem de lock
--      de stock não determinística → deadlock com cancelamentos/vendas simultâneos.
--      Fix: ORDER BY product_variation_id no cursor.
--
--   C. rpc_return_sale: mesmo problema que B.
--      Fix: ORDER BY product_variation_id no cursor.
--
--   D. rpc_stock_initialize: INSERT de stock_movements ocorria mesmo quando
--      ON CONFLICT DO NOTHING descartava o INSERT em stock (chamadas duplicadas
--      geravam movimento fantasma com previous_stock=0, corrompendo o histórico).
--      Fix: inserir stock_movements somente se FOUND = true após o INSERT.
--
-- NÃO alterado: rpc_stock_entry (lê qty/avg_cost sob FOR UPDATE — correto),
--               rpc_stock_adjust (FOR UPDATE antes de toda leitura — correto).
--
-- EXECUTAR APÓS 001–006.
-- Idempotente: usa CREATE OR REPLACE para todas as funções.
-- =============================================================================

-- =============================================================================
-- A. rpc_create_sale — pré-lock ordenado de stock
-- =============================================================================
--
-- Estratégia:
--   1. Validação de empresa + cálculo de subtotal (sem locks) — igual a 006.
--   2. PRE-LOCK: SELECT DISTINCT pvids dos itens, ordenados por pvid ASC,
--      PERFORM 1 FROM stock FOR UPDATE para cada um. Garante que toda tx
--      que chame esta função adquire locks na mesma ordem global.
--   3. INSERT em sales.
--   4. Loop principal: INSERT sale_items, leitura de qty (lock já mantido,
--      sem FOR UPDATE repetido), UPDATE stock, INSERT stock_movements.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id      int,
  p_seller_id        uuid,
  p_payment_method   text,
  p_sale_origin      text,
  p_discount_amount  numeric,
  p_cashback_used    numeric,
  p_shipping_charged numeric,
  p_notes            text,
  p_items            jsonb,
  p_system_user_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id       int;
  v_sale_number   text;
  v_subtotal      numeric := 0;
  v_total         numeric;
  v_item          jsonb;
  v_pvid          int;
  v_qty           int;
  v_unit_price    numeric;
  v_unit_cost     numeric;
  v_discount      numeric;
  v_current_qty   int;
  v_item_total    numeric;
  v_company_id    int;
  v_item_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do vendedor
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor não está associado a uma empresa.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Validar empresa + calcular subtotal
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid := (v_item->>'product_variation_id')::int;

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS NULL THEN
      RAISE EXCEPTION 'Variação #% não encontrada.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;

    IF v_item_company != v_company_id THEN
      RAISE EXCEPTION 'Variação #% não pertence à empresa do vendedor.', v_pvid
        USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_total := GREATEST(0,
    v_subtotal - p_discount_amount - p_cashback_used + p_shipping_charged
  );

  -- PRE-LOCK: adquirir FOR UPDATE em todos os rows de stock em ordem crescente
  -- de product_variation_id antes de qualquer escrita.
  -- Isso garante que todas as transações concorrentes adquirem locks na mesma
  -- ordem global → elimina ciclos de espera → zero deadlocks por lock ordering.
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items)
    ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  -- Criar venda
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, p_cashback_used, p_shipping_charged,
    ROUND(v_total, 2), p_payment_method, p_sale_origin, p_notes,
    CURRENT_DATE, v_company_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Processar itens (lock já mantido — sem FOR UPDATE aqui)
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid       := (v_item->>'product_variation_id')::int;
    v_qty        := (v_item->>'quantity')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_unit_cost  := (v_item->>'unit_cost')::numeric;
    v_discount   := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_total := ROUND(v_unit_price * v_qty - v_discount, 2);

    INSERT INTO sale_items (
      sale_id, product_variation_id, quantity,
      unit_price, unit_cost, discount_amount, total_price
    )
    VALUES (v_sale_id, v_pvid, v_qty, v_unit_price, v_unit_cost, v_discount, v_item_total);

    -- Lock já mantido pelo pré-lock acima; leitura simples
    SELECT quantity INTO v_current_qty
    FROM stock
    WHERE product_variation_id = v_pvid;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Disponível: %, solicitado: %.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, p_system_user_id, v_company_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    ROUND(v_total, 2), CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- B. rpc_cancel_sale — ORDER BY no cursor de sale_items
-- =============================================================================
--
-- Sem ORDER BY, o PostgreSQL pode retornar linhas de sale_items em qualquer
-- ordem física (heap scan). Dois cancelamentos simultâneos de vendas diferentes
-- que compartilham os mesmos pvids em ordem inversa criam um ciclo de lock.
-- ORDER BY product_variation_id garante ordem global consistente.
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
  v_sale     record;
  v_item     record;
  v_prev_qty int := 0;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, status, total, sale_number, company_id INTO v_sale
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

  UPDATE sales
  SET status     = 'cancelled',
      updated_at = NOW()
  WHERE id = p_sale_id;

  -- ORDER BY product_variation_id: garante ordem de lock consistente com
  -- rpc_create_sale (que também ordena por pvid no pré-lock).
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items
    WHERE sale_id = p_sale_id
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- C. rpc_return_sale — ORDER BY no cursor de sale_items (mesmo fix que B)
-- =============================================================================

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
  v_sale     record;
  v_item     record;
  v_prev_qty int := 0;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, status, total, sale_number, company_id INTO v_sale
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
  SET status     = 'returned',
      updated_at = NOW()
  WHERE id = p_sale_id;

  -- ORDER BY product_variation_id: mesma razão do rpc_cancel_sale.
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items
    WHERE sale_id = p_sale_id
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- D. rpc_stock_initialize — stock_movements só se INSERT foi efetivo
-- =============================================================================
--
-- ON CONFLICT DO NOTHING descarta o INSERT silenciosamente quando o row já
-- existe. O código anterior inseria stock_movements incondicionalmente, criando
-- um movimento fantasma "initial: 0 → N" mesmo que o estoque não tivesse mudado.
-- IF FOUND garante que o movimento só é registrado quando o INSERT realmente
-- aconteceu (i.e., primeira inicialização desta variação).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_initialize(
  p_product_variation_id int,
  p_quantity             int,
  p_avg_cost             numeric,
  p_system_user_id       uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, p_quantity, COALESCE(p_avg_cost, 0), NOW())
  ON CONFLICT (product_variation_id) DO NOTHING;

  -- Registrar movimento SOMENTE se o INSERT criou uma nova linha.
  -- IF FOUND é false quando ON CONFLICT DO NOTHING descartou o INSERT.
  IF FOUND AND p_quantity > 0 THEN
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, notes, created_by, company_id
    )
    SELECT p_product_variation_id, pv.product_id, 'initial', p_quantity,
           0, p_quantity, p_avg_cost, 'Saldo inicial de carga', p_system_user_id, v_company_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;
  END IF;
END;
$$;

-- =============================================================================
-- Grants (reafirmar após CREATE OR REPLACE)
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO 007
-- =============================================================================
