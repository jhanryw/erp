-- =============================================================================
-- 20260610_multi_estoque.sql
--
-- MULTI-ESTOQUE — stock_locations + stock_balances + RPCs adaptados
--
-- FONTE DE VERDADE: stock_balances  (nova)
-- LEGADO/BACKUP:    stock           (preservada intacta para rollback)
--
-- ROLLBACK (se necessário):
--   DROP TABLE IF EXISTS stock_balances CASCADE;
--   DROP TABLE IF EXISTS stock_locations CASCADE;
--   ALTER TABLE stock_movements
--     DROP COLUMN IF EXISTS source_location_id,
--     DROP COLUMN IF EXISTS destination_location_id,
--     DROP COLUMN IF EXISTS movement_type,
--     DROP COLUMN IF EXISTS reference_type,
--     DROP COLUMN IF EXISTS notes,
--     DROP COLUMN IF EXISTS created_by;
--   DROP FUNCTION IF EXISTS public.fn_main_store_id;
--   DROP FUNCTION IF EXISTS public.rpc_transfer_stock;
--   DROP FUNCTION IF EXISTS public.rpc_decrease_online_sale_stock;
--   -- Restaurar RPCs antigas de 20260522_rpc_create_sale_cash_session.sql
--   -- Restaurar vw_stock_live de 20260608_fix_vw_stock_live_cor_tamanho.sql
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — Tabela stock_locations
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.stock_locations (
  id            serial        PRIMARY KEY,
  company_id    int           NOT NULL REFERENCES public.companies(id),
  name          text          NOT NULL,
  slug          text          NOT NULL,
  is_main_store boolean       NOT NULL DEFAULT false,
  active        boolean       NOT NULL DEFAULT true,
  priority      int           NOT NULL DEFAULT 100,
  created_at    timestamptz   NOT NULL DEFAULT NOW(),
  updated_at    timestamptz   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_stock_location_slug_company UNIQUE (company_id, slug)
);

-- Somente 1 local principal por empresa
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_main_store_per_company
  ON public.stock_locations(company_id)
  WHERE is_main_store = true;

CREATE INDEX IF NOT EXISTS idx_stock_locations_company
  ON public.stock_locations(company_id);

COMMENT ON TABLE public.stock_locations IS
  'Locais de estoque por empresa. is_main_store=true é o único local usado em vendas presenciais.';
