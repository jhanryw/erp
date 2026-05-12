-- ============================================================================
-- MIGRAÇÃO 001 — RLS + AUDIT_LOGS
-- Santtorini ERP
--
-- EXECUTAR NO SUPABASE SQL EDITOR (uma vez em produção).
-- Idempotente: usa IF NOT EXISTS / IF EXISTS / OR REPLACE onde possível.
-- ============================================================================

-- ─── 0. Adicionar role 'gerente' ao enum (se ainda não existe) ────────────────

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'gerente';

-- ─── 1. TABELA DE AUDIT LOGS ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id  TEXT,                          -- UUID gerado pelo app por request
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_role   TEXT,
  action      TEXT NOT NULL,                 -- create | update | delete | cancel | return | adjust
  resource    TEXT NOT NULL,                 -- product | sale | finance_entry | ...
  resource_id TEXT,                          -- ID do registro afetado
  before_data JSONB,                         -- snapshot antes da mudança
  after_data  JSONB,                         -- snapshot depois da mudança
  detail      TEXT,                          -- informação complementar livre
  ip_address  TEXT,
  user_agent  TEXT
);

-- Índices para queries de auditoria
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id    ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource   ON public.audit_logs(resource, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ts         ON public.audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON public.audit_logs(action);

-- ─── 2. HABILITAR RLS NAS TABELAS PRINCIPAIS ─────────────────────────────────
--
-- IMPORTANTE: o app usa service_role (createAdminClient) que BYPASSA o RLS.
-- Estas policies protegem acesso direto ao banco (painel Supabase, keys anon,
-- integrações externas) e servem como defense-in-depth.
-- O app continua funcional pois usa service_role para todas as operações.

ALTER TABLE public.products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_lots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_entries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_costs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs        ENABLE ROW LEVEL SECURITY;

-- ─── 3. FUNÇÃO HELPER — retorna role do usuário autenticado ──────────────────

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT role::TEXT
  FROM public.users
  WHERE id = auth.uid()
  LIMIT 1
$$;

-- ─── 4. POLICIES — products ──────────────────────────────────────────────────

-- Leitura: todos os usuários autenticados
DROP POLICY IF EXISTS "products_select" ON public.products;
CREATE POLICY "products_select"
  ON public.products FOR SELECT
  TO authenticated
  USING (true);

-- Criação/edição: gerente e admin
DROP POLICY IF EXISTS "products_insert" ON public.products;
CREATE POLICY "products_insert"
  ON public.products FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "products_update" ON public.products;
CREATE POLICY "products_update"
  ON public.products FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

-- Exclusão: apenas admin
DROP POLICY IF EXISTS "products_delete" ON public.products;
CREATE POLICY "products_delete"
  ON public.products FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- ─── 5. POLICIES — product_variations ────────────────────────────────────────

DROP POLICY IF EXISTS "product_variations_select" ON public.product_variations;
CREATE POLICY "product_variations_select"
  ON public.product_variations FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "product_variations_insert" ON public.product_variations;
CREATE POLICY "product_variations_insert"
  ON public.product_variations FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "product_variations_update" ON public.product_variations;
CREATE POLICY "product_variations_update"
  ON public.product_variations FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "product_variations_delete" ON public.product_variations;
CREATE POLICY "product_variations_delete"
  ON public.product_variations FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- ─── 6. POLICIES — sales ─────────────────────────────────────────────────────

DROP POLICY IF EXISTS "sales_select" ON public.sales;
CREATE POLICY "sales_select"
  ON public.sales FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "sales_insert" ON public.sales;
CREATE POLICY "sales_insert"
  ON public.sales FOR INSERT
  TO authenticated
  WITH CHECK (true); -- qualquer usuário autenticado pode criar venda

DROP POLICY IF EXISTS "sales_update" ON public.sales;
CREATE POLICY "sales_update"
  ON public.sales FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "sales_delete" ON public.sales;
CREATE POLICY "sales_delete"
  ON public.sales FOR DELETE
  TO authenticated
  USING (get_user_role() = 'admin');

-- ─── 7. POLICIES — sale_items ────────────────────────────────────────────────

DROP POLICY IF EXISTS "sale_items_select" ON public.sale_items;
CREATE POLICY "sale_items_select"
  ON public.sale_items FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "sale_items_insert" ON public.sale_items;
CREATE POLICY "sale_items_insert"
  ON public.sale_items FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- ─── 8. POLICIES — customers ─────────────────────────────────────────────────

DROP POLICY IF EXISTS "customers_select" ON public.customers;
CREATE POLICY "customers_select"
  ON public.customers FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "customers_insert" ON public.customers;
CREATE POLICY "customers_insert"
  ON public.customers FOR INSERT
  TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "customers_update" ON public.customers;
CREATE POLICY "customers_update"
  ON public.customers FOR UPDATE
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "customers_delete" ON public.customers;
CREATE POLICY "customers_delete"
  ON public.customers FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

-- ─── 9. POLICIES — stock / stock_lots ────────────────────────────────────────

DROP POLICY IF EXISTS "stock_select" ON public.stock;
CREATE POLICY "stock_select"
  ON public.stock FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "stock_all_write" ON public.stock;
CREATE POLICY "stock_all_write"
  ON public.stock FOR ALL
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "stock_lots_select" ON public.stock_lots;
CREATE POLICY "stock_lots_select"
  ON public.stock_lots FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "stock_lots_insert" ON public.stock_lots;
CREATE POLICY "stock_lots_insert"
  ON public.stock_lots FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('admin', 'gerente'));

