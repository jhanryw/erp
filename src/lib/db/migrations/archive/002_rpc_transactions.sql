-- =============================================================================
-- 002_rpc_transactions.sql
-- Funções PL/pgSQL transacionais — Santtorini ERP
--
-- Substitui a "transação lógica" (sequência de chamadas REST independentes)
-- por operações ACID reais dentro do PostgreSQL.
--
-- Cada função é SECURITY DEFINER para garantir bypass de RLS independente
-- de como é chamada. Equivalente ao comportamento do service_role key.
--
-- Aplicar via Supabase SQL Editor ou: psql $DATABASE_URL -f 002_rpc_transactions.sql
-- =============================================================================

-- =============================================================================
-- 1. rpc_create_sale
-- Cria venda completa de forma atômica:
--   INSERT sales → INSERT sale_items (loop) → UPDATE stock (FOR UPDATE) → INSERT finance_entries
--
-- Uso de FOR UPDATE: garante que duas vendas concorrentes do mesmo produto não
-- resultem em estoque negativo (a segunda bloqueia até a primeira commitar).
--
-- p_items: JSONB array de
--   { product_variation_id, quantity, unit_price, unit_cost, discount_amount }
-- Retorna: { id, sale_number }
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
BEGIN
  -- Calcular subtotal iterando sobre os itens
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_total := GREATEST(0,
    v_subtotal - p_discount_amount - p_cashback_used + p_shipping_charged
  );

  -- Inserir cabeçalho da venda (sale_number gerado por trigger/default)
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2),
    p_discount_amount,
    p_cashback_used,
    p_shipping_charged,
    ROUND(v_total, 2),
    p_payment_method,
    p_sale_origin,
    p_notes,
    CURRENT_DATE
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Inserir itens e debitar estoque (lock por item = sem race condition)
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

    -- FOR UPDATE: bloqueia a linha de estoque enquanto esta transação não commitar.
    -- Requisições concorrentes para o mesmo produto_variation_id aguardam na fila.
    SELECT quantity INTO v_current_qty
    FROM stock
    WHERE product_variation_id = v_pvid
    FOR UPDATE;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Disponível: %, solicitado: %.',
        v_pvid,
        COALESCE(v_current_qty, 0),
        v_qty
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid;
  END LOOP;

  -- Lançamento financeiro (fonte da verdade: sale.total)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'income', 'sale',
    'Venda ' || v_sale_number,
    ROUND(v_total, 2),
    CURRENT_DATE,
    v_sale_id,
    p_system_user_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- 2. rpc_cancel_sale
-- Cancela uma venda atomicamente:
--   UPDATE sales → INSERT stock (restore) → INSERT finance_entries
--
-- Idempotência: falha explicitamente se a venda já está cancelled/returned.
-- Fonte da verdade do estoque restaurado: sale_items.quantity (quantidade original).
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
  v_sale record;
  v_item record;
BEGIN
  -- Bloquear linha da venda para evitar cancelamentos concorrentes
  SELECT id, status, total, sale_number INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida e não pode ser cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales SET status = 'cancelled' WHERE id = p_sale_id;

  -- Restaurar estoque: usa unit_cost do item como avg_cost inicial se linha não existir
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total,
    CURRENT_DATE,
    p_sale_id,
    p_system_user_id
  );
END;
$$;

-- =============================================================================
-- 3. rpc_return_sale
-- Processa devolução atomicamente (idêntico ao cancel, apenas muda o status).
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
  v_sale record;
  v_item record;
BEGIN
  SELECT id, status, total, sale_number INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% está cancelada e não pode ser devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales SET status = 'returned' WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total,
    CURRENT_DATE,
    p_sale_id,
    p_system_user_id
  );
END;
$$;

-- =============================================================================
-- 4. rpc_stock_entry
-- Registra entrada de estoque de forma atômica:
--   INSERT stock_lots → UPSERT stock (custo médio ponderado) → INSERT finance_entries
--
-- Custo médio ponderado:
--   new_avg = (prev_qty × prev_avg + new_qty × cost_per_unit) / (prev_qty + new_qty)
--
-- Retorna: { lot_id, new_quantity, new_avg_cost, total_lot_cost, cost_per_unit }
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_entry(
  p_product_variation_id int,
  p_supplier_id          int,
  p_entry_type           text,
  p_quantity_original    int,
  p_unit_cost            numeric,
  p_freight_cost         numeric,
  p_tax_cost             numeric,
  p_entry_date           date,
  p_notes                text,
  p_system_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_lot_cost  numeric;
  v_cost_per_unit   numeric;
  v_lot_id          uuid;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
BEGIN
  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

  -- Criar lote
  INSERT INTO stock_lots (
    product_variation_id, supplier_id, entry_type,
    quantity_original, quantity_remaining,
    unit_cost, freight_cost, tax_cost,
    total_lot_cost, cost_per_unit,
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost,
    COALESCE(p_freight_cost, 0),
    COALESCE(p_tax_cost, 0),
    v_total_lot_cost,
    v_cost_per_unit,
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  -- Ler posição atual (FOR UPDATE: evita race em entradas simultâneas)
  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  -- NULL = produto sem registro de estoque ainda
  IF v_prev_qty IS NULL     THEN v_prev_qty     := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;

  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  -- Upsert posição de estoque
  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, ROUND(v_new_avg_cost, 6), NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  -- Lançamento financeiro — fonte da verdade: total_lot_cost
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2),
    p_entry_date,
    v_lot_id,
    p_system_user_id
  );

  RETURN jsonb_build_object(
    'lot_id',         v_lot_id,
    'new_quantity',   v_new_qty,
    'new_avg_cost',   ROUND(v_new_avg_cost, 6),
    'total_lot_cost', ROUND(v_total_lot_cost, 2),
    'cost_per_unit',  ROUND(v_cost_per_unit, 6)
  );
END;
$$;

-- =============================================================================
-- 5. rpc_stock_adjust
-- Ajuste manual de estoque atomicamente:
--   SELECT stock (FOR UPDATE) → UPSERT stock → INSERT finance_entries (somente saída)
--
-- Impede estoque negativo explicitamente (ERRCODE P0001).
-- Saídas geram despesa: custo_médio_atual × |delta|.
--
-- Retorna: { new_quantity, previous_quantity, delta }
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_adjust(
  p_product_variation_id int,
  p_delta                int,
  p_reason               text,
  p_notes                text,
  p_system_user_id       uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty      int     := 0;
  v_current_avg_cost numeric := 0;
  v_new_qty          int;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock: evita ajustes concorrentes na mesma variação
  SELECT quantity, avg_cost INTO v_current_qty, v_current_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty     IS NULL THEN v_current_qty     := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION
      'Estoque insuficiente. Atual: %, ajuste: %.',
      v_current_qty, p_delta
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  -- Saída: lança despesa usando o custo médio atual como proxy do valor perdido
  IF p_delta < 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, notes, created_by
    )
    VALUES (
      'expense', 'other_expense',
      'Ajuste de estoque (' || p_reason || '): '
        || ABS(p_delta)::text || ' un. — var. #'
        || p_product_variation_id::text,
      ROUND(ABS(p_delta) * v_current_avg_cost, 2),
      CURRENT_DATE,
      p_notes,
      p_system_user_id
    );
  END IF;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta
  );
END;
$$;

-- =============================================================================
-- Grants: permitir chamada via service_role (PostgREST)
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry  TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust TO service_role;

-- Também conceder ao authenticated para futuras políticas de RLS
GRANT EXECUTE ON FUNCTION public.rpc_create_sale  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust TO authenticated;