COMMENT ON COLUMN public.stock_locations.priority IS
  'Ordem de consumo em vendas online: menor número = primeiro a ser debitado.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Inserir "Estoque Loja" para cada empresa ativa
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.stock_locations (company_id, name, slug, is_main_store, priority)
SELECT c.id, 'Estoque Loja', 'estoque-loja', true, 1
FROM public.companies c
WHERE c.active = true
ON CONFLICT (company_id, slug) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — Tabela stock_balances (nova fonte de verdade)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.stock_balances (
  product_variation_id int           NOT NULL REFERENCES public.product_variations(id) ON DELETE CASCADE,
  stock_location_id    int           NOT NULL REFERENCES public.stock_locations(id),
  quantity             int           NOT NULL DEFAULT 0,
  avg_cost             numeric(10,4) NOT NULL DEFAULT 0,
  last_updated         timestamptz   NOT NULL DEFAULT NOW(),

  PRIMARY KEY (product_variation_id, stock_location_id),
  CONSTRAINT sb_qty_non_negative CHECK (quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_balances_location
  ON public.stock_balances(stock_location_id);

COMMENT ON TABLE public.stock_balances IS
  'Saldo de estoque por variação e por local. FONTE DE VERDADE desde 20260610.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — Migrar dados de stock → stock_balances (Estoque Loja)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Requer app.stock_rpc = '1' para passar o trigger que criamos a seguir.
-- O trigger será criado DEPOIS desta seção; aqui não há trigger ainda.

INSERT INTO public.stock_balances (
  product_variation_id,
  stock_location_id,
  quantity,
  avg_cost,
  last_updated
)
SELECT
  s.product_variation_id,
  sl.id,
  s.quantity,
  s.avg_cost,
  COALESCE(s.last_updated, NOW())
FROM public.stock s
JOIN public.product_variations pv ON pv.id = s.product_variation_id
JOIN public.products            p  ON p.id  = pv.product_id
JOIN public.stock_locations     sl ON sl.company_id    = COALESCE(s.company_id, p.company_id)
                                   AND sl.is_main_store = true
ON CONFLICT (product_variation_id, stock_location_id) DO NOTHING;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — Novas colunas em stock_movements
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS source_location_id      int  REFERENCES public.stock_locations(id),
  ADD COLUMN IF NOT EXISTS destination_location_id int  REFERENCES public.stock_locations(id),
  ADD COLUMN IF NOT EXISTS movement_type           text,  -- 'entry','sale','transfer','adjustment','return','initial'
  ADD COLUMN IF NOT EXISTS reference_type          text,  -- 'sale','lot','exchange','transfer','manual'
  ADD COLUMN IF NOT EXISTS notes                   text,
  ADD COLUMN IF NOT EXISTS created_by              uuid REFERENCES public.users(id);

CREATE INDEX IF NOT EXISTS idx_sm_source_location
  ON public.stock_movements(source_location_id)
  WHERE source_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sm_dest_location
  ON public.stock_movements(destination_location_id)
  WHERE destination_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sm_movement_type
  ON public.stock_movements(movement_type)
  WHERE movement_type IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 6 — Trigger de proteção: prevent_direct_stock_balances_write
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.prevent_direct_stock_balances_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('app.stock_rpc', true), '') != '1' THEN
    RAISE EXCEPTION
      'Escrita direta em stock_balances não é permitida. Use as RPCs transacionais.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_direct_stock_balances_write ON public.stock_balances;
CREATE TRIGGER trg_prevent_direct_stock_balances_write
  BEFORE INSERT OR UPDATE ON public.stock_balances
  FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_stock_balances_write();


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 7 — Helper fn_main_store_id
-- Retorna o stock_location_id do Estoque Loja de uma empresa.
-- Usado por todas as RPCs que precisam do local principal.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_main_store_id(p_company_id int)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM stock_locations
  WHERE company_id = p_company_id
    AND is_main_store = true
  LIMIT 1;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 8 — rpc_stock_initialize adaptado para stock_balances
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_stock_initialize(
  p_product_variation_id int,
  p_quantity             int,
  p_avg_cost             numeric,
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja da empresa
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id   int;
  v_location_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      v_company_id USING ERRCODE = 'P0001';
  END IF;

  -- Valida que o local pertence à mesma empresa
  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (
    p_product_variation_id, v_location_id,
    p_quantity, COALESCE(p_avg_cost, 0), NOW()
  )
  ON CONFLICT (product_variation_id, stock_location_id) DO NOTHING;

  IF FOUND AND p_quantity > 0 THEN
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, company_id,
      destination_location_id, movement_type, reference_type, created_by
    )
    SELECT
      p_product_variation_id, pv.product_id,
      'initial', p_quantity,
      0, p_quantity, COALESCE(p_avg_cost, 0), v_company_id,
      v_location_id, 'initial', 'manual', p_system_user_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;
  END IF;
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 9 — rpc_stock_entry adaptado para stock_balances
-- ═══════════════════════════════════════════════════════════════════════════════

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
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja da empresa
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_lot_cost  numeric;
  v_cost_per_unit   numeric;
  v_lot_id          int;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
  v_company_id      int;
  v_location_id     int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

  -- Lote (imutável, sem FK para location — rastreabilidade por nota fiscal)
  INSERT INTO stock_lots (
    product_variation_id, supplier_id, entry_type,
    quantity_original, quantity_remaining,
    unit_cost, freight_cost, tax_cost,
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type::stock_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  -- Saldo anterior no local escolhido (lock para concorrência)
  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = v_location_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;
  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  -- Upsert em stock_balances (fonte de verdade)
  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (
    p_product_variation_id, v_location_id,
    v_new_qty, ROUND(v_new_avg_cost, 6), NOW()
  )
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  -- Ledger
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    destination_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    'entry', p_quantity_original,
    v_prev_qty::int, v_new_qty::int,
    v_cost_per_unit, v_lot_id::text, v_company_id,
    v_location_id, 'entry', 'lot',
    p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  -- Finance entry (compra de estoque)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2), p_entry_date, v_lot_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object(
    'lot_id',          v_lot_id,
    'new_quantity',    v_new_qty,
    'new_avg_cost',    ROUND(v_new_avg_cost, 6),
    'total_lot_cost',  ROUND(v_total_lot_cost, 2),
    'cost_per_unit',   ROUND(v_cost_per_unit, 6),
    'location_id',     v_location_id
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 10 — rpc_stock_adjust adaptado para stock_balances
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_stock_adjust(
  p_product_variation_id int,
  p_delta                int,
  p_reason               text,
  p_notes                text,
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja
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
  v_company_id       int;
  v_location_id      int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock na linha de saldo
  SELECT quantity, avg_cost INTO v_current_qty, v_current_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = v_location_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente em "%". Atual: %, ajuste: %.',
      (SELECT name FROM stock_locations WHERE id = v_location_id),
      v_current_qty, p_delta USING ERRCODE = 'P0001';
  END IF;

  -- Upsert stock_balances
  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (p_product_variation_id, v_location_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  -- Ledger
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    source_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    'adjust', p_delta,
    v_current_qty, v_new_qty,
    v_current_avg_cost, p_reason, v_company_id,
    v_location_id, 'adjustment', 'manual',
    p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta,
    'location_id',       v_location_id
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 11 — rpc_create_sale adaptado para stock_balances (Estoque Loja)
--
-- DIFF vs 20260522_rpc_create_sale_cash_session.sql:
--   + DECLARE v_main_store_id int
--   + Lookup v_main_store_id logo após v_company_id
--   + Pré-lock: FROM stock_balances WHERE ... AND stock_location_id = v_main_store_id
--   + Stock check: FROM stock_balances (com mensagem "Transfira antes de vender")
--   + Debit: UPDATE stock_balances (em vez de UPDATE stock)
--   + stock_movements: + source_location_id, movement_type, reference_type
--   Todo o resto é idêntico ao 20260522.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    payment_method,
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric  DEFAULT 0,
  p_surcharge_amount  numeric  DEFAULT 0,
  p_payments          jsonb    DEFAULT NULL,
  p_cash_session_id   bigint   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id         int;
  v_sale_number     text;
  v_subtotal        numeric := 0;
  v_gross           numeric;
  v_total           numeric;
  v_eff_cashback    numeric;
  v_item            jsonb;
  v_pvid            int;
  v_qty             int;
  v_unit_price      numeric;
  v_unit_cost       numeric;
  v_discount        numeric;
  v_current_qty     int;
  v_item_total      numeric;
  v_company_id      int;
  v_item_company    int;
  v_card_fee        numeric;
  v_surcharge       numeric;
  v_brazil_date     date;
  v_main_store_id   int;       -- novo: ID do Estoque Loja desta empresa

  v_pmt             jsonb;
  v_pmt_method      payment_method;
  v_pmt_tendered    numeric;
  v_pmt_change      numeric;
  v_pmt_change_mth  text;
  v_pmt_net         numeric;
  v_pmt_install     int;
  v_pmt_brand       text;
  v_pmt_acquirer    text;
  v_pmt_metadata    jsonb;
  v_payments_total  numeric := 0;
  v_dominant_method payment_method;
  v_max_net         numeric := -1;
  v_fee_pct         numeric;
  v_fee_amt         numeric;

  v_session_status  text;
  v_session_company int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;
  v_card_fee    := GREATEST(0, COALESCE(p_card_fee, 0));
  v_surcharge   := GREATEST(0, COALESCE(p_surcharge_amount, 0));

  -- Empresa do vendedor
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor nao esta associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Estoque Loja desta empresa (fonte exclusiva para vendas presenciais)
  v_main_store_id := public.fn_main_store_id(v_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      v_company_id USING ERRCODE = 'P0001';
  END IF;

  -- Validação de empresa + subtotal
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid := (v_item->>'product_variation_id')::int;
    SELECT p.company_id INTO v_item_company
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;
    IF v_item_company IS NULL THEN
      RAISE EXCEPTION 'Variacao #% nao encontrada.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    IF v_item_company != v_company_id THEN
      RAISE EXCEPTION 'Variacao #% nao pertence a empresa do vendedor.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_gross        := GREATEST(0, ROUND(v_subtotal - p_discount_amount + p_shipping_charged + v_surcharge, 2));
  v_total        := GREATEST(0, v_gross - p_cashback_used);
  v_eff_cashback := v_gross - v_total;

  -- Validação de p_payments
  IF p_payments IS NOT NULL THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method   := (v_pmt->>'method')::payment_method;
      v_pmt_net      := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_tendered := COALESCE((v_pmt->>'amount_tendered')::numeric, v_pmt_net);
      v_pmt_change   := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_install  := COALESCE((v_pmt->>'installments')::int, 1);

      IF v_pmt_method NOT IN ('pix', 'cash', 'credit_card', 'debit_card') THEN
        RAISE EXCEPTION 'Metodo de pagamento invalido: %.', v_pmt->>'method' USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_net <= 0 THEN
        RAISE EXCEPTION 'net_amount deve ser positivo. Recebido: %.', v_pmt_net USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_tendered < v_pmt_net THEN
        RAISE EXCEPTION 'amount_tendered (%) deve ser >= net_amount (%).', v_pmt_tendered, v_pmt_net USING ERRCODE = 'P0001';
      END IF;
      IF ABS(v_pmt_net - (v_pmt_tendered - v_pmt_change)) > 0.01 THEN
        RAISE EXCEPTION 'net_amount (%) incoerente: tendered (%) - change (%) = %.',
          v_pmt_net, v_pmt_tendered, v_pmt_change, v_pmt_tendered - v_pmt_change USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_change > 0 AND v_pmt_method != 'cash' THEN
        RAISE EXCEPTION 'Troco so e permitido em dinheiro (metodo: %).', v_pmt_method USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_change > 0 AND (v_pmt->>'change_method') IS NULL THEN
        RAISE EXCEPTION 'change_method e obrigatorio quando ha troco.' USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_install > 1 AND v_pmt_method != 'credit_card' THEN
        RAISE EXCEPTION 'Parcelamento (%) so e permitido em credito (metodo: %).', v_pmt_install, v_pmt_method USING ERRCODE = 'P0001';
      END IF;

      v_payments_total := v_payments_total + v_pmt_net;
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := v_pmt_method;
      END IF;
    END LOOP;

    IF ABS(v_payments_total - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Soma dos pagamentos (%) difere do total da venda (%). Diferenca: %.',
        ROUND(v_payments_total, 2), ROUND(v_total, 2), ROUND(ABS(v_payments_total - v_total), 2)
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Validação da sessão de caixa
  IF p_cash_session_id IS NOT NULL THEN
    SELECT status, company_id INTO v_session_status, v_session_company
    FROM cash_register_sessions WHERE id = p_cash_session_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sessao de caixa #% nao encontrada.', p_cash_session_id USING ERRCODE = 'P0001';
    END IF;
    IF v_session_status = 'closed' THEN
      RAISE EXCEPTION 'Caixa fechado. Abra um novo caixa para registrar vendas.' USING ERRCODE = 'P0001';
    END IF;
    IF v_session_company != v_company_id THEN
      RAISE EXCEPTION 'Acesso negado a sessao de caixa.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Pré-lock anti-deadlock: travar stock_balances em ordem de pvid
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1
    FROM stock_balances
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;
  END LOOP;

  -- INSERT em sales
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- Itens: venda debita apenas do Estoque Loja
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

    -- Verificar saldo no Estoque Loja
    SELECT quantity INTO v_current_qty
    FROM stock_balances
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_main_store_id;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION
        'Produto sem saldo suficiente no Estoque Loja (variação #%). Disponível: %, solicitado: %. Transfira antes de vender.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty USING ERRCODE = 'P0001';
    END IF;

    -- Debitar do Estoque Loja
    UPDATE stock_balances
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_main_store_id;

    -- Ledger
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id,
      source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_pvid, pv.product_id,
      'sale', -v_qty,
      v_current_qty, v_current_qty - v_qty,
      v_unit_cost, v_sale_id::text, v_company_id,
      v_main_store_id, 'sale', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- Finance entries de receita e cashback (inalterado)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
  );

  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'cashback_used', 'Cashback — Venda ' || v_sale_number,
      v_eff_cashback, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- sale_payments (inalterado)
  IF p_payments IS NOT NULL THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method     := (v_pmt->>'method')::payment_method;
      v_pmt_tendered   := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change     := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net        := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install    := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand      := v_pmt->>'card_brand';
      v_pmt_acquirer   := v_pmt->>'acquirer';
      v_pmt_metadata   := COALESCE((v_pmt->'metadata'), '{}');
      v_fee_pct        := 0;
      v_fee_amt        := 0;

      IF v_pmt_method IN ('credit_card', 'debit_card') THEN
        SELECT fee_percentage INTO v_fee_pct
        FROM payment_fee_settings
        WHERE company_id = v_company_id AND payment_method = 'card' AND installments = v_pmt_install;
        IF NOT FOUND THEN v_fee_pct := 0; END IF;
        v_fee_pct := COALESCE(v_fee_pct, 0);
        v_fee_amt := ROUND(v_pmt_net * v_fee_pct / 100.0, 2);
        IF v_fee_amt > 0 THEN
          INSERT INTO finance_entries (
            type, category, description, amount, reference_date, sale_id, created_by, company_id
          )
          VALUES (
            'expense', 'operational',
            'Taxa ' || v_pmt_method || ' ' || v_pmt_install || 'x — Venda ' || v_sale_number,
            v_fee_amt, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
          );
        END IF;
      END IF;

      INSERT INTO sale_payments (
        sale_id, company_id, method,
        amount_tendered, change_amount, change_method, net_amount,
        installments, card_brand, acquirer,
        fee_percentage, fee_amount, metadata, created_by
      )
      VALUES (
        v_sale_id, v_company_id, v_pmt_method,
        v_pmt_tendered, v_pmt_change, v_pmt_change_mth, v_pmt_net,
        v_pmt_install, v_pmt_brand, v_pmt_acquirer,
        v_fee_pct, v_fee_amt, v_pmt_metadata, p_system_user_id
      );
    END LOOP;
  ELSE
    IF v_card_fee > 0 THEN
      INSERT INTO finance_entries (
        type, category, description, amount, reference_date, sale_id, created_by, company_id
      )
      VALUES (
        'expense', 'operational', 'Taxa de cartao — Venda ' || v_sale_number,
        v_card_fee, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
      );
    END IF;
    INSERT INTO sale_payments (
      sale_id, company_id, method,
      amount_tendered, change_amount, net_amount,
      installments, fee_percentage, fee_amount, metadata, created_by
    )
    VALUES (
      v_sale_id, v_company_id, p_payment_method,
      ROUND(v_total, 2), 0, ROUND(v_total, 2),
      1,
      ROUND(v_card_fee / NULLIF(ROUND(v_total, 2), 0) * 100.0, 4),
      v_card_fee, '{}', p_system_user_id
    );
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- Wrapper de compatibilidade (12-param) — inalterado
CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_accumulate_cashback boolean,
  p_cashback_used       numeric,
  p_customer_id         int,
  p_discount_amount     numeric,
  p_items               jsonb,
  p_notes               text,
  p_payment_method      text,
  p_sale_origin         text,
  p_seller_id           uuid,
  p_shipping_charged    numeric,
  p_surcharge_amount    numeric,
  p_system_user_id      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.rpc_create_sale(
    p_customer_id,
    p_seller_id,
    p_payment_method::payment_method,
    p_sale_origin,
    p_discount_amount,
    p_cashback_used,
    p_shipping_charged,
    p_notes,
    p_items,
    p_system_user_id,
    0, p_surcharge_amount, NULL, NULL
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 12 — rpc_process_exchange adaptado para stock_balances
-- ═══════════════════════════════════════════════════════════════════════════════

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
  v_total_orig_qty int;
  v_total_exch_qty int;
  v_main_store_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Local principal desta empresa (produto retornado volta para cá)
  v_main_store_id := public.fn_main_store_id(p_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Validar e travar a venda
  SELECT id, company_id, customer_id, status INTO v_sale
  FROM sales WHERE id = p_sale_id FOR UPDATE;

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
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um item para trocar.' USING ERRCODE = 'P0001';
  END IF;

  -- Validar itens e somar crédito
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.sale_id, si.quantity, si.unit_price, si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int AND si.sale_id = p_sale_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % não pertence à venda.', (v_el->>'sale_item_id') USING ERRCODE = 'P0001';
    END IF;
    IF v_qty_ret <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_already_ret
    FROM exchange_items ei
    JOIN exchanges ex ON ex.id = ei.exchange_id
    WHERE ei.sale_item_id = v_sale_item.id AND ex.status = 'completed';

    IF v_qty_ret > (v_sale_item.quantity - v_already_ret) THEN
      RAISE EXCEPTION 'Quantidade (%) excede o disponível para troca (%) no item %.',
        v_qty_ret, (v_sale_item.quantity - v_already_ret), v_sale_item.id USING ERRCODE = 'P0001';
    END IF;

    v_total_credit := v_total_credit + (v_qty_ret * v_sale_item.unit_price);
  END LOOP;

  -- Criar registro da troca
  INSERT INTO exchanges (company_id, original_sale_id, customer_id, returned_amount, credit_issued, notes, created_by)
  VALUES (p_company_id, p_sale_id, p_customer_id, v_total_credit, v_total_credit, p_notes, p_user_id)
  RETURNING id INTO v_exchange_id;

  -- Restaurar estoque (volta para Estoque Loja) e registrar movimentos
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.quantity, si.unit_price, si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si WHERE si.id = (v_el->>'sale_item_id')::int;

    INSERT INTO exchange_items (
      exchange_id, sale_item_id, product_variation_id,
      quantity_returned, unit_price, total_returned
    )
    VALUES (
      v_exchange_id, v_sale_item.id, v_sale_item.product_variation_id,
      v_qty_ret, v_sale_item.unit_price, v_qty_ret * v_sale_item.unit_price
    );

    -- Lock na linha de saldo do Estoque Loja
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_sale_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    -- Restaurar saldo no Estoque Loja
    INSERT INTO stock_balances (
      product_variation_id, stock_location_id, quantity, avg_cost, last_updated
    )
    VALUES (
      v_sale_item.product_variation_id, v_main_store_id,
      v_qty_ret, v_sale_item.unit_cost, NOW()
    )
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_qty_ret,
          last_updated = NOW();

    -- Ledger
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id,
      destination_location_id, movement_type, reference_type, notes, created_by
    )
    SELECT
      v_sale_item.product_variation_id, pv.product_id,
      'return', v_qty_ret,
      v_prev_qty, v_prev_qty + v_qty_ret,
      v_sale_item.unit_cost, p_sale_id::text, p_company_id,
      v_main_store_id, 'return', 'exchange',
      p_notes, p_user_id
    FROM product_variations pv WHERE pv.id = v_sale_item.product_variation_id;
  END LOOP;

  -- Crédito imediato (cashback)
  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id, type, amount, status, release_date, exchange_id
  )
  VALUES (p_customer_id, p_company_id, p_sale_id, 'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id);

  -- Marcar venda como devolvida se todos os itens foram trocados
  SELECT SUM(quantity) INTO v_total_orig_qty FROM sale_items WHERE sale_id = p_sale_id;

  SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_total_exch_qty
  FROM exchange_items ei
  JOIN exchanges ex ON ex.id = ei.exchange_id
  WHERE ex.original_sale_id = p_sale_id AND ex.status = 'completed';

  IF v_total_exch_qty >= v_total_orig_qty THEN
    UPDATE sales SET status = 'returned', updated_at = NOW() WHERE id = p_sale_id;
  END IF;

  RETURN jsonb_build_object('exchange_id', v_exchange_id, 'credit_amount', v_total_credit);
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 13 — rpc_transfer_stock (nova)
--
-- 1 movimento único do tipo 'transfer' com source_location_id + destination_location_id.
-- Lock de ambas as linhas em ordem determinística (menor stock_location_id primeiro).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_transfer_stock(
  p_product_variation_id int,
  p_from_location_id     int,
  p_to_location_id       int,
  p_quantity             int,
  p_notes                text,
  p_user_id              uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id       int;
  v_from_company_id  int;
  v_to_company_id    int;
  v_from_qty         int;
  v_to_qty           int;
  v_avg_cost         numeric;
  v_transfer_id      text;
  v_lock_first_id    int;
  v_lock_second_id   int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Validações básicas
  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_from_location_id = p_to_location_id THEN
    RAISE EXCEPTION 'Origem e destino não podem ser iguais.' USING ERRCODE = 'P0001';
  END IF;

  -- Empresa da variação
  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Variação #% não encontrada.', p_product_variation_id USING ERRCODE = 'P0001';
  END IF;

  -- Validar que ambos os locais pertencem à mesma empresa e estão ativos
  SELECT company_id INTO v_from_company_id
  FROM stock_locations WHERE id = p_from_location_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Local de origem #% não encontrado ou inativo.', p_from_location_id USING ERRCODE = 'P0001';
  END IF;
  IF v_from_company_id != v_company_id THEN
    RAISE EXCEPTION 'Local de origem não pertence à empresa da variação.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_to_company_id
  FROM stock_locations WHERE id = p_to_location_id AND active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Local de destino #% não encontrado ou inativo.', p_to_location_id USING ERRCODE = 'P0001';
  END IF;
  IF v_to_company_id != v_company_id THEN
    RAISE EXCEPTION 'Local de destino não pertence à empresa da variação.' USING ERRCODE = 'P0001';
  END IF;

  -- Lock em ordem determinística (menor id primeiro) para evitar deadlock
  v_lock_first_id  := LEAST(p_from_location_id, p_to_location_id);
  v_lock_second_id := GREATEST(p_from_location_id, p_to_location_id);

  PERFORM 1 FROM stock_balances
  WHERE product_variation_id = p_product_variation_id AND stock_location_id = v_lock_first_id
  FOR UPDATE;

  PERFORM 1 FROM stock_balances
  WHERE product_variation_id = p_product_variation_id AND stock_location_id = v_lock_second_id
  FOR UPDATE;

  -- Verificar saldo na origem
  SELECT COALESCE(quantity, 0), COALESCE(avg_cost, 0)
  INTO v_from_qty, v_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = p_from_location_id;

  v_from_qty := COALESCE(v_from_qty, 0);

  IF v_from_qty < p_quantity THEN
    RAISE EXCEPTION
      'Saldo insuficiente no local de origem. Disponível: %, solicitado: %.',
      v_from_qty, p_quantity USING ERRCODE = 'P0001';
  END IF;

  -- Debitar da origem
  INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, p_from_location_id, 0 - p_quantity, v_avg_cost, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = stock_balances.quantity - p_quantity,
        last_updated = NOW();

  -- Verificar que resultado não é negativo (proteção extra, CHECK já deveria pegar)
  SELECT quantity INTO v_from_qty
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id AND stock_location_id = p_from_location_id;
  IF v_from_qty < 0 THEN
    RAISE EXCEPTION 'Erro interno: saldo ficou negativo após débito.' USING ERRCODE = 'P0001';
  END IF;

  -- Creditar no destino
  SELECT COALESCE(quantity, 0) INTO v_to_qty
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id AND stock_location_id = p_to_location_id;
  v_to_qty := COALESCE(v_to_qty, 0);

  INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, avg_cost, last_updated)
  VALUES (p_product_variation_id, p_to_location_id, p_quantity, v_avg_cost, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = stock_balances.quantity + p_quantity,
        avg_cost     = v_avg_cost,
        last_updated = NOW();

  -- 1 registro único de movement para a transferência
  v_transfer_id := gen_random_uuid()::text;

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    source_location_id, destination_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    NULL,           -- legacy type = NULL (não é entry/sale/adjust/return)
    p_quantity,
    v_from_qty + p_quantity,   -- previous_stock (quantidade original na origem antes do débito)
    v_from_qty,                -- new_stock (saldo restante na origem após débito)
    v_avg_cost,
    v_transfer_id,
    v_company_id,
    p_from_location_id, p_to_location_id,
    'transfer', 'transfer',
    p_notes, p_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  RETURN jsonb_build_object(
    'transfer_id',      v_transfer_id,
    'from_location_id', p_from_location_id,
    'to_location_id',   p_to_location_id,
    'quantity',         p_quantity,
    'from_qty_after',   v_from_qty,
    'to_qty_after',     v_to_qty + p_quantity
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 14 — rpc_decrease_online_sale_stock (nova)
--
-- Para vendas online (Nuvemshop/site): debita por prioridade dos locais ativos.
-- Cria 1 movement por local debitado.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_decrease_online_sale_stock(
  p_product_variation_id int,
  p_company_id           int,
  p_quantity             int,
  p_reference_id         text,    -- ex: ID do pedido Nuvemshop
  p_user_id              uuid     DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_available  int := 0;
  v_remaining        int;
  v_loc              record;
  v_loc_qty          int;
  v_debit            int;
  v_movements        jsonb := '[]'::jsonb;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;

  -- Total disponível em todos os locais ativos (sem lock — apenas leitura)
  SELECT COALESCE(SUM(sb.quantity), 0) INTO v_total_available
  FROM stock_balances sb
  JOIN stock_locations sl ON sl.id = sb.stock_location_id
  WHERE sb.product_variation_id = p_product_variation_id
    AND sl.company_id = p_company_id
    AND sl.active     = true;

  IF v_total_available < p_quantity THEN
    RAISE EXCEPTION
      'Estoque total insuficiente. Disponível: %, solicitado: %.',
      v_total_available, p_quantity USING ERRCODE = 'P0001';
  END IF;

  -- Debitar por prioridade (menor priority = mais prioritário)
  v_remaining := p_quantity;

  FOR v_loc IN
    SELECT sl.id AS location_id, sl.priority
    FROM stock_locations sl
    JOIN stock_balances sb ON sb.stock_location_id = sl.id
                          AND sb.product_variation_id = p_product_variation_id
    WHERE sl.company_id = p_company_id
      AND sl.active     = true
      AND sb.quantity   > 0
    ORDER BY sl.priority ASC, sl.id ASC
    FOR UPDATE OF sb
  LOOP
    EXIT WHEN v_remaining = 0;

    SELECT COALESCE(quantity, 0) INTO v_loc_qty
    FROM stock_balances
    WHERE product_variation_id = p_product_variation_id AND stock_location_id = v_loc.location_id;

    v_debit := LEAST(v_remaining, v_loc_qty);
    v_remaining := v_remaining - v_debit;

    UPDATE stock_balances
    SET quantity     = quantity - v_debit,
        last_updated = NOW()
    WHERE product_variation_id = p_product_variation_id
      AND stock_location_id    = v_loc.location_id;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id,
      source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      p_product_variation_id, pv.product_id,
      'sale', -v_debit,
      v_loc_qty, v_loc_qty - v_debit,
      0, p_reference_id, p_company_id,
      v_loc.location_id, 'sale', 'online_order',
      p_user_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;

    v_movements := v_movements || jsonb_build_object(
      'location_id', v_loc.location_id,
      'quantity_deducted', v_debit,
      'stock_after', v_loc_qty - v_debit
    );
  END LOOP;

  IF v_remaining > 0 THEN
    -- Não deveria acontecer (verificamos total antes), mas proteção extra
    RAISE EXCEPTION 'Erro interno: não foi possível debitar % unidades restantes.', v_remaining
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'quantity_deducted', p_quantity,
    'movements',         v_movements
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 15 — Atualizar vw_stock_live para ler de stock_balances (Estoque Loja)
-- ═══════════════════════════════════════════════════════════════════════════════

-- DROP necessário porque CREATE OR REPLACE não permite renomear/reordenar colunas.
DROP VIEW IF EXISTS public.vw_stock_live CASCADE;

CREATE VIEW public.vw_stock_live AS
SELECT
  sb.product_variation_id,
  p.id                                                                       AS product_id,
  p.name                                                                      AS product_name,
  pv.sku_variation,
  p.sku                                                                       AS sku_parent,
  pv.size                                                                     AS tamanho,
  pv.color                                                                    AS cor,
  pv.sku_variation                                                            AS sku,
  sb.quantity                                                                 AS current_qty,
  sb.avg_cost,
  ROUND(sb.quantity * sb.avg_cost, 2)                                         AS stock_value_at_cost,
  ROUND(sb.quantity * COALESCE(pv.price_override, p.base_price), 2)          AS stock_value_at_price,
  (
    SELECT MAX(sl2.entry_date)
    FROM stock_lots sl2
    WHERE sl2.product_variation_id = sb.product_variation_id
  )                                                                           AS last_entry_date,
  (sb.quantity = 0)                                                           AS out_of_stock,
  (sb.quantity > 0 AND sb.quantity <= 3)                                      AS low_stock
FROM stock_balances sb
JOIN stock_locations    loc ON loc.id = sb.stock_location_id AND loc.is_main_store = true
JOIN product_variations pv  ON pv.id  = sb.product_variation_id
JOIN products           p   ON p.id   = pv.product_id;

GRANT SELECT ON public.vw_stock_live TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 16 — Nova view vw_stock_live_multi
--
-- Retorna 1 linha por variação com:
--   total_qty          — soma de todos os locais ativos
--   main_store_qty     — saldo no Estoque Loja
--   needs_transfer     — true quando total_qty > 0 mas main_store_qty = 0
--   balances_by_location — JSONB array ordenado por priority
-- ═══════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.vw_stock_live_multi CASCADE;

CREATE VIEW public.vw_stock_live_multi AS
SELECT
  pv.id                              AS product_variation_id,
  p.id                               AS product_id,
  p.name                             AS product_name,
  pv.sku_variation,
  p.sku                              AS sku_parent,
  pv.size                            AS tamanho,
  pv.color                           AS cor,
  p.company_id,

  COALESCE(SUM(COALESCE(sb.quantity, 0)), 0)::int   AS total_qty,

  COALESCE(
    MAX(CASE WHEN loc.is_main_store = true THEN COALESCE(sb.quantity, 0) ELSE 0 END),
    0
  )::int                                             AS main_store_qty,

  (
    COALESCE(SUM(COALESCE(sb.quantity, 0)), 0) > 0
    AND COALESCE(
      MAX(CASE WHEN loc.is_main_store = true THEN COALESCE(sb.quantity, 0) ELSE 0 END),
      0
    ) = 0
  )                                                  AS needs_transfer,

  ROUND(
    SUM(COALESCE(sb.quantity, 0) * COALESCE(sb.avg_cost, 0)),
    2
  )                                                  AS total_stock_value_at_cost,

  (
    SELECT MAX(sl2.entry_date)
    FROM stock_lots sl2
    WHERE sl2.product_variation_id = pv.id
  )                                                  AS last_entry_date,

  jsonb_agg(
    jsonb_build_object(
      'location_id',   loc.id,
      'location_name', loc.name,
      'slug',          loc.slug,
      'is_main_store', loc.is_main_store,
      'priority',      loc.priority,
      'quantity',      COALESCE(sb.quantity, 0)
    )
    ORDER BY loc.priority ASC, loc.id ASC
  )                                                  AS balances_by_location

FROM product_variations pv
JOIN products           p   ON p.id           = pv.product_id
JOIN stock_locations    loc ON loc.company_id  = p.company_id AND loc.active = true
LEFT JOIN stock_balances sb ON sb.product_variation_id = pv.id
                            AND sb.stock_location_id   = loc.id
GROUP BY pv.id, p.id, p.name, pv.sku_variation, p.sku, pv.size, pv.color, p.company_id;

GRANT SELECT ON public.vw_stock_live_multi TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 17 — RLS
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.stock_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_balances  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_locations_company" ON public.stock_locations;
CREATE POLICY "stock_locations_company" ON public.stock_locations
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "stock_balances_company" ON public.stock_balances;
CREATE POLICY "stock_balances_company" ON public.stock_balances
  FOR SELECT TO authenticated
  USING (
    stock_location_id IN (
      SELECT id FROM public.stock_locations WHERE company_id = public.current_company_id()
    )
  );


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 18 — Grants
-- ═══════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE ON public.stock_locations TO service_role;
GRANT SELECT ON public.stock_locations TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.stock_locations_id_seq TO service_role, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.stock_balances TO service_role;
GRANT SELECT ON public.stock_balances TO authenticated;

GRANT EXECUTE ON FUNCTION public.fn_main_store_id(int) TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize(int, int, numeric, uuid, int) TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_stock_entry(int, int, text, int, numeric, numeric, numeric, date, text, uuid, int)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust(int, int, text, text, uuid, int)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint
) TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid
) TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_process_exchange(int, int, int, jsonb, text, uuid)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_transfer_stock(int, int, int, int, text, uuid)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_decrease_online_sale_stock(int, int, int, text, uuid)
  TO service_role, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 19 — Validações SQL inline
-- Execute manualmente no SQL Editor do Supabase para confirmar integridade.
-- ═══════════════════════════════════════════════════════════════════════════════

/*
─── 1. Confirmar que "Estoque Loja" foi criado para todas as empresas ───────────
SELECT c.name AS empresa, sl.name AS local, sl.is_main_store, sl.active
FROM companies c
LEFT JOIN stock_locations sl ON sl.company_id = c.id AND sl.is_main_store = true
WHERE c.active = true;
-- Esperado: 1 linha por empresa com is_main_store = true

─── 2. Confirmar que todos os saldos foram migrados ────────────────────────────
SELECT
  COUNT(*) AS total_stock_original,
  (SELECT COUNT(*) FROM stock_balances) AS total_stock_balances
FROM stock;
-- Esperado: números iguais (todas as linhas de stock foram migradas)

─── 3. Confirmar que totais batem ──────────────────────────────────────────────
SELECT
  s.product_variation_id,
  s.quantity AS stock_legacy,
  sb.quantity AS stock_balances_loja
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id
JOIN stock_locations sl ON sl.company_id = COALESCE(s.company_id, p.company_id) AND sl.is_main_store = true
JOIN stock_balances sb ON sb.product_variation_id = s.product_variation_id AND sb.stock_location_id = sl.id
WHERE s.quantity != sb.quantity;
-- Esperado: 0 linhas (divergência zero)

─── 4. Confirmar vw_stock_live reflete dados corretos ───────────────────────────
SELECT product_variation_id, product_name, current_qty
FROM vw_stock_live
LIMIT 5;

─── 5. Confirmar vw_stock_live_multi funciona ────────────────────────────────────
SELECT product_variation_id, product_name, total_qty, main_store_qty, needs_transfer,
       jsonb_array_length(balances_by_location) AS n_locations
FROM vw_stock_live_multi
LIMIT 5;

─── 6. Confirmar que não há saldo negativo em stock_balances ───────────────────
SELECT COUNT(*) FROM stock_balances WHERE quantity < 0;
-- Esperado: 0

─── 7. Confirmar o trigger de proteção (deve falhar) ────────────────────────────
INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, avg_cost)
VALUES (1, 1, 99, 10);
-- Esperado: ERROR — Escrita direta em stock_balances não é permitida.

─── 8. Teste rpc_transfer_stock entre locais ────────────────────────────────────
-- Só executar se houver um segundo local criado:
-- SELECT rpc_transfer_stock(<pvid>, <from_loc_id>, <to_loc_id>, 1, 'teste', auth.uid());

─── 9. Confirmar que movements de transferência têm source + destination ────────
SELECT id, movement_type, source_location_id, destination_location_id, quantity, reference_id
FROM stock_movements
WHERE movement_type = 'transfer'
LIMIT 5;

─── 10. Verificar que ledger bate com saldo atual (por local) ───────────────────
-- Os movements novos ainda não cobrem histórico antigo (somente novos desde a migration).
-- Use a coluna movement_type IS NOT NULL para filtrar apenas os novos.
SELECT
  sb.product_variation_id,
  sb.stock_location_id,
  sb.quantity AS saldo_atual,
  COALESCE(SUM(CASE WHEN sm.source_location_id = sb.stock_location_id THEN -sm.quantity
                    WHEN sm.destination_location_id = sb.stock_location_id THEN sm.quantity
                    ELSE 0 END), 0) AS movements_sum_novo
FROM stock_balances sb
LEFT JOIN stock_movements sm ON sm.product_variation_id = sb.product_variation_id
  AND sm.movement_type IS NOT NULL
GROUP BY sb.product_variation_id, sb.stock_location_id, sb.quantity
HAVING sb.quantity != COALESCE(SUM(CASE WHEN sm.source_location_id = sb.stock_location_id THEN -sm.quantity
                                        WHEN sm.destination_location_id = sb.stock_location_id THEN sm.quantity
                                        ELSE 0 END), 0)
LIMIT 10;
-- Esperado: 0 linhas (divergência zero nos movements novos)
*/

-- =============================================================================
-- FIM — 20260610_multi_estoque.sql
-- =============================================================================
