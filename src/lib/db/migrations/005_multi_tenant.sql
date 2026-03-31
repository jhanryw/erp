-- =============================================================================
-- 005_multi_tenant.sql — Fundação de isolamento multi-tenant
-- Santtorini ERP
--
-- O que esta migração faz:
--   1. Cria tabela companies (fonte de verdade para o tenant)
--   2. Adiciona company_id a users e às tabelas de dados críticas
--   3. Popula empresa padrão e associa todos os registros existentes
--   4. Cria current_company_id() para uso no RLS
--   5. Atualiza RLS policies para isolamento por empresa
--   6. Adiciona índices em company_id
--
-- EXECUTAR EM ORDEM, APÓS 001–004.
-- Idempotente: usa IF NOT EXISTS / ON CONFLICT / OR REPLACE.
--
-- Modelo de isolamento: row-level multi-tenancy via company_id.
-- O aplicativo usa service_role (bypass RLS) — o isolamento real é feito
-- na camada TypeScript (filtro .eq('company_id', user.company_id)).
-- RLS serve como defense-in-depth para acesso direto ao banco.
-- =============================================================================

-- =============================================================================
-- 1. TABELA companies
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.companies (
  id          SERIAL       PRIMARY KEY,
  name        TEXT         NOT NULL,
  slug        TEXT         NOT NULL UNIQUE,
  plan        TEXT         NOT NULL DEFAULT 'starter'
                             CHECK (plan IN ('starter', 'professional', 'enterprise')),
  active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.companies IS
  'Tenants do ERP. Cada empresa tem dados completamente isolados via company_id.';

-- Empresa padrão (dados pré-existentes são migrados para ela)
INSERT INTO public.companies (name, slug, plan)
VALUES ('Santtorini', 'santtorini', 'professional')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- 2. company_id em users
-- =============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);

-- Associar todos os usuários existentes à empresa padrão
UPDATE public.users
SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini')
WHERE company_id IS NULL;

-- Após migração, tornar obrigatório (novas criações via app sempre incluirão company_id)
ALTER TABLE public.users
  ALTER COLUMN company_id SET NOT NULL;

-- =============================================================================
-- 3. company_id nas tabelas de dados críticas
-- =============================================================================

-- products
ALTER TABLE public.products  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.products SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.products ALTER COLUMN company_id SET NOT NULL;

-- customers
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.customers SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.customers ALTER COLUMN company_id SET NOT NULL;

-- suppliers
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.suppliers SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.suppliers ALTER COLUMN company_id SET NOT NULL;

-- sales
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.sales SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.sales ALTER COLUMN company_id SET NOT NULL;

-- finance_entries
ALTER TABLE public.finance_entries ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.finance_entries SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.finance_entries ALTER COLUMN company_id SET NOT NULL;

-- cashback_config (uma config por empresa)
ALTER TABLE public.cashback_config ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.cashback_config SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
-- cashback_config pode ter linhas históricas sem NOT NULL imediato

-- cashback_transactions
ALTER TABLE public.cashback_transactions ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.cashback_transactions SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.cashback_transactions ALTER COLUMN company_id SET NOT NULL;

-- marketing_costs
ALTER TABLE public.marketing_costs ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.marketing_costs SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.marketing_costs ALTER COLUMN company_id SET NOT NULL;

-- campaigns
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.campaigns SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.campaigns ALTER COLUMN company_id SET NOT NULL;

-- shipping_origins (origens de envio são por empresa)
ALTER TABLE public.shipping_origins ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.shipping_origins SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;

-- shipping_zones
ALTER TABLE public.shipping_zones ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.shipping_zones SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;

-- categories (cada empresa pode ter suas próprias categorias)
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
UPDATE public.categories SET company_id = (SELECT id FROM public.companies WHERE slug = 'santtorini') WHERE company_id IS NULL;
ALTER TABLE public.categories ALTER COLUMN company_id SET NOT NULL;

