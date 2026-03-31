-- =============================================================================
-- 004_stock_movements.sql — Rastreabilidade total do módulo de estoque
-- Santtorini ERP
--
-- O que esta migração faz:
--   1. Cria tabela stock_movements (histórico imutável de toda movimentação)
--   2. Protege stock com trigger que bloqueia escrita direta fora de RPCs
--   3. Atualiza as 5 RPCs existentes para registrar movimentos
--   4. Cria rpc_stock_initialize para carga inicial rastreável
--   5. Configura RLS para stock_movements
--
-- IMPORTANTE: executar APÓS 001, 002, 003.
-- Idempotente via CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE.
-- =============================================================================

-- =============================================================================
-- 1. TABELA stock_movements
-- Registro imutável de cada alteração no saldo de estoque.
-- Nenhuma linha deve ser apagada após inserida.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id                    BIGSERIAL        PRIMARY KEY,

  -- Localização do produto
  product_variation_id  INT              NOT NULL
                          REFERENCES public.product_variations(id) ON DELETE CASCADE,
  product_id            INT              NOT NULL
                          REFERENCES public.products(id) ON DELETE CASCADE,

  -- Tipo de movimento
  type                  TEXT             NOT NULL
                          CHECK (type IN ('entry','sale','return','adjust','initial')),

  -- Quantidade: positivo = entrada, negativo = saída
  quantity              INT              NOT NULL,

  -- Saldo antes e depois (fonte de verdade para reconstituição do histórico)
  previous_stock        INT              NOT NULL,
  new_stock             INT              NOT NULL,

  -- Custo unitário no momento do movimento (null em ajustes sem custo definido)
  unit_cost             NUMERIC(10,4),

  -- Referência ao documento de origem (sale_id, lot_id, etc.) — texto livre
  reference_id          TEXT,

  -- Contexto adicional (reason do ajuste, notas de entrada, etc.)
  notes                 TEXT,

  -- Quem executou a operação (sempre o system_user da request)
  created_by            UUID             REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Índices para as queries mais frequentes
CREATE INDEX IF NOT EXISTS idx_stock_mv_variation
  ON public.stock_movements (product_variation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_mv_product
  ON public.stock_movements (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_mv_type
  ON public.stock_movements (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_mv_created_at
  ON public.stock_movements (created_at DESC);

COMMENT ON TABLE public.stock_movements IS
  'Log imutável de toda movimentação de estoque. Nunca apague linhas.';

COMMENT ON COLUMN public.stock_movements.quantity IS
  'Quantidade movida. Positivo = entrada (entry/return/initial/adjust+). Negativo = saída (sale/adjust-).';

-- =============================================================================
-- 2. RLS — stock_movements
-- Leitura: gerente e admin.
-- Escrita: apenas via service_role (RPCs SECURITY DEFINER).
--          Nenhuma policy de INSERT para authenticated garante que Client
--          Components não possam forjar movimentos.
-- =============================================================================

ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_movements_select" ON public.stock_movements;
CREATE POLICY "stock_movements_select"
  ON public.stock_movements FOR SELECT
  TO authenticated
  USING (public.get_user_role() IN ('admin', 'gerente'));

-- =============================================================================
-- 3. TRIGGER — bloquear escrita direta na tabela stock
--
-- Objetivo: garantir que TODA alteração de saldo passe por RPC.
-- Mecanismo: cada RPC chama PERFORM set_config('app.stock_rpc','1',true)
--   no início da transação. O trigger verifica essa variável.
-- Escopo: apenas INSERT e UPDATE. DELETE é permitido (exclusão de variação).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_direct_stock_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- current_setting com segundo argumento 'true' retorna NULL (não erro) se não encontrado
  IF COALESCE(current_setting('app.stock_rpc', true), '') != '1' THEN
    RAISE EXCEPTION
      'Escrita direta na tabela stock não é permitida. Use as RPCs transacionais '
      '(rpc_stock_entry, rpc_stock_adjust, rpc_stock_initialize, etc.).'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_direct_stock_write ON public.stock;
CREATE TRIGGER trg_prevent_direct_stock_write
  BEFORE INSERT OR UPDATE ON public.stock
  FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_stock_write();

-- =============================================================================
-- 4. rpc_create_sale  (substitui versão anterior)
-- NOVO: set_config + INSERT stock_movements por item vendido
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
  -- Autorizar escrita na tabela stock para esta transação
  PERFORM set_config('app.stock_rpc', '1', true);

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_total := GREATEST(0,
    v_subtotal - p_discount_amount - p_cashback_used + p_shipping_charged
  );

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, p_cashback_used, p_shipping_charged,
    ROUND(v_total, 2), p_payment_method, p_sale_origin, p_notes, CURRENT_DATE
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

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

    -- FOR UPDATE: serializa vendas concorrentes do mesmo produto
    SELECT quantity INTO v_current_qty
    FROM stock
    WHERE product_variation_id = v_pvid
    FOR UPDATE;

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

    -- Registrar movimento de saída por venda
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, p_system_user_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    ROUND(v_total, 2), CURRENT_DATE, v_sale_id, p_system_user_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- 5. rpc_cancel_sale  (substitui versão anterior)
-- NOVO: set_config + FOR UPDATE antes do upsert + INSERT stock_movements
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

  SELECT id, status, total, sale_number INTO v_sale
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

  UPDATE sales SET status = 'cancelled' WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    -- Lock + capturar saldo anterior
    SELECT quantity INTO v_prev_qty
    FROM stock
    WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    -- Restaurar estoque
    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    -- Registrar movimento de entrada por cancelamento
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id
  );
END;
$$;

-- =============================================================================
-- 6. rpc_return_sale  (substitui versão anterior)
-- Idêntico ao cancel, apenas muda status para 'returned'.
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

  SELECT id, status, total, sale_number INTO v_sale
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

  UPDATE sales SET status = 'returned' WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock
    WHERE product_variation_id = v_item.product_variation_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW())
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity     = stock.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, created_by
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by
  )
  VALUES (
    'expense', 'other_expense',
    'Devolução — Venda ' || v_sale.sale_number,
    v_sale.total, CURRENT_DATE, p_sale_id, p_system_user_id
  );
