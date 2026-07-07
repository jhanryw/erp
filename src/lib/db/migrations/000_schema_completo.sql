-- =============================================================================
-- SANTTORINI ERP — SCHEMA COMPLETO CONSOLIDADO
-- Versão única que substitui todas as migrations 001–036
--
-- Filosofia:
--   • Idempotente: IF NOT EXISTS / CREATE OR REPLACE em todo lugar
--   • Uma só fonte de verdade para o schema do banco
--   • Sem functions perigosas (reconcile_stock foi removida)
--   • mv_stock_status lê de stock.quantity (não de stock_lots)
--   • RPCs sem race condition (pré-lock ordenado por pvid)
--   • stock_movements schema real: id UUID, sem notes, sem created_by
--
-- Para instâncias NOVAS: executar este arquivo completo.
-- Para instâncias existentes: o dado já está no banco, só as migrations
-- de correção individuais precisam rodar (view fix, stock qty fix).
-- =============================================================================

-- =============================================================================
-- 0. EXTENSÕES
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- 1. ENUMS
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'seller', 'gerente');
EXCEPTION WHEN duplicate_object THEN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'gerente';
END $$;

DO $$ BEGIN
  CREATE TYPE product_origin AS ENUM ('own_brand', 'third_party');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_entry_type AS ENUM ('purchase', 'own_production');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('pix', 'card', 'cash');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE sale_status AS ENUM (
    'pending', 'paid', 'shipped', 'delivered', 'cancelled', 'returned'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE customer_origin AS ENUM (
    'instagram', 'referral', 'paid_traffic', 'website', 'store', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE marketing_category AS ENUM (
    'paid_traffic', 'influencers', 'events', 'photos', 'gifts',
    'packaging', 'rent', 'salaries', 'operational', 'taxes', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cashback_transaction_type AS ENUM (
    'earn', 'release', 'use', 'expire', 'reverse'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cashback_status AS ENUM (
    'pending', 'available', 'used', 'expired', 'reversed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE finance_entry_type AS ENUM ('income', 'expense');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE finance_category AS ENUM (
    'sale', 'cashback_used', 'other_income',
    'stock_purchase', 'freight_cost', 'marketing', 'rent',
    'salaries', 'operational', 'taxes', 'other_expense'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_type AS ENUM ('return', 'exchange');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_status AS ENUM ('pending', 'processed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- 2. COMPANIES (multi-tenant)
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

-- Empresa padrão
INSERT INTO public.companies (name, slug, plan)
VALUES ('Santtorini', 'santtorini', 'professional')
ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- 3. USERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  role        user_role   NOT NULL DEFAULT 'seller',
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  company_id  INT         REFERENCES public.companies(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger: sincroniza role do usuário para auth.users.raw_user_meta_data
-- Permite que o middleware leia o role sem query extra ao banco
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

-- =============================================================================
-- 4. FUNÇÕES AUXILIARES DE RLS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role::text FROM public.users WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT company_id FROM public.users WHERE id = auth.uid();
$$;

-- =============================================================================
-- 5. PARÂMETROS GLOBAIS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.parameters (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID        REFERENCES public.users(id)
);

-- =============================================================================
-- 6. CATEGORIAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.categories (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  parent_id   INT         REFERENCES public.categories(id) ON DELETE SET NULL,
  company_id  INT         REFERENCES public.companies(id),
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 7. COLEÇÕES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.collections (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  season      TEXT,
  year        SMALLINT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 8. TIPOS E VALORES DE VARIAÇÃO
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.variation_types (
  id     SERIAL  PRIMARY KEY,
  name   TEXT    NOT NULL,
  slug   TEXT    NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS public.variation_values (
  id                SERIAL  PRIMARY KEY,
  variation_type_id INT     NOT NULL REFERENCES public.variation_types(id) ON DELETE CASCADE,
  value             TEXT    NOT NULL,
  slug              TEXT    NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (variation_type_id, slug)
);

-- =============================================================================
-- 9. FORNECEDORES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.suppliers (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  document    TEXT        UNIQUE,
  phone       TEXT,
  city        TEXT,
  state       CHAR(2),
  notes       TEXT,
  company_id  INT         REFERENCES public.companies(id),
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 9b. MARCAS
-- =============================================================================
-- Ver supabase/migrations/20260707_create_brands.sql. Entidade própria,
-- distinta de Fornecedor (vínculo comercial) e de products.origin
-- (fabricação própria vs. terceiro). Nasce opcional — products.brand_id
-- é nullable, sem preenchimento retroativo de produtos existentes.

CREATE TABLE IF NOT EXISTS public.brands (
  id          SERIAL      PRIMARY KEY,
  company_id  INT         NOT NULL REFERENCES public.companies(id),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_brands_company_slug UNIQUE (company_id, slug)
);

-- =============================================================================
-- 10. PRODUTOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.products (
  id              SERIAL          PRIMARY KEY,
  name            TEXT            NOT NULL,
  sku             TEXT            NOT NULL UNIQUE,
  category_id     INT             NOT NULL REFERENCES public.categories(id),
  subcategory_id  INT             REFERENCES public.categories(id),
  collection_id   INT             REFERENCES public.collections(id),
  supplier_id     INT             REFERENCES public.suppliers(id),
  origin          product_origin  NOT NULL DEFAULT 'third_party',
  base_cost       NUMERIC(10,2)   NOT NULL DEFAULT 0,
  base_price      NUMERIC(10,2)   NOT NULL,
  photo_url       TEXT,
  company_id      INT             NOT NULL REFERENCES public.companies(id),
  active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT products_price_positive CHECK (base_price > 0),
  CONSTRAINT products_cost_non_negative CHECK (base_cost >= 0)
);

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS margin_pct NUMERIC(5,2)
    GENERATED ALWAYS AS (
      CASE WHEN base_price > 0
      THEN ROUND(((base_price - base_cost) / base_price) * 100, 2)
      ELSE 0 END
    ) STORED;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS markup_pct NUMERIC(5,2)
    GENERATED ALWAYS AS (
      CASE WHEN base_cost > 0
      THEN ROUND(((base_price - base_cost) / base_cost) * 100, 2)
      ELSE NULL END
    ) STORED;

-- Retroativo (ver supabase/migrations/20260706_document_tipo_modelo_ano.sql):
-- colunas já existiam em produção sem migration rastreável. Obrigatórias em
-- todo caminho de escrita (POST /api/produtos, POST /api/produtos/import) e
-- usadas na geração de SKU. Auditoria de 2026-07-06 confirmou 0 produtos
-- (de 370) com tipo/modelo/ano nulo ou vazio.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS tipo   TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS modelo TEXT NOT NULL,
  ADD COLUMN IF NOT EXISTS ano    TEXT NOT NULL;

-- Retroativo (ver supabase/migrations/20260707_create_brands.sql): Marca,
-- nullable, sem preenchimento de produtos existentes.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS brand_id INT REFERENCES public.brands(id);

CREATE INDEX IF NOT EXISTS idx_products_brand_id
  ON public.products(brand_id);

-- =============================================================================
-- 11. VARIAÇÕES DE PRODUTO
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_variations (
  id             SERIAL        PRIMARY KEY,
  product_id     INT           NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  sku_variation  TEXT          NOT NULL UNIQUE,
  cost_override  NUMERIC(10,2),
  price_override NUMERIC(10,2),
  photo_url      TEXT,
  active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.product_variation_attributes (
  product_variation_id  INT NOT NULL REFERENCES public.product_variations(id) ON DELETE CASCADE,
  variation_type_id     INT NOT NULL REFERENCES public.variation_types(id),
  variation_value_id    INT NOT NULL REFERENCES public.variation_values(id),
  PRIMARY KEY (product_variation_id, variation_type_id)
);

-- =============================================================================
-- 12. ESTOQUE — LOTES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stock_lots (
  id                    SERIAL            PRIMARY KEY,
  product_variation_id  INT               NOT NULL REFERENCES public.product_variations(id),
  supplier_id           INT               REFERENCES public.suppliers(id),
  entry_type            stock_entry_type  NOT NULL,
  quantity_original     INT               NOT NULL,
  quantity_remaining    INT               NOT NULL,
  unit_cost             NUMERIC(10,2)     NOT NULL DEFAULT 0,
  freight_cost          NUMERIC(10,2)     NOT NULL DEFAULT 0,
  tax_cost              NUMERIC(10,2)     NOT NULL DEFAULT 0,
  total_lot_cost        NUMERIC(10,2)     GENERATED ALWAYS AS (
                          (unit_cost * quantity_original) + freight_cost + tax_cost
                        ) STORED,
  cost_per_unit         NUMERIC(10,4)     GENERATED ALWAYS AS (
                          CASE WHEN quantity_original > 0
                          THEN ((unit_cost * quantity_original) + freight_cost + tax_cost) / quantity_original
                          ELSE unit_cost END
                        ) STORED,
  entry_date            DATE              NOT NULL DEFAULT CURRENT_DATE,
  notes                 TEXT,
  created_by            UUID              REFERENCES public.users(id),
  created_at            TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_lots_qty_positive CHECK (quantity_original > 0),
  CONSTRAINT stock_lots_qty_remaining_valid
    CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_original)
);

-- =============================================================================
-- 13. ESTOQUE — POSIÇÃO ATUAL
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stock (
  product_variation_id  INT             PRIMARY KEY REFERENCES public.product_variations(id),
  quantity              INT             NOT NULL DEFAULT 0,
  avg_cost              NUMERIC(10,4)   NOT NULL DEFAULT 0,
  company_id            INT             REFERENCES public.companies(id),
  last_updated          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_qty_non_negative CHECK (quantity >= 0)
);

-- Trigger que bloqueia escrita direta em stock fora de RPCs autorizadas
CREATE OR REPLACE FUNCTION public.prevent_direct_stock_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(current_setting('app.stock_rpc', true), '') != '1' THEN
    RAISE EXCEPTION
      'Escrita direta em stock não é permitida. Use as RPCs transacionais.'
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
-- 14. ESTOQUE — MOVIMENTAÇÕES (schema real do banco)
--
-- IMPORTANTE: este schema reflete o que REALMENTE existe no banco.
--   - id: UUID (gen_random_uuid)
--   - SEM coluna notes
--   - SEM coluna created_by
--   - company_id: NOT NULL
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stock_movements (
  id                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  product_variation_id  BIGINT          REFERENCES public.product_variations(id) ON DELETE CASCADE,
  product_id            BIGINT          REFERENCES public.products(id) ON DELETE CASCADE,
  company_id            INT             NOT NULL REFERENCES public.companies(id),
  type                  TEXT            CHECK (type IN ('entry','sale','return','adjust','initial')),
  quantity              INT,
  previous_stock        INT,
  new_stock             INT,
  unit_cost             NUMERIC(10,4),
  reference_id          TEXT,
  created_at            TIMESTAMPTZ     DEFAULT NOW()
);

-- índices de stock_movements estão na seção 27 (após ALTER TABLE que garante company_id)

-- =============================================================================
-- 15. CLIENTES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.customers (
  id            SERIAL          PRIMARY KEY,
  cpf           TEXT            NOT NULL,
  name          TEXT            NOT NULL,
  phone         TEXT            NOT NULL,
  birth_date    DATE,
  city          TEXT,
  state         CHAR(2),
  origin        customer_origin,
  notes         TEXT,
  company_id    INT             NOT NULL REFERENCES public.companies(id),
  active        BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_by    UUID            REFERENCES public.users(id),
  UNIQUE (cpf, company_id)
);

CREATE TABLE IF NOT EXISTS public.customer_preferences (
  customer_id   INT     PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  sizes         TEXT[],
  colors        TEXT[],
  categories    INT[],
  notes         TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.customer_metrics (
  customer_id         INT             PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  total_spent         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  order_count         INT             NOT NULL DEFAULT 0,
  avg_ticket          NUMERIC(10,2)   NOT NULL DEFAULT 0,
  last_purchase_date  DATE,
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 16. VENDAS
-- =============================================================================

-- Gera o número sequencial da venda: SNT-YYYYMMDD-NNNN
-- Usado como DEFAULT na coluna sale_number da tabela sales.
-- Atenção: usar UNIQUE constraint como proteção contra race condition rara.
CREATE OR REPLACE FUNCTION public.generate_sale_number()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_count INT;
  v_today_str   TEXT;
BEGIN
  v_today_str := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO v_today_count
  FROM public.sales
  WHERE sale_date = CURRENT_DATE;
  RETURN 'SNT-' || v_today_str || '-' || LPAD(v_today_count::TEXT, 4, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS public.sales (
  id                SERIAL          PRIMARY KEY,
  sale_number       TEXT            NOT NULL UNIQUE DEFAULT public.generate_sale_number(),
  customer_id       INT             NOT NULL REFERENCES public.customers(id),
  seller_id         UUID            NOT NULL REFERENCES public.users(id),
  status            sale_status     NOT NULL DEFAULT 'pending',
  subtotal          NUMERIC(10,2)   NOT NULL DEFAULT 0,
  discount_amount   NUMERIC(10,2)   NOT NULL DEFAULT 0,
  surcharge_amount  NUMERIC(10,2)   NOT NULL DEFAULT 0,
  cashback_used     NUMERIC(10,2)   NOT NULL DEFAULT 0,
  shipping_charged  NUMERIC(10,2)   NOT NULL DEFAULT 0,
  total             NUMERIC(10,2)   NOT NULL DEFAULT 0,
  payment_method    payment_method  NOT NULL,
  sale_origin       customer_origin,
  notes             TEXT,
  company_id        INT             NOT NULL REFERENCES public.companies(id),
  sale_date         DATE            NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT sales_total_non_negative CHECK (total >= 0),
  CONSTRAINT sales_discount_valid CHECK (discount_amount >= 0 AND discount_amount <= subtotal),
  CONSTRAINT sales_cashback_valid CHECK (cashback_used >= 0)
);

CREATE TABLE IF NOT EXISTS public.sale_items (
  id                    SERIAL        PRIMARY KEY,
  sale_id               INT           NOT NULL REFERENCES public.sales(id) ON DELETE CASCADE,
  product_variation_id  INT           NOT NULL REFERENCES public.product_variations(id),
  stock_lot_id          INT           REFERENCES public.stock_lots(id),
  quantity              INT           NOT NULL,
  unit_price            NUMERIC(10,2) NOT NULL,
  unit_cost             NUMERIC(10,4) NOT NULL,
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_price           NUMERIC(10,2) NOT NULL,
  gross_profit          NUMERIC(10,2) GENERATED ALWAYS AS (
                          total_price - (unit_cost * quantity)
                        ) STORED,

  CONSTRAINT sale_items_qty_positive CHECK (quantity > 0),
  CONSTRAINT sale_items_price_positive CHECK (unit_price > 0)
);

-- =============================================================================
-- 17. DEVOLUÇÕES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.returns (
  id              SERIAL        PRIMARY KEY,
  sale_id         INT           NOT NULL REFERENCES public.sales(id),
  type            return_type   NOT NULL,
  reason          TEXT,
  status          return_status NOT NULL DEFAULT 'pending',
  total_refunded  NUMERIC(10,2) NOT NULL DEFAULT 0,
  processed_at    TIMESTAMPTZ,
  processed_by    UUID          REFERENCES public.users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      UUID          NOT NULL REFERENCES public.users(id)
);

CREATE TABLE IF NOT EXISTS public.return_items (
  id                    SERIAL    PRIMARY KEY,
  return_id             INT       NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
  sale_item_id          INT       NOT NULL REFERENCES public.sale_items(id),
  quantity              INT       NOT NULL,
  reason                TEXT,
  restocked             BOOLEAN   NOT NULL DEFAULT FALSE,
  restocked_lot_id      INT       REFERENCES public.stock_lots(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT return_items_qty_positive CHECK (quantity > 0)
);

-- =============================================================================
-- 18. CASHBACK
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cashback_config (
  id                SERIAL        PRIMARY KEY,
  company_id        INT           REFERENCES public.companies(id),
  rate_pct          NUMERIC(5,2)  NOT NULL,
  min_order_value   NUMERIC(10,2) NOT NULL DEFAULT 0,
  release_days      INT           NOT NULL DEFAULT 30,
  expiry_days       INT           NOT NULL DEFAULT 180,
  min_use_value     NUMERIC(10,2) NOT NULL DEFAULT 10,
  active            BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by        UUID          REFERENCES public.users(id),

  CONSTRAINT cashback_config_rate_valid CHECK (rate_pct > 0 AND rate_pct <= 100)
);
-- índice uq_cashback_config_company_active está na seção 27 (após ALTER TABLE que garante a coluna)

CREATE TABLE IF NOT EXISTS public.cashback_transactions (
  id                SERIAL                    PRIMARY KEY,
  customer_id       INT                       NOT NULL REFERENCES public.customers(id),
  company_id        INT                       NOT NULL REFERENCES public.companies(id),
  sale_id           INT                       REFERENCES public.sales(id),
  type              cashback_transaction_type NOT NULL,
  amount            NUMERIC(10,2)             NOT NULL,
  status            cashback_status           NOT NULL DEFAULT 'pending',
  release_date      DATE,
  expiry_date       DATE,
  used_at           TIMESTAMPTZ,
  used_in_sale_id   INT                       REFERENCES public.sales(id),
  reverse_reason    TEXT,
  created_at        TIMESTAMPTZ               NOT NULL DEFAULT NOW(),

  CONSTRAINT cashback_amount_positive CHECK (amount > 0)
);

CREATE OR REPLACE VIEW public.v_cashback_balance AS
SELECT
  customer_id,
  SUM(CASE WHEN type = 'earn' AND status = 'pending'   THEN amount ELSE 0 END) AS pending_balance,
  SUM(CASE WHEN type = 'earn' AND status = 'available' THEN amount ELSE 0 END) AS available_balance,
  SUM(CASE WHEN type = 'use'                            THEN amount ELSE 0 END) AS total_used,
  SUM(CASE WHEN type = 'expire'                         THEN amount ELSE 0 END) AS total_expired,
  SUM(CASE WHEN type = 'reverse'                        THEN amount ELSE 0 END) AS total_reversed
FROM public.cashback_transactions
GROUP BY customer_id;

-- =============================================================================
-- 19. FINANÇAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.campaigns (
  id          SERIAL        PRIMARY KEY,
  name        TEXT          NOT NULL,
  channel     TEXT          NOT NULL,
  start_date  DATE,
  end_date    DATE,
  budget      NUMERIC(10,2),
  objective   TEXT,
  notes       TEXT,
  company_id  INT           NOT NULL REFERENCES public.companies(id),
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by  UUID          NOT NULL REFERENCES public.users(id)
);

CREATE TABLE IF NOT EXISTS public.marketing_costs (
  id            SERIAL              PRIMARY KEY,
  category      marketing_category  NOT NULL,
  description   TEXT                NOT NULL,
  amount        NUMERIC(10,2)       NOT NULL,
  cost_date     DATE                NOT NULL DEFAULT CURRENT_DATE,
  campaign_id   INT                 REFERENCES public.campaigns(id),
  company_id    INT                 NOT NULL REFERENCES public.companies(id),
  is_recurring  BOOLEAN             NOT NULL DEFAULT FALSE,
  notes         TEXT,
  created_at    TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  created_by    UUID                NOT NULL REFERENCES public.users(id),

  CONSTRAINT marketing_costs_amount_positive CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS public.finance_entries (
  id                  SERIAL                PRIMARY KEY,
  type                finance_entry_type    NOT NULL,
  category            finance_category      NOT NULL,
  description         TEXT                  NOT NULL,
  amount              NUMERIC(12,2)         NOT NULL,
  reference_date      DATE                  NOT NULL,
  company_id          INT                   NOT NULL REFERENCES public.companies(id),
  sale_id             INT                   REFERENCES public.sales(id),
  stock_lot_id        INT                   REFERENCES public.stock_lots(id),
  marketing_cost_id   INT                   REFERENCES public.marketing_costs(id),
  return_id           INT                   REFERENCES public.returns(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  created_by          UUID                  REFERENCES public.users(id),

  CONSTRAINT finance_entries_amount_positive CHECK (amount > 0)
);

-- =============================================================================
-- 20. TAXAS DE PAGAMENTO
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.payment_fee_settings (
  id              SERIAL        PRIMARY KEY,
  company_id      INT           NOT NULL REFERENCES public.companies(id),
  payment_method  TEXT          NOT NULL,
  installments    INT           NOT NULL DEFAULT 1,
  label           TEXT          NOT NULL,
  fee_percentage  NUMERIC(6,4)  NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, payment_method, installments)
);

-- =============================================================================
-- 21. FRETE / LOGÍSTICA
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.shipping_origins (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  cep          TEXT NOT NULL,
  street       TEXT NOT NULL,
  number       TEXT,
  complement   TEXT,
  neighborhood TEXT NOT NULL,
  city         TEXT NOT NULL,
  state        CHAR(2) NOT NULL DEFAULT 'RN',
  latitude     NUMERIC(10, 7),
  longitude    NUMERIC(10, 7),
  company_id   INT REFERENCES public.companies(id),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.shipping_zones (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  state              CHAR(2) NOT NULL DEFAULT 'RN',
  city               TEXT,
  neighborhoods_json JSONB NOT NULL DEFAULT '[]',
  cep_ranges_json    JSONB NOT NULL DEFAULT '[]',
  min_km             NUMERIC(8, 2),
  max_km             NUMERIC(8, 2),
  color              TEXT NOT NULL DEFAULT '#3b82f6',
  priority           INTEGER NOT NULL DEFAULT 100,
  company_id         INT REFERENCES public.companies(id),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.shipping_rules (
  id                      SERIAL PRIMARY KEY,
  zone_id                 INTEGER NOT NULL REFERENCES public.shipping_zones(id) ON DELETE CASCADE,
  rule_type               TEXT NOT NULL DEFAULT 'zone',
  client_price            NUMERIC(10, 2) NOT NULL DEFAULT 0,
  internal_cost           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  estimated_hours         INTEGER NOT NULL DEFAULT 24,
  free_shipping_min_order NUMERIC(10, 2),
  min_order_to_enable     NUMERIC(10, 2),
  allow_pickup            BOOLEAN NOT NULL DEFAULT false,
  allow_delivery          BOOLEAN NOT NULL DEFAULT true,
  is_active               BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 22. METAS DE FATURAMENTO
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.monthly_sales_goals (
  id           SERIAL        PRIMARY KEY,
  company_id   INT           NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year         INT           NOT NULL,
  month        INT           NOT NULL CHECK (month BETWEEN 1 AND 12),
  goal_min     NUMERIC(14,2) NOT NULL DEFAULT 0,
  goal_target  NUMERIC(14,2) NOT NULL DEFAULT 0,
  goal_stretch NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_sales_goals_unique UNIQUE (company_id, year, month)
);

-- =============================================================================
-- 23. AUDIT LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id  TEXT,
  user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  user_role   TEXT,
  action      TEXT        NOT NULL,
  resource    TEXT        NOT NULL,
  resource_id TEXT,
  before_data JSONB,
  after_data  JSONB,
  detail      TEXT,
  ip_address  TEXT,
  user_agent  TEXT
);

-- =============================================================================
-- 24. INTEGRAÇÃO NUVEMSHOP
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.produto_map (
  id                  BIGSERIAL PRIMARY KEY,
  source              TEXT      NOT NULL DEFAULT 'nuvemshop',
  external_product_id TEXT      NOT NULL,
  internal_product_id BIGINT,
  product_variation_id INT      REFERENCES public.product_variations(id) ON DELETE SET NULL,
  external_variant_id TEXT,
  external_sku        TEXT,
  last_stock_synced_at TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- índice uq_produto_map_variant está na seção 26 (após ALTER TABLE que garante a coluna)

CREATE TABLE IF NOT EXISTS public.nuvemshop_sync_logs (
  id                   BIGSERIAL   PRIMARY KEY,
  event_type           TEXT        NOT NULL,
  direction            TEXT        NOT NULL CHECK (direction IN ('erp_to_ns', 'ns_to_erp')),
  product_variation_id INT,
  external_product_id  TEXT,
  external_variant_id  TEXT,
  external_order_id    TEXT,
  stock_before         INT,
  stock_after          INT,
  success              BOOLEAN     NOT NULL DEFAULT TRUE,
  error_message        TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 25. VIEW DE ESTOQUE (correta: lê de stock.quantity)
--
-- NUNCA usar stock_lots.quantity_remaining como fonte de estoque atual.
-- stock_lots.quantity_remaining não é decrementado pelas vendas —
-- somente stock.quantity é a fonte de verdade para saldo disponível.
-- =============================================================================

DROP VIEW IF EXISTS public.mv_stock_status CASCADE;

CREATE VIEW public.mv_stock_status AS
SELECT
  s.product_variation_id,
  p.id                                                              AS product_id,
  p.name                                                            AS product_name,
  pv.sku_variation,
  p.sku                                                             AS sku_parent,
  p.company_id,
  s.quantity                                                        AS current_qty,
  s.avg_cost,
  ROUND(s.quantity * s.avg_cost, 2)                                AS stock_value_at_cost,
  ROUND(s.quantity * COALESCE(pv.price_override, p.base_price), 2) AS stock_value_at_price,
  p.base_price,
  p.margin_pct,
  (s.quantity = 0)                                                  AS out_of_stock,
  (s.quantity > 0 AND s.quantity <= 3)                             AS low_stock,
  (
    SELECT MAX(sl.entry_date)
    FROM public.stock_lots sl
    WHERE sl.product_variation_id = s.product_variation_id
  ) AS last_entry_date,
  (
    SELECT MAX(s2.sale_date)
    FROM public.sales s2
    JOIN public.sale_items si2 ON si2.sale_id = s2.id
    WHERE si2.product_variation_id = s.product_variation_id
      AND s2.status NOT IN ('cancelled', 'returned')
  ) AS last_sale_date,
  (
    SELECT vv.value
    FROM public.product_variation_attributes pva
    JOIN public.variation_values vv ON vv.id = pva.variation_value_id
    JOIN public.variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'tamanho'
    WHERE pva.product_variation_id = s.product_variation_id
    LIMIT 1
  ) AS tamanho,
  (
    SELECT vv.value
    FROM public.product_variation_attributes pva
    JOIN public.variation_values vv ON vv.id = pva.variation_value_id
    JOIN public.variation_types  vt ON vt.id = pva.variation_type_id AND vt.slug = 'cor'
    WHERE pva.product_variation_id = s.product_variation_id
    LIMIT 1
  ) AS cor
FROM public.stock s
JOIN public.product_variations pv ON pv.id = s.product_variation_id
JOIN public.products            p  ON p.id  = pv.product_id;

GRANT SELECT ON public.mv_stock_status TO authenticated, service_role;

-- =============================================================================
-- 26. COLUNAS ADICIONADAS VIA ALTER TABLE EM MIGRATIONS ANTERIORES
--
-- Necessário para bancos existentes onde o CREATE TABLE IF NOT EXISTS acima
-- foi ignorado (tabela já existia sem essas colunas).
-- Cobre todas as tabelas que tiveram colunas adicionadas nas migrations 005–031.
-- Todos os comandos são idempotentes via ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- migration 005: company_id em todas as tabelas originais
ALTER TABLE public.categories           ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.suppliers            ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.products             ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.customers            ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.sales                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.finance_entries      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.cashback_config      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.cashback_transactions ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.marketing_costs      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.campaigns            ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.shipping_origins     ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.shipping_zones       ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);

-- migration 006: company_id em stock_movements + updated_at em sales
ALTER TABLE public.stock_movements      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);
ALTER TABLE public.sales                ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();

-- migration 013: company_id em stock
ALTER TABLE public.stock                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES public.companies(id);

-- migration 026: surcharge_amount em sales
ALTER TABLE public.sales                ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- migration 028: updated_by em cashback_config
ALTER TABLE public.cashback_config      ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES public.users(id);

-- migration 031: external_variant_id em produto_map
ALTER TABLE public.produto_map          ADD COLUMN IF NOT EXISTS external_variant_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_map_variant
  ON public.produto_map (source, external_variant_id)
  WHERE external_variant_id IS NOT NULL;

-- cashback_config: índice parcial por empresa (depende de company_id existir)
DROP INDEX IF EXISTS cashback_config_single_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_config_company_active
  ON public.cashback_config (company_id)
  WHERE active = true;

-- =============================================================================
-- 27. ÍNDICES
-- (todos após ALTER TABLE para garantir que colunas existem)
-- =============================================================================

-- stock_movements
CREATE INDEX IF NOT EXISTS idx_stock_mv_variation
  ON public.stock_movements (product_variation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_company
  ON public.stock_movements (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_company_type
  ON public.stock_movements (company_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mv_reference
  ON public.stock_movements (reference_id)
  WHERE reference_id IS NOT NULL;

-- products
CREATE INDEX IF NOT EXISTS idx_products_sku        ON public.products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category   ON public.products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_company    ON public.products(company_id);
CREATE INDEX IF NOT EXISTS idx_products_active     ON public.products(active) WHERE active = TRUE;

-- product_variations
CREATE INDEX IF NOT EXISTS idx_pv_product_id       ON public.product_variations(product_id);
CREATE INDEX IF NOT EXISTS idx_pv_sku_variation    ON public.product_variations(sku_variation);

-- stock_lots
CREATE INDEX IF NOT EXISTS idx_sl_product_variation ON public.stock_lots(product_variation_id);
CREATE INDEX IF NOT EXISTS idx_sl_entry_date        ON public.stock_lots(entry_date);
CREATE INDEX IF NOT EXISTS idx_sl_remaining         ON public.stock_lots(quantity_remaining) WHERE quantity_remaining > 0;

-- customers
CREATE INDEX IF NOT EXISTS idx_customers_cpf_company ON public.customers(cpf, company_id);
CREATE INDEX IF NOT EXISTS idx_customers_company     ON public.customers(company_id);

-- sales
CREATE INDEX IF NOT EXISTS idx_sales_customer    ON public.sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_company     ON public.sales(company_id);
CREATE INDEX IF NOT EXISTS idx_sales_status      ON public.sales(status);
CREATE INDEX IF NOT EXISTS idx_sales_date        ON public.sales(sale_date);

-- sale_items
CREATE INDEX IF NOT EXISTS idx_si_sale_id           ON public.sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_si_product_variation ON public.sale_items(product_variation_id);

-- cashback
CREATE INDEX IF NOT EXISTS idx_cbt_customer     ON public.cashback_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_cbt_company      ON public.cashback_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_cbt_status       ON public.cashback_transactions(status);

-- finance
CREATE INDEX IF NOT EXISTS idx_fe_company_date  ON public.finance_entries(company_id, reference_date);
CREATE INDEX IF NOT EXISTS idx_fe_sale_id       ON public.finance_entries(sale_id);

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_ts         ON public.audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource   ON public.audit_logs(resource, resource_id);

-- shipping
CREATE INDEX IF NOT EXISTS idx_shipping_origins_company ON public.shipping_origins(company_id);
CREATE INDEX IF NOT EXISTS idx_shipping_zones_company   ON public.shipping_zones(company_id);

-- nuvemshop
CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_pv      ON public.nuvemshop_sync_logs(product_variation_id, created_at DESC) WHERE product_variation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_failures ON public.nuvemshop_sync_logs(created_at DESC) WHERE success = FALSE;

-- =============================================================================
-- 27. RPCs TRANSACIONAIS
--
-- Todas as funções usam SECURITY DEFINER + set_config('app.stock_rpc','1',true)
-- para passar pelo trigger de proteção da tabela stock.
--
-- stock_movements: inserir SEM notes e SEM created_by (não existem na tabela).
--
-- Estratégia anti-deadlock:
--   rpc_create_sale  → pré-lock de todos os pvids em ordem ASC antes de qualquer escrita
--   rpc_cancel_sale  → ORDER BY product_variation_id no cursor de sale_items
--   rpc_return_sale  → idem
-- =============================================================================

-- ─── rpc_stock_initialize ────────────────────────────────────────────────────

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

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
  VALUES (p_product_variation_id, p_quantity, COALESCE(p_avg_cost, 0), NOW(), v_company_id)
  ON CONFLICT (product_variation_id) DO NOTHING;

  -- Registra movimento somente se o INSERT criou linha nova
  IF FOUND AND p_quantity > 0 THEN
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, company_id
    )
    SELECT p_product_variation_id, pv.product_id, 'initial', p_quantity,
           0, p_quantity, p_avg_cost, v_company_id
    FROM product_variations pv WHERE pv.id = p_product_variation_id;
  END IF;
END;
$$;

-- ─── rpc_stock_entry ─────────────────────────────────────────────────────────

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
  v_lot_id          int;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
  v_company_id      int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

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
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type::stock_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
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

  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
  VALUES (p_product_variation_id, v_new_qty, ROUND(v_new_avg_cost, 6), NOW(), v_company_id)
  ON CONFLICT (product_variation_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id
  )
  SELECT p_product_variation_id, pv.product_id, 'entry', p_quantity_original,
         v_prev_qty::int, v_new_qty::int,
         v_cost_per_unit, v_lot_id::text, v_company_id
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

-- ─── rpc_stock_adjust ────────────────────────────────────────────────────────

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
  v_company_id       int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.quantity, s.avg_cost, s.company_id
  INTO v_current_qty, v_current_avg_cost, v_company_id
  FROM stock s WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente. Atual: %, ajuste: %.',
      v_current_qty, p_delta USING ERRCODE = 'P0001';
  END IF;

  UPDATE stock SET quantity = v_new_qty, last_updated = NOW()
  WHERE product_variation_id = p_product_variation_id;

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id
  )
  SELECT p_product_variation_id, pv.product_id, 'adjust', p_delta,
         v_current_qty, v_new_qty,
         v_current_avg_cost, p_reason, v_company_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta
  );
END;
$$;

-- ─── rpc_create_sale (versão real com 12 parâmetros) ─────────────────────────

DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric);
DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric);

CREATE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    text,
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric DEFAULT 0,
  p_surcharge_amount  numeric DEFAULT 0
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Data no fuso de Fortaleza (UTC-3, sem DST)
  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;
  v_card_fee    := GREATEST(0, COALESCE(p_card_fee, 0));
  v_surcharge   := GREATEST(0, COALESCE(p_surcharge_amount, 0));

  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor nao esta associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Validação de empresa + cálculo de subtotal
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

  -- Pré-lock ordenado por pvid (elimina deadlock entre vendas concorrentes)
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    p_payment_method::payment_method,
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id
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

    SELECT quantity INTO v_current_qty FROM stock WHERE product_variation_id = v_pvid;

    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Estoque insuficiente para variacao #%. Disponivel: %, solicitado: %.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock SET quantity = quantity - v_qty, last_updated = NOW()
    WHERE product_variation_id = v_pvid;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, v_company_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
  VALUES ('income', 'sale', 'Venda ' || v_sale_number, v_gross, v_brazil_date, v_sale_id, p_system_user_id, v_company_id);

  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('income', 'cashback_used', 'Cashback — Venda ' || v_sale_number, v_eff_cashback, v_brazil_date, v_sale_id, p_system_user_id, v_company_id);
  END IF;

  IF v_card_fee > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('expense', 'operational', 'Taxa de cartao — Venda ' || v_sale_number, v_card_fee, v_brazil_date, v_sale_id, p_system_user_id, v_company_id);
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- ─── rpc_create_sale (wrapper — compatibilidade com frontend) ─────────────────

DROP FUNCTION IF EXISTS public.rpc_create_sale(boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid);

CREATE FUNCTION public.rpc_create_sale(
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
    p_customer_id, p_seller_id, p_payment_method, p_sale_origin,
    p_discount_amount, p_cashback_used, p_shipping_charged, p_notes,
    p_items, p_system_user_id, 0, p_surcharge_amount
  );
END;
$$;

-- ─── Trigger: atualizar customer_metrics após venda paga ─────────────────────

CREATE OR REPLACE FUNCTION public.update_customer_metrics_on_sale()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.customer_metrics (
    customer_id, total_spent, order_count, avg_ticket, last_purchase_date, updated_at
  )
  VALUES (
    NEW.customer_id, NEW.total, 1, NEW.total, NEW.sale_date, NOW()
  )
  ON CONFLICT (customer_id) DO UPDATE SET
    total_spent        = public.customer_metrics.total_spent + NEW.total,
    order_count        = public.customer_metrics.order_count + 1,
    avg_ticket         = (public.customer_metrics.total_spent + NEW.total)
                         / (public.customer_metrics.order_count + 1),
    last_purchase_date = GREATEST(public.customer_metrics.last_purchase_date, NEW.sale_date),
    updated_at         = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_metrics_sale ON public.sales;
CREATE TRIGGER trg_customer_metrics_sale
  AFTER INSERT ON public.sales
  FOR EACH ROW
  WHEN (NEW.status = 'paid')
  EXECUTE FUNCTION public.update_customer_metrics_on_sale();

-- ─── rpc_cancel_sale ─────────────────────────────────────────────────────────

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
  FROM sales WHERE id = p_sale_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% nao encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% ja foi cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% ja foi devolvida e nao pode ser cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales SET status = 'cancelled', updated_at = NOW() WHERE id = p_sale_id;

  -- ORDER BY product_variation_id: mesma ordem do pré-lock do rpc_create_sale
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW(), v_sale.company_id)
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity = stock.quantity + v_item.quantity, last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
  VALUES (
    'expense', 'other_expense',
    'Cancelamento — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- ─── rpc_return_sale ─────────────────────────────────────────────────────────

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
  FROM sales WHERE id = p_sale_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% nao encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% ja foi devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% esta cancelada e nao pode ser devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales SET status = 'returned', updated_at = NOW() WHERE id = p_sale_id;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
    ORDER BY product_variation_id
  LOOP
    SELECT quantity INTO v_prev_qty
    FROM stock WHERE product_variation_id = v_item.product_variation_id FOR UPDATE;
    IF v_prev_qty IS NULL THEN v_prev_qty := 0; END IF;

    INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated, company_id)
    VALUES (v_item.product_variation_id, v_item.quantity, v_item.unit_cost, NOW(), v_sale.company_id)
    ON CONFLICT (product_variation_id) DO UPDATE
      SET quantity = stock.quantity + v_item.quantity, last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT v_item.product_variation_id, pv.product_id, 'return', v_item.quantity,
           v_prev_qty, v_prev_qty + v_item.quantity,
           v_item.unit_cost, p_sale_id::text, v_sale.company_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
  VALUES (
    'expense', 'other_expense',
    'Devolucao — Venda ' || v_sale.sale_number,
    v_sale.total,
    (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date,
    p_sale_id, p_system_user_id, v_sale.company_id
  );
END;
$$;

-- =============================================================================
-- 28. GRANTS
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_stock_initialize TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_entry      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_stock_adjust     TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sale      TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_sale      TO service_role, authenticated;

GRANT SELECT ON public.mv_stock_status        TO authenticated, service_role;
GRANT SELECT ON public.v_cashback_balance     TO authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- =============================================================================
-- 29. RLS (Row-Level Security)
--
-- O app usa service_role (createAdminClient) que bypassa RLS por design.
-- RLS serve como defense-in-depth para acesso direto ao banco.
-- =============================================================================

ALTER TABLE public.products           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashback_transactions ENABLE ROW LEVEL SECURITY;

-- Política padrão: usuário autenticado só vê dados da própria empresa
DROP POLICY IF EXISTS "products_company" ON public.products;
CREATE POLICY "products_company" ON public.products FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "sales_company" ON public.sales;
CREATE POLICY "sales_company" ON public.sales FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "stock_company" ON public.stock;
CREATE POLICY "stock_company" ON public.stock FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "stock_movements_select" ON public.stock_movements;
CREATE POLICY "stock_movements_select" ON public.stock_movements FOR SELECT TO authenticated
  USING (company_id = public.current_company_id()
         AND public.get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "finance_entries_company" ON public.finance_entries;
CREATE POLICY "finance_entries_company" ON public.finance_entries FOR SELECT TO authenticated
  USING (company_id = public.current_company_id()
         AND public.get_user_role() IN ('admin', 'gerente'));

DROP POLICY IF EXISTS "customers_company" ON public.customers;
CREATE POLICY "customers_company" ON public.customers FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

-- =============================================================================
-- 29.5 MÓDULO DE CAIXA
--      (migrations 20260522_sale_payments + 20260522_cash_register + RPCs)
-- =============================================================================

-- ── Extensão do enum payment_method ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE  enumtypid = 'public.payment_method'::regtype
      AND  enumlabel = 'credit_card'
  ) THEN ALTER TYPE public.payment_method ADD VALUE 'credit_card'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE  enumtypid = 'public.payment_method'::regtype
      AND  enumlabel = 'debit_card'
  ) THEN ALTER TYPE public.payment_method ADD VALUE 'debit_card'; END IF;
END
$$;

-- ── sale_payments ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sale_payments (
  id               BIGSERIAL             PRIMARY KEY,
  sale_id          INT                   NOT NULL REFERENCES public.sales(id)     ON DELETE CASCADE,
  company_id       INT                   NOT NULL REFERENCES public.companies(id),
  method           public.payment_method NOT NULL,
  amount_tendered  NUMERIC(10,2)         NOT NULL,
  change_amount    NUMERIC(10,2)         NOT NULL DEFAULT 0,
  change_method    TEXT,
  net_amount       NUMERIC(10,2)         NOT NULL,
  installments     INT                   NOT NULL DEFAULT 1,
  card_brand       TEXT,
  acquirer         TEXT,
  fee_percentage   NUMERIC(6,4)          NOT NULL DEFAULT 0,
  fee_amount       NUMERIC(10,2)         NOT NULL DEFAULT 0,
  metadata         JSONB                 NOT NULL DEFAULT '{}',
  created_by       UUID                  REFERENCES public.users(id),
  created_at       TIMESTAMPTZ           NOT NULL DEFAULT NOW(),

  CONSTRAINT sp_cash_only_change         CHECK (change_amount = 0 OR method = 'cash'),
  CONSTRAINT sp_change_method_required   CHECK (change_amount = 0 OR change_method IS NOT NULL),
  CONSTRAINT sp_change_method_valid      CHECK (change_method IS NULL OR change_method IN ('cash', 'pix')),
  CONSTRAINT sp_change_nonnegative       CHECK (change_amount >= 0),
  CONSTRAINT sp_amount_tendered_gte      CHECK (amount_tendered >= net_amount),
  CONSTRAINT sp_net_amount_eq            CHECK (ROUND(net_amount,2) = ROUND(amount_tendered - change_amount,2)),
  CONSTRAINT sp_net_amount_positive      CHECK (net_amount > 0),
  CONSTRAINT sp_installments_credit_only CHECK (installments = 1 OR method = 'credit_card'),
  CONSTRAINT sp_installments_positive    CHECK (installments >= 1),
  CONSTRAINT sp_fee_nonnegative          CHECK (fee_amount >= 0 AND fee_percentage >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id
  ON public.sale_payments (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_company_date
  ON public.sale_payments (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sale_payments_method
  ON public.sale_payments (company_id, method, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_dominant_payment_method(p_sale_id int)
RETURNS public.payment_method
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_method public.payment_method;
BEGIN
  SELECT method INTO v_method FROM public.sale_payments
  WHERE  sale_id = p_sale_id ORDER BY net_amount DESC LIMIT 1;
  IF v_method IS NULL THEN
    SELECT payment_method INTO v_method FROM public.sales WHERE id = p_sale_id;
  END IF;
  RETURN v_method;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dominant_payment_method(int) TO service_role, authenticated;

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_payments_company" ON public.sale_payments;
CREATE POLICY "sale_payments_company" ON public.sale_payments FOR SELECT TO authenticated
  USING (company_id = public.current_company_id() AND public.get_user_role() IN ('admin', 'gerente'));

-- ── cash_register_sessions ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_register_sessions (
  id                      BIGSERIAL     PRIMARY KEY,
  company_id              INT           NOT NULL REFERENCES public.companies(id),
  status                  TEXT          NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed')),
  opened_by               UUID          NOT NULL REFERENCES public.users(id),
  opened_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  opening_amount_cash     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (opening_amount_cash >= 0),
  notes_open              TEXT,
  closed_by               UUID          REFERENCES public.users(id),
  closed_at               TIMESTAMPTZ,
  counted_cash            NUMERIC(10,2) CHECK (counted_cash >= 0),
  notes_close             TEXT,
  closing_confirmed_by    UUID          REFERENCES public.users(id),
  total_sales             NUMERIC(10,2),
  total_cash              NUMERIC(10,2),
  total_pix               NUMERIC(10,2),
  total_credit_card       NUMERIC(10,2),
  total_debit_card        NUMERIC(10,2),
  total_card_fees         NUMERIC(10,2),
  total_cash_change       NUMERIC(10,2),
  total_pix_change        NUMERIC(10,2),
  total_sangria           NUMERIC(10,2),
  total_suprimento        NUMERIC(10,2),
  total_expenses          NUMERIC(10,2),
  expected_cash           NUMERIC(10,2),
  cash_difference         NUMERIC(10,2),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT crs_closed_requires_closed_at    CHECK (status = 'open' OR closed_at IS NOT NULL),
  CONSTRAINT crs_closed_requires_counted_cash CHECK (status = 'open' OR counted_cash IS NOT NULL),
  CONSTRAINT crs_closed_by_with_closed_at     CHECK (closed_at IS NULL OR closed_by IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_sessions_one_open_per_company
  ON public.cash_register_sessions (company_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cash_sessions_company_opened
  ON public.cash_register_sessions (company_id, opened_at DESC);

-- ── cash_movements ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cash_movements (
  id                    BIGSERIAL     PRIMARY KEY,
  cash_session_id       BIGINT        NOT NULL REFERENCES public.cash_register_sessions(id),
  company_id            INT           NOT NULL REFERENCES public.companies(id),
  type                  TEXT          NOT NULL CHECK (type IN ('sangria', 'suprimento', 'expense')),
  method                TEXT          NOT NULL DEFAULT 'cash'
                          CHECK (method IN ('cash', 'pix', 'credit_card', 'debit_card')),
  amount                NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  description           TEXT          NOT NULL,
  reference_sale_id     BIGINT        REFERENCES public.sales(id),
  metadata              JSONB         NOT NULL DEFAULT '{}',
  created_by            UUID          NOT NULL REFERENCES public.users(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID          REFERENCES public.users(id),
  cancellation_reason   TEXT,

  CONSTRAINT cm_sangria_suprimento_cash_only
    CHECK (type NOT IN ('sangria', 'suprimento') OR method = 'cash'),
  CONSTRAINT cm_cancel_coherence
    CHECK (cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_session
  ON public.cash_movements (cash_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_active
  ON public.cash_movements (cash_session_id) WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cash_movements_company_date
  ON public.cash_movements (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_movements_reference_sale
  ON public.cash_movements (reference_sale_id) WHERE reference_sale_id IS NOT NULL;

-- ── cash_session_id em sales (nullable) ──────────────────────────────────────

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cash_session_id BIGINT
    REFERENCES public.cash_register_sessions(id);

CREATE INDEX IF NOT EXISTS idx_sales_cash_session
  ON public.sales (cash_session_id) WHERE cash_session_id IS NOT NULL;

-- ── RLS: leitura de caixa (escrita apenas via RPC SECURITY DEFINER) ──────────

ALTER TABLE public.cash_register_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cash_sessions_company_read" ON public.cash_register_sessions;
CREATE POLICY "cash_sessions_company_read" ON public.cash_register_sessions
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "cash_movements_company_read" ON public.cash_movements;
CREATE POLICY "cash_movements_company_read" ON public.cash_movements
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

GRANT SELECT ON public.cash_register_sessions TO authenticated;
GRANT SELECT ON public.cash_movements          TO authenticated;

-- ── rpc_open_cash_session ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_open_cash_session(
  p_user_id             uuid,
  p_opening_amount_cash numeric DEFAULT 0,
  p_notes               text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company_id int; v_session_id bigint; v_opened_at timestamptz;
BEGIN
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não está associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM cash_register_sessions WHERE company_id = v_company_id AND status = 'open') THEN
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO cash_register_sessions (company_id, status, opened_by, opened_at, opening_amount_cash, notes_open)
  VALUES (v_company_id, 'open', p_user_id, NOW(),
          GREATEST(0, COALESCE(p_opening_amount_cash, 0)),
          NULLIF(TRIM(COALESCE(p_notes, '')), ''))
  RETURNING id, opened_at INTO v_session_id, v_opened_at;

  RETURN jsonb_build_object(
    'id', v_session_id,
    'opened_at', v_opened_at,
    'opening_amount_cash', GREATEST(0, COALESCE(p_opening_amount_cash, 0))
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa.' USING ERRCODE = 'P0001';
END;
$$;

-- ── rpc_add_cash_movement ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_add_cash_movement(
  p_session_id        bigint,
  p_user_id           uuid,
  p_type              text,
  p_amount            numeric,
  p_description       text,
  p_method            text    DEFAULT 'cash',
  p_reference_sale_id bigint  DEFAULT NULL,
  p_metadata          jsonb   DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company_id int; v_sess_status text; v_sess_company int;
  v_movement_id bigint; v_created_at timestamptz;
BEGIN
  IF p_type NOT IN ('sangria', 'suprimento', 'expense') THEN
    RAISE EXCEPTION 'Tipo inválido: %. Use sangria, suprimento ou expense.', p_type USING ERRCODE = 'P0001';
  END IF;
  IF p_method NOT IN ('cash', 'pix', 'credit_card', 'debit_card') THEN
    RAISE EXCEPTION 'Método inválido: %.', p_method USING ERRCODE = 'P0001';
  END IF;
  IF p_type IN ('sangria', 'suprimento') AND p_method != 'cash' THEN
    RAISE EXCEPTION 'Sangria e suprimento são sempre em dinheiro físico.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Valor deve ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;
  IF TRIM(COALESCE(p_description, '')) = '' THEN
    RAISE EXCEPTION 'Descrição obrigatória.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT status, company_id INTO v_sess_status, v_sess_company
  FROM cash_register_sessions WHERE id = p_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível registrar movimentos.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sess_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO cash_movements (cash_session_id, company_id, type, method, amount, description,
    reference_sale_id, metadata, created_by)
  VALUES (p_session_id, v_company_id, p_type, p_method, p_amount, TRIM(p_description),
    p_reference_sale_id, COALESCE(p_metadata, '{}'), p_user_id)
  RETURNING id, created_at INTO v_movement_id, v_created_at;

  RETURN jsonb_build_object('id', v_movement_id, 'type', p_type, 'method', p_method,
    'amount', p_amount, 'created_at', v_created_at);
END;
$$;

-- ── rpc_close_cash_session ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_close_cash_session(
  p_session_id   bigint,
  p_user_id      uuid,
  p_counted_cash numeric,
  p_notes        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_company_id        int;
  v_sess              record;
  v_total_sales       numeric := 0;
  v_total_cash        numeric := 0;
  v_total_pix         numeric := 0;
  v_total_credit      numeric := 0;
  v_total_debit       numeric := 0;
  v_total_card_fees   numeric := 0;
  v_total_cash_change numeric := 0;
  v_total_pix_change  numeric := 0;
  v_cash_tendered     numeric := 0;
  v_expense_cash      numeric := 0;
  v_total_sangria     numeric := 0;
  v_total_suprimento  numeric := 0;
  v_total_expenses    numeric := 0;
  v_expected_cash     numeric;
  v_cash_difference   numeric;
BEGIN
  SELECT company_id INTO v_company_id FROM users WHERE id = p_user_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sess FROM cash_register_sessions WHERE id = p_session_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sess.company_id != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sess.status = 'closed' THEN
    RAISE EXCEPTION 'Caixa já fechado.' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_counted_cash, -1) < 0 THEN
    RAISE EXCEPTION 'Valor contado não pode ser negativo.' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    COALESCE(SUM(s.total), 0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'pix'),         0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'cash'),        0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'credit_card'), 0),
    COALESCE(SUM(sp.net_amount) FILTER (WHERE sp.method = 'debit_card'),  0),
    COALESCE(SUM(sp.fee_amount) FILTER (WHERE sp.method IN ('credit_card', 'debit_card')), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method='cash' AND sp.change_method='cash'), 0),
    COALESCE(SUM(sp.change_amount) FILTER (WHERE sp.method='cash' AND sp.change_method='pix'),  0),
    COALESCE(SUM(sp.amount_tendered) FILTER (WHERE sp.method = 'cash'), 0)
  INTO
    v_total_sales, v_total_pix, v_total_cash, v_total_credit, v_total_debit,
    v_total_card_fees, v_total_cash_change, v_total_pix_change, v_cash_tendered
  FROM sales s
  JOIN sale_payments sp ON sp.sale_id = s.id
  WHERE s.cash_session_id = p_session_id
    AND s.status NOT IN ('cancelled', 'returned');

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE type = 'sangria'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'suprimento'),                  0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'),                     0),
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense' AND method = 'cash'), 0)
  INTO v_total_sangria, v_total_suprimento, v_total_expenses, v_expense_cash
  FROM cash_movements
  WHERE cash_session_id = p_session_id AND cancelled_at IS NULL;

  v_expected_cash := ROUND(
    v_sess.opening_amount_cash + v_cash_tendered - v_total_cash_change
    + v_total_suprimento - v_total_sangria - v_expense_cash
  , 2);

  v_cash_difference := ROUND(p_counted_cash - v_expected_cash, 2);

  UPDATE cash_register_sessions
  SET
    status            = 'closed',   closed_by         = p_user_id,
    closed_at         = NOW(),       counted_cash       = p_counted_cash,
    notes_close       = NULLIF(TRIM(COALESCE(p_notes,'')), ''),
    updated_at        = NOW(),
    total_sales       = ROUND(v_total_sales,       2),
    total_cash        = ROUND(v_total_cash,        2),
    total_pix         = ROUND(v_total_pix,         2),
    total_credit_card = ROUND(v_total_credit,      2),
    total_debit_card  = ROUND(v_total_debit,       2),
    total_card_fees   = ROUND(v_total_card_fees,   2),
    total_cash_change = ROUND(v_total_cash_change, 2),
    total_pix_change  = ROUND(v_total_pix_change,  2),
    total_sangria     = ROUND(v_total_sangria,    2),
    total_suprimento  = ROUND(v_total_suprimento, 2),
    total_expenses    = ROUND(v_total_expenses,   2),
    expected_cash     = v_expected_cash,
    cash_difference   = v_cash_difference
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'id', p_session_id, 'status', 'closed', 'closed_at', NOW(),
    'total_sales', ROUND(v_total_sales,2), 'total_cash', ROUND(v_total_cash,2),
    'total_pix', ROUND(v_total_pix,2), 'total_credit_card', ROUND(v_total_credit,2),
    'total_debit_card', ROUND(v_total_debit,2), 'total_card_fees', ROUND(v_total_card_fees,2),
    'total_cash_change', ROUND(v_total_cash_change,2), 'total_pix_change', ROUND(v_total_pix_change,2),
    'total_sangria', ROUND(v_total_sangria,2), 'total_suprimento', ROUND(v_total_suprimento,2),
    'total_expenses', ROUND(v_total_expenses,2),
    'expected_cash', v_expected_cash, 'counted_cash', p_counted_cash,
    'cash_difference', v_cash_difference
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_open_cash_session(uuid, numeric, text)       TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_add_cash_movement(bigint, uuid, text, numeric, text, text, bigint, jsonb) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text) TO service_role, authenticated;

-- =============================================================================
-- 30. CONTROLES DE SEGURANÇA, AUDITORIA E ANTI-FRAUDE
--     (migration 20260602_security_audit_controls)
-- =============================================================================

-- ── 30a. Trigger de auditoria para tabelas de caixa e usuários ───────────────
--
-- Insere em audit_logs usando campos do próprio registro para derivar user_id,
-- sem depender de auth.uid() que pode ser NULL dentro de RPCs SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.audit_cash_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record_id text;
  v_action    text;
  v_user_id   uuid;
BEGIN
  v_record_id := COALESCE(NEW.id::text, OLD.id::text);

  v_action := CASE TG_OP
    WHEN 'INSERT' THEN 'create'
    WHEN 'UPDATE' THEN 'update'
    WHEN 'DELETE' THEN 'delete'
    ELSE TG_OP
  END;

  IF TG_TABLE_NAME = 'cash_register_sessions' THEN
    v_user_id := CASE
      WHEN TG_OP = 'DELETE'                           THEN OLD.opened_by
      WHEN TG_OP = 'UPDATE' AND NEW.status = 'closed' THEN NEW.closed_by
      ELSE NEW.opened_by
    END;
  ELSIF TG_TABLE_NAME = 'cash_movements' THEN
    v_user_id := CASE
      WHEN TG_OP = 'UPDATE' AND NEW.cancelled_at IS NOT NULL THEN NEW.cancelled_by
      WHEN TG_OP = 'DELETE'                                  THEN OLD.created_by
      ELSE NEW.created_by
    END;
  ELSIF TG_TABLE_NAME = 'users' THEN
    v_user_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_user_id := auth.uid();
  END IF;

  INSERT INTO public.audit_logs (
    ts, user_id, user_role, action, resource, resource_id, before_data, after_data
  )
  VALUES (
    NOW(),
    v_user_id,
    (SELECT role::text FROM public.users WHERE id = v_user_id),
    v_action,
    TG_TABLE_NAME,
    v_record_id,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_cash_sessions ON public.cash_register_sessions;
CREATE TRIGGER trg_audit_cash_sessions
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION public.audit_cash_trigger();

DROP TRIGGER IF EXISTS trg_audit_cash_movements ON public.cash_movements;
CREATE TRIGGER trg_audit_cash_movements
  AFTER INSERT OR UPDATE OR DELETE ON public.cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.audit_cash_trigger();

DROP TRIGGER IF EXISTS trg_audit_users_role ON public.users;
CREATE TRIGGER trg_audit_users_role
  AFTER UPDATE ON public.users
  FOR EACH ROW
  WHEN (
    OLD.role IS DISTINCT FROM NEW.role
    OR OLD.active IS DISTINCT FROM NEW.active
  )
  EXECUTE FUNCTION public.audit_cash_trigger();

-- ── 30b. rpc_cancel_cash_movement — sangria/suprimento exigem gerente/admin ──

CREATE OR REPLACE FUNCTION public.rpc_cancel_cash_movement(
  p_movement_id         bigint,
  p_user_id             uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id  int;
  v_user_role   text;
  v_movement    record;
BEGIN
  IF TRIM(COALESCE(p_cancellation_reason, '')) = '' THEN
    RAISE EXCEPTION 'Motivo de cancelamento obrigatório.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id, role INTO v_company_id, v_user_role FROM users WHERE id = p_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    cm.id, cm.type, cm.created_by, cm.cancelled_at,
    crs.status AS session_status, crs.company_id AS session_company
  INTO v_movement
  FROM cash_movements cm
  JOIN cash_register_sessions crs ON crs.id = cm.cash_session_id
  WHERE cm.id = p_movement_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimento #% não encontrado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.session_company != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.session_status = 'closed' THEN
    RAISE EXCEPTION 'Caixa fechado. Não é possível cancelar movimentos.' USING ERRCODE = 'P0001';
  END IF;

  IF v_movement.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Movimento #% já foi cancelado.', p_movement_id USING ERRCODE = 'P0001';
  END IF;

  -- sangria/suprimento: apenas gerente ou admin
  IF v_movement.type IN ('sangria', 'suprimento') THEN
    IF v_user_role NOT IN ('gerente', 'admin') THEN
      RAISE EXCEPTION 'Cancelamento de sangria/suprimento exige gerente ou administrador.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_movement.created_by != p_user_id AND v_user_role NOT IN ('gerente', 'admin') THEN
      RAISE EXCEPTION 'Apenas o criador da despesa ou gerente/admin podem cancelar.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE cash_movements
  SET cancelled_at = NOW(), cancelled_by = p_user_id,
      cancellation_reason = TRIM(p_cancellation_reason)
  WHERE id = p_movement_id;

  RETURN jsonb_build_object(
    'id',                  p_movement_id,
    'type',                v_movement.type,
    'cancelled_at',        NOW(),
    'cancellation_reason', TRIM(p_cancellation_reason)
  );
END;
$$;

-- ── 30c. rpc_reopen_cash_session — apenas admin, com log obrigatório ─────────

CREATE OR REPLACE FUNCTION public.rpc_reopen_cash_session(
  p_session_id bigint,
  p_user_id    uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id int;
  v_user_role  text;
  v_sess       record;
BEGIN
  IF TRIM(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Motivo de reabertura obrigatório.' USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id, role INTO v_company_id, v_user_role FROM users WHERE id = p_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF v_user_role != 'admin' THEN
    RAISE EXCEPTION 'Apenas administradores podem reabrir um caixa fechado.'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM cash_register_sessions
    WHERE company_id = v_company_id AND status = 'open'
  ) THEN
    RAISE EXCEPTION 'Já existe um caixa aberto para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_sess FROM cash_register_sessions WHERE id = p_session_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sessão de caixa #% não encontrada.', p_session_id USING ERRCODE = 'P0001';
  END IF;

  IF v_sess.company_id != v_company_id THEN
    RAISE EXCEPTION 'Acesso negado à sessão de caixa.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sess.status = 'open' THEN
    RAISE EXCEPTION 'Esta sessão de caixa já está aberta.' USING ERRCODE = 'P0001';
  END IF;

  -- Log com snapshot do estado fechado antes de limpar
  INSERT INTO public.audit_logs (
    ts, user_id, user_role, action, resource, resource_id, before_data, after_data, detail
  )
  VALUES (
    NOW(), p_user_id, v_user_role,
    'reopen_cash', 'cash_register_sessions', p_session_id::text,
    to_jsonb(v_sess), NULL, TRIM(p_reason)
  );

  UPDATE cash_register_sessions
  SET
    status               = 'open',
    closed_by            = NULL, closed_at           = NULL,
    counted_cash         = NULL, notes_close         = NULL,
    closing_confirmed_by = NULL,
    total_sales          = NULL, total_cash          = NULL,
    total_pix            = NULL, total_credit_card   = NULL,
    total_debit_card     = NULL, total_card_fees     = NULL,
    total_cash_change    = NULL, total_pix_change    = NULL,
    total_sangria        = NULL, total_suprimento    = NULL,
    total_expenses       = NULL, expected_cash       = NULL,
    cash_difference      = NULL, updated_at          = NOW()
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'id',          p_session_id,
    'status',      'open',
    'reopened_at', NOW(),
    'reopened_by', p_user_id,
    'reason',      TRIM(p_reason)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_reopen_cash_session(bigint, uuid, text)
  TO service_role, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_cancel_cash_movement(bigint, uuid, text)
  TO service_role, authenticated;

-- ── 30d. RLS — bloquear escrita direta em tabelas de caixa ───────────────────
--
-- Todas as escritas legítimas passam por RPCs SECURITY DEFINER.
-- Sem policies de INSERT/UPDATE/DELETE para authenticated = bloqueado.

DROP POLICY IF EXISTS "cash_sessions_insert"        ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_update"        ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_delete"        ON public.cash_register_sessions;
DROP POLICY IF EXISTS "cash_sessions_company_write" ON public.cash_register_sessions;

DROP POLICY IF EXISTS "cash_movements_insert"        ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_update"        ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_delete"        ON public.cash_movements;
DROP POLICY IF EXISTS "cash_movements_company_write" ON public.cash_movements;

-- ── 30e. RLS — imutabilidade de audit_logs ───────────────────────────────────
--
-- Sem policies de UPDATE/DELETE = bloqueado para authenticated.
-- INSERT somente via service_role (RPCs SECURITY DEFINER + app server-side).

DROP POLICY IF EXISTS "audit_logs_insert" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_update" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_delete" ON public.audit_logs;

-- ── 30f. View de relatório de auditoria ──────────────────────────────────────

CREATE OR REPLACE VIEW public.v_audit_report AS
SELECT
  al.id, al.ts,
  al.user_id, u.name AS user_name,
  al.user_role, al.action, al.resource, al.resource_id,
  al.before_data, al.after_data, al.detail,
  al.ip_address, al.request_id
FROM  public.audit_logs al
LEFT  JOIN public.users u ON u.id = al.user_id
ORDER BY al.ts DESC;

GRANT SELECT ON public.v_audit_report TO authenticated;

-- =============================================================================
-- FIM DO SCHEMA COMPLETO
-- =============================================================================