-- =============================================================================
-- 4. Função current_company_id() — para uso em RLS policies
-- Retorna o company_id do usuário autenticado.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT company_id
  FROM public.users
  WHERE id = auth.uid()
  LIMIT 1
$$;

COMMENT ON FUNCTION public.current_company_id() IS
  'Retorna o company_id do usuário autenticado. Usada em RLS policies para isolamento de tenant.';

-- =============================================================================
-- 5. Índices em company_id (performance de queries filtradas por tenant)
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_users_company          ON public.users(company_id);
CREATE INDEX IF NOT EXISTS idx_products_company       ON public.products(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_company      ON public.customers(company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company      ON public.suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_company          ON public.sales(company_id);
CREATE INDEX IF NOT EXISTS idx_finance_company        ON public.finance_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_cashback_cfg_company   ON public.cashback_config(company_id);
CREATE INDEX IF NOT EXISTS idx_cashback_tx_company    ON public.cashback_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_marketing_company      ON public.marketing_costs(company_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_company      ON public.campaigns(company_id);
CREATE INDEX IF NOT EXISTS idx_categories_company     ON public.categories(company_id);

-- Índices compostos para queries tenant + filtro frequente
CREATE INDEX IF NOT EXISTS idx_sales_company_date
  ON public.sales(company_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_finance_company_date
  ON public.finance_entries(company_id, reference_date DESC);
CREATE INDEX IF NOT EXISTS idx_finance_company_type
  ON public.finance_entries(company_id, type, category);
CREATE INDEX IF NOT EXISTS idx_customers_company_active
  ON public.customers(company_id, active);
CREATE INDEX IF NOT EXISTS idx_products_company_active
  ON public.products(company_id, active);

-- =============================================================================
-- 6. RLS — Atualizar policies para isolamento por empresa
--
-- NOTA: O app usa service_role que BYPASS RLS.
-- Estas policies protegem acesso direto ao banco (painel Supabase, anon key,
-- integrações externas) e são defense-in-depth.
-- O isolamento real no app é feito via filtro .eq('company_id', user.company_id)
-- na camada TypeScript.
-- =============================================================================

-- products: leitura + escrita filtradas por empresa
DROP POLICY IF EXISTS "products_select"    ON public.products;
DROP POLICY IF EXISTS "products_insert"    ON public.products;
DROP POLICY IF EXISTS "products_update"    ON public.products;
DROP POLICY IF EXISTS "products_delete"    ON public.products;

CREATE POLICY "products_select" ON public.products FOR SELECT TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "products_insert" ON public.products FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "products_update" ON public.products FOR UPDATE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "products_delete" ON public.products FOR DELETE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() = 'admin');

-- customers: isolamento por empresa (todos os roles podem ler dentro da empresa)
DROP POLICY IF EXISTS "customers_select"       ON public.customers;
DROP POLICY IF EXISTS "customers_select_admin" ON public.customers;
DROP POLICY IF EXISTS "customers_select_seller" ON public.customers;
DROP POLICY IF EXISTS "customers_insert"       ON public.customers;
DROP POLICY IF EXISTS "customers_update"       ON public.customers;
DROP POLICY IF EXISTS "customers_delete"       ON public.customers;

CREATE POLICY "customers_select" ON public.customers FOR SELECT TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "customers_insert" ON public.customers FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id());

CREATE POLICY "customers_update" ON public.customers FOR UPDATE TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "customers_delete" ON public.customers FOR DELETE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- sales: isolamento por empresa
DROP POLICY IF EXISTS "sales_select"        ON public.sales;
DROP POLICY IF EXISTS "sales_select_admin"  ON public.sales;
DROP POLICY IF EXISTS "sales_select_seller" ON public.sales;
DROP POLICY IF EXISTS "sales_insert"        ON public.sales;
DROP POLICY IF EXISTS "sales_update"        ON public.sales;
DROP POLICY IF EXISTS "sales_delete"        ON public.sales;

CREATE POLICY "sales_select" ON public.sales FOR SELECT TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "sales_insert" ON public.sales FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id());

CREATE POLICY "sales_update" ON public.sales FOR UPDATE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "sales_delete" ON public.sales FOR DELETE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() = 'admin');