END;
$$;

-- =============================================================================
-- 7. rpc_stock_entry  (substitui versão anterior)
-- NOVO: set_config + INSERT stock_movements após upsert
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
  PERFORM set_config('app.stock_rpc', '1', true);

  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

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

  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;

  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, ROUND(v_new_avg_cost, 6), NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  -- Registrar movimento de entrada formal
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, notes, created_by
  )
  SELECT p_product_variation_id, pv.product_id, 'entry', p_quantity_original,
         v_prev_qty::int, v_new_qty::int,
         v_cost_per_unit, v_lot_id::text, p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

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
-- 8. rpc_stock_adjust  (substitui versão anterior)
-- NOVO: set_config + INSERT stock_movements
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
  v_movement_notes   text;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT quantity, avg_cost INTO v_current_qty, v_current_avg_cost
  FROM stock
  WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION
      'Estoque insuficiente. Atual: %, ajuste: %.', v_current_qty, p_delta
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  -- Compor notas do movimento: reason + notas opcionais
  v_movement_notes := p_reason
    || CASE WHEN p_notes IS NOT NULL AND p_notes != ''
            THEN ': ' || p_notes ELSE '' END;

  -- Registrar movimento de ajuste
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, notes, created_by
  )
  SELECT p_product_variation_id, pv.product_id, 'adjust', p_delta,
         v_current_qty, v_new_qty,
         v_current_avg_cost, v_movement_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  -- Saída: lança despesa pelo custo médio atual × unidades retiradas
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
      CURRENT_DATE, p_notes, p_system_user_id
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
-- 9. rpc_stock_initialize  (nova função)
-- Carga inicial de estoque: sem lote formal, sem lançamento financeiro.
-- Gera movimento tipo 'initial' se quantity > 0.
-- Usado por: POST /api/produtos e POST /api/produtos/import
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Criar/confirmar posição de estoque (ON CONFLICT DO NOTHING evita duplicata)
  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, p_quantity, COALESCE(p_avg_cost, 0), NOW())
  ON CONFLICT (product_variation_id) DO NOTHING;

  -- Registrar movimento apenas se houver saldo inicial relevante
  IF p_quantity > 0 THEN
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, notes, created_by
    )
    SELECT p_product_variation_id, pv.product_id, 'initial', p_quantity,
           0, p_quantity, p_avg_cost, 'Saldo inicial de carga', p_system_user_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;
  END IF;
END;
$$;

-- =============================================================================
-- 10. Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust     TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO
-- =============================================================================