-- ─── 10. POLICIES — finance_entries ──────────────────────────────────────────

DROP POLICY IF EXISTS "finance_entries_select" ON public.finance_entries;
CREATE POLICY "finance_entries_select"
  ON public.finance_entries FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "finance_entries_insert" ON public.finance_entries;
CREATE POLICY "finance_entries_insert"
  ON public.finance_entries FOR INSERT
  TO authenticated
  WITH CHECK (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "finance_entries_update" ON public.finance_entries;
CREATE POLICY "finance_entries_update"
  ON public.finance_entries FOR UPDATE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "finance_entries_delete" ON public.finance_entries;
CREATE POLICY "finance_entries_delete"
  ON public.finance_entries FOR DELETE
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

-- ─── 11. POLICIES — marketing_costs ──────────────────────────────────────────

DROP POLICY IF EXISTS "marketing_costs_select" ON public.marketing_costs;
CREATE POLICY "marketing_costs_select"
  ON public.marketing_costs FOR SELECT
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "marketing_costs_write" ON public.marketing_costs;
CREATE POLICY "marketing_costs_write"
  ON public.marketing_costs FOR ALL
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

-- ─── 12. POLICIES — suppliers ────────────────────────────────────────────────

DROP POLICY IF EXISTS "suppliers_select" ON public.suppliers;
CREATE POLICY "suppliers_select"
  ON public.suppliers FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "suppliers_write" ON public.suppliers;
CREATE POLICY "suppliers_write"
  ON public.suppliers FOR ALL
  TO authenticated
  USING (get_user_role() IN ('admin', 'gerente'));

-- ─── 13. POLICIES — audit_logs ───────────────────────────────────────────────
-- Apenas admin pode ler; apenas service_role (via app) pode inserir

DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;
CREATE POLICY "audit_logs_select"
  ON public.audit_logs FOR SELECT
  TO authenticated
  USING (get_user_role() = 'admin');

-- INSERT somente via service_role (sem policy de INSERT para authenticated)
-- O app usa service_role para inserir logs, garantindo que nenhum usuário
-- possa forjar entradas de auditoria.

-- ─── 14. TRIGGER — sincronizar role para user_metadata ───────────────────────
-- Permite acesso ao role sem query extra no middleware (opcional)

CREATE OR REPLACE FUNCTION public.sync_role_to_auth_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE auth.users
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) ||
                           jsonb_build_object('role', NEW.role::text)
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_role ON public.users;
CREATE TRIGGER trg_sync_role
  AFTER INSERT OR UPDATE OF role ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_role_to_auth_metadata();

-- Sincronizar roles já existentes (executar uma vez)
UPDATE public.users SET role = role WHERE id IS NOT NULL;

-- ─── FIM DA MIGRAÇÃO ──────────────────────────────────────────────────────────