-- finance_entries: isolamento por empresa
DROP POLICY IF EXISTS "finance_admin"          ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_select" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_insert" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_update" ON public.finance_entries;
DROP POLICY IF EXISTS "finance_entries_delete" ON public.finance_entries;

CREATE POLICY "finance_entries_select" ON public.finance_entries FOR SELECT TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "finance_entries_insert" ON public.finance_entries FOR INSERT TO authenticated
  WITH CHECK (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "finance_entries_update" ON public.finance_entries FOR UPDATE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "finance_entries_delete" ON public.finance_entries FOR DELETE TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- suppliers: isolamento por empresa
DROP POLICY IF EXISTS "suppliers_select" ON public.suppliers;
DROP POLICY IF EXISTS "suppliers_write"  ON public.suppliers;

CREATE POLICY "suppliers_select" ON public.suppliers FOR SELECT TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "suppliers_write" ON public.suppliers FOR ALL TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- categories: isolamento por empresa
DROP POLICY IF EXISTS "categories_select" ON public.categories;
DROP POLICY IF EXISTS "categories_write"  ON public.categories;

CREATE POLICY "categories_select" ON public.categories FOR SELECT TO authenticated
  USING (company_id = current_company_id());

CREATE POLICY "categories_write" ON public.categories FOR ALL TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- marketing_costs: isolamento por empresa
DROP POLICY IF EXISTS "marketing_costs_select" ON public.marketing_costs;
DROP POLICY IF EXISTS "marketing_costs_write"  ON public.marketing_costs;

CREATE POLICY "marketing_costs_select" ON public.marketing_costs FOR SELECT TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "marketing_costs_write" ON public.marketing_costs FOR ALL TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- cashback_transactions
ALTER TABLE public.cashback_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cashback_tx_select" ON public.cashback_transactions;
CREATE POLICY "cashback_tx_select" ON public.cashback_transactions FOR SELECT TO authenticated
  USING (company_id = current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- =============================================================================
-- 7. Atualizar rpc_create_sale para incluir company_id em sales
-- O company_id é derivado do seller (usuário logado), não passado pelo cliente.
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do vendedor — não confiamos em valor vindo do cliente
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor não está associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

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
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, p_cashback_used, p_shipping_charged,
    ROUND(v_total, 2), p_payment_method, p_sale_origin, p_notes, CURRENT_DATE, v_company_id
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
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    ROUND(v_total, 2), CURRENT_DATE, v_sale_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- Atualizar rpc_cancel_sale e rpc_return_sale para propagar company_id nas finance_entries
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

  UPDATE sales SET status = 'cancelled', updated_at = NOW() WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
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
      previous_stock, new_stock, unit_cost, reference_id, created_by
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id
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

  UPDATE sales SET status = 'returned', updated_at = NOW() WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
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
      previous_stock, new_stock, unit_cost, reference_id, created_by
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, p_system_user_id
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

-- Atualizar rpc_stock_entry para incluir company_id em finance_entries
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
  v_company_id      int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Derivar company_id do produto
  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

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
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
    v_total_lot_cost, v_cost_per_unit,
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock WHERE product_variation_id = p_product_variation_id
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
    SET quantity = v_new_qty, avg_cost = ROUND(v_new_avg_cost, 6), last_updated = NOW();

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, notes, created_by
  )
  SELECT p_product_variation_id, pv.product_id, 'entry', p_quantity_original,
         v_prev_qty::int, v_new_qty::int,
         v_cost_per_unit, v_lot_id::text, p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2), p_entry_date, v_lot_id, p_system_user_id, v_company_id
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

GRANT EXECUTE ON FUNCTION public.rpc_create_sale   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry   TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.current_company_id TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRAÇÃO 005
-- =============================================================================
