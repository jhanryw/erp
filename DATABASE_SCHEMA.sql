-- =============================================================================
-- SANTTORINI ERP — DATABASE SCHEMA
-- PostgreSQL via Supabase
-- Versão: 1.0
-- =============================================================================

-- =============================================================================
-- MIGRATION 001: ENUMS
-- =============================================================================

CREATE TYPE user_role AS ENUM ('admin', 'seller');

CREATE TYPE product_origin AS ENUM ('own_brand', 'third_party');

CREATE TYPE stock_entry_type AS ENUM ('purchase', 'own_production');

CREATE TYPE payment_method AS ENUM ('pix', 'card', 'cash');

CREATE TYPE sale_status AS ENUM (
  'pending',    -- aguardando pagamento
  'paid',       -- pago
  'shipped',    -- enviado
  'delivered',  -- entregue
  'cancelled',  -- cancelado
  'returned'    -- devolvido
);

CREATE TYPE customer_origin AS ENUM (
  'instagram',
  'referral',
  'paid_traffic',
  'website',
  'store',
  'other'
);

CREATE TYPE marketing_category AS ENUM (
  'paid_traffic',
  'influencers',
  'events',
  'photos',
  'gifts',
  'packaging',
  'rent',
  'salaries',
  'operational',
  'taxes',
  'other'
);

CREATE TYPE cashback_transaction_type AS ENUM (
  'earn',    -- acumulou na compra
  'release', -- liberado após 30 dias
  'use',     -- usado em venda
  'expire',  -- expirado
  'reverse'  -- estornado por devolução
);

CREATE TYPE cashback_status AS ENUM (
  'pending',   -- aguardando liberação
  'available', -- disponível para uso
  'used',      -- utilizado
  'expired',   -- expirado
  'reversed'   -- estornado
);

CREATE TYPE finance_entry_type AS ENUM ('income', 'expense');

CREATE TYPE finance_category AS ENUM (
  -- receitas
  'sale',
  'cashback_used',
  'other_income',
  -- despesas
  'stock_purchase',
  'freight_cost',
  'marketing',
  'rent',
  'salaries',
  'operational',
  'taxes',
  'other_expense'
);

CREATE TYPE return_type AS ENUM ('return', 'exchange');

CREATE TYPE return_status AS ENUM ('pending', 'processed', 'rejected');

CREATE TYPE abc_curve AS ENUM ('A', 'B', 'C');

CREATE TYPE rfm_segment AS ENUM (
  'champions',
  'loyal',
  'potential_loyal',
  'new_customers',
  'promising',
  'at_risk',
  'cant_lose',
  'hibernating',
  'lost'
);

-- =============================================================================
-- MIGRATION 002: CORE TABLES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- USERS (extensão do auth.users do Supabase)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  role        user_role   NOT NULL DEFAULT 'seller',
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- PARAMETERS (configurações globais do sistema)
-- -----------------------------------------------------------------------------
CREATE TABLE parameters (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID        REFERENCES users(id)
);

-- Valores iniciais (via seed)
-- INSERT INTO parameters VALUES
--   ('cashback_rate', '5', 'Percentual de cashback sobre valor líquido'),
--   ('cashback_release_days', '30', 'Dias para liberar cashback'),
--   ('cashback_expiry_days', '180', 'Dias para expirar cashback após liberação'),
--   ('cashback_min_use_value', '10.00', 'Valor mínimo para usar cashback'),
--   ('cashback_min_order_for_earn', '0', 'Valor mínimo de compra para ganhar cashback'),
--   ('stock_min_alert_qty', '3', 'Qtd mínima para alerta de estoque');

-- -----------------------------------------------------------------------------
-- CATEGORIES (hierárquica: categoria → subcategoria)
-- -----------------------------------------------------------------------------
CREATE TABLE categories (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  parent_id   INT         REFERENCES categories(id) ON DELETE SET NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Categorias iniciais (via seed):
-- calcinha, conjunto, sutiã com bojo, sutiã sem bojo, sutiã adesivo,
-- sutiã de silicone, camisola, pijama americano, pijama rendado

-- -----------------------------------------------------------------------------
-- COLLECTIONS (coleções/estações)
-- -----------------------------------------------------------------------------
CREATE TABLE collections (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  season      TEXT,       -- Verão, Inverno, Outono, Primavera
  year        SMALLINT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- VARIATION_TYPES (tipos: cor, tamanho, modelo, tecido)
-- -----------------------------------------------------------------------------
CREATE TABLE variation_types (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL UNIQUE,
  active      BOOLEAN     NOT NULL DEFAULT TRUE
);

-- Seed: cor, tamanho, modelo, tecido

-- -----------------------------------------------------------------------------
-- VARIATION_VALUES (valores: Rosa, P, Triangular, Microfibra, etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE variation_values (
  id                SERIAL      PRIMARY KEY,
  variation_type_id INT         NOT NULL REFERENCES variation_types(id) ON DELETE CASCADE,
  value             TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  UNIQUE (variation_type_id, slug)
);

-- -----------------------------------------------------------------------------
-- SUPPLIERS
-- -----------------------------------------------------------------------------
CREATE TABLE suppliers (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,
  document    TEXT        UNIQUE,  -- CPF ou CNPJ (sem formatação)
  phone       TEXT,
  city        TEXT,
  state       CHAR(2),
  notes       TEXT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MIGRATION 003: PRODUCTS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PRODUCTS
-- -----------------------------------------------------------------------------
CREATE TABLE products (
  id              SERIAL          PRIMARY KEY,
  name            TEXT            NOT NULL,
  sku             TEXT            NOT NULL UNIQUE,
  category_id     INT             NOT NULL REFERENCES categories(id),
  subcategory_id  INT             REFERENCES categories(id),
  collection_id   INT             REFERENCES collections(id),
  supplier_id     INT             REFERENCES suppliers(id),
  origin          product_origin  NOT NULL DEFAULT 'third_party',
  base_cost       NUMERIC(10,2)   NOT NULL DEFAULT 0,
  base_price      NUMERIC(10,2)   NOT NULL,
  photo_url       TEXT,
  active          BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT products_price_positive CHECK (base_price > 0),
  CONSTRAINT products_cost_non_negative CHECK (base_cost >= 0)
);

-- Margem calculada: ((base_price - base_cost) / base_price) * 100
-- Coluna gerada para consulta rápida:
ALTER TABLE products ADD COLUMN margin_pct NUMERIC(5,2)
  GENERATED ALWAYS AS (
    CASE WHEN base_price > 0
    THEN ROUND(((base_price - base_cost) / base_price) * 100, 2)
    ELSE 0 END
  ) STORED;

ALTER TABLE products ADD COLUMN markup_pct NUMERIC(5,2)
  GENERATED ALWAYS AS (
    CASE WHEN base_cost > 0
    THEN ROUND(((base_price - base_cost) / base_cost) * 100, 2)
    ELSE NULL END
  ) STORED;

-- -----------------------------------------------------------------------------
-- PRODUCT_VARIATIONS (SKU por combinação de variações)
-- -----------------------------------------------------------------------------
CREATE TABLE product_variations (
  id              SERIAL        PRIMARY KEY,
  product_id      INT           NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_variation   TEXT          NOT NULL UNIQUE,
  cost_override   NUMERIC(10,2),  -- NULL = usar base_cost do produto
  price_override  NUMERIC(10,2),  -- NULL = usar base_price do produto
  photo_url       TEXT,
  active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- PRODUCT_VARIATION_ATTRIBUTES (tabela N:N variação ↔ valor)
-- -----------------------------------------------------------------------------
CREATE TABLE product_variation_attributes (
  product_variation_id  INT NOT NULL REFERENCES product_variations(id) ON DELETE CASCADE,
  variation_type_id     INT NOT NULL REFERENCES variation_types(id),
  variation_value_id    INT NOT NULL REFERENCES variation_values(id),
  PRIMARY KEY (product_variation_id, variation_type_id)
);

-- =============================================================================
-- MIGRATION 004: STOCK
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STOCK_LOTS (lotes de entrada — imutável após criação)
-- -----------------------------------------------------------------------------
CREATE TABLE stock_lots (
  id                    SERIAL            PRIMARY KEY,
  product_variation_id  INT               NOT NULL REFERENCES product_variations(id),
  supplier_id           INT               REFERENCES suppliers(id),       -- NULL para produção própria
  entry_type            stock_entry_type  NOT NULL,
  quantity_original     INT               NOT NULL,
  quantity_remaining    INT               NOT NULL,  -- decrementado nas saídas (FIFO)
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
  created_by            UUID              NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ       NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_lots_qty_positive CHECK (quantity_original > 0),
  CONSTRAINT stock_lots_qty_remaining_valid CHECK (quantity_remaining >= 0 AND quantity_remaining <= quantity_original)
);

-- -----------------------------------------------------------------------------
-- STOCK (posição atual por variação — tabela de controle)
-- -----------------------------------------------------------------------------
CREATE TABLE stock (
  product_variation_id  INT             PRIMARY KEY REFERENCES product_variations(id),
  quantity              INT             NOT NULL DEFAULT 0,
  avg_cost              NUMERIC(10,4)   NOT NULL DEFAULT 0,
  last_updated          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_qty_non_negative CHECK (quantity >= 0)
);

-- =============================================================================
-- MIGRATION 005: CUSTOMERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CUSTOMERS
-- -----------------------------------------------------------------------------
CREATE TABLE customers (
  id            SERIAL          PRIMARY KEY,
  cpf           TEXT            NOT NULL UNIQUE,   -- sem formatação, apenas dígitos
  name          TEXT            NOT NULL,
  phone         TEXT            NOT NULL,
  birth_date    DATE,
  city          TEXT,
  state         CHAR(2),
  origin        customer_origin,
  notes         TEXT,
  active        BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  created_by    UUID            NOT NULL REFERENCES users(id),

  CONSTRAINT customers_cpf_format CHECK (cpf ~ '^\d{11}$')
);

-- -----------------------------------------------------------------------------
-- CUSTOMER_PREFERENCES
-- -----------------------------------------------------------------------------
CREATE TABLE customer_preferences (
  customer_id   INT   PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  sizes         TEXT[],       -- array de tamanhos preferidos
  colors        TEXT[],       -- array de cores preferidas
  categories    INT[],        -- array de category_ids
  notes         TEXT,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- CUSTOMER_METRICS (desnormalizado, atualizado via trigger ou job)
-- -----------------------------------------------------------------------------
CREATE TABLE customer_metrics (
  customer_id         INT             PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  total_spent         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  order_count         INT             NOT NULL DEFAULT 0,
  avg_ticket          NUMERIC(10,2)   NOT NULL DEFAULT 0,
  last_purchase_date  DATE,
  rfm_r_score         SMALLINT        CHECK (rfm_r_score BETWEEN 1 AND 5),
  rfm_f_score         SMALLINT        CHECK (rfm_f_score BETWEEN 1 AND 5),
  rfm_m_score         SMALLINT        CHECK (rfm_m_score BETWEEN 1 AND 5),
  rfm_segment         rfm_segment,
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MIGRATION 006: SALES
-- =============================================================================

-- -----------------------------------------------------------------------------
-- SALES
-- -----------------------------------------------------------------------------
CREATE TABLE sales (
  id                SERIAL          PRIMARY KEY,
  sale_number       TEXT            NOT NULL UNIQUE, -- gerado: SNT-YYYYMMDD-NNNN
  customer_id       INT             NOT NULL REFERENCES customers(id),
  seller_id         UUID            NOT NULL REFERENCES users(id),
  status            sale_status     NOT NULL DEFAULT 'pending',
  subtotal          NUMERIC(10,2)   NOT NULL DEFAULT 0,    -- soma bruta dos itens
  discount_amount   NUMERIC(10,2)   NOT NULL DEFAULT 0,
  discount_pct      NUMERIC(5,2),                          -- informativo
  cashback_used     NUMERIC(10,2)   NOT NULL DEFAULT 0,
  shipping_charged  NUMERIC(10,2)   NOT NULL DEFAULT 0,    -- frete cobrado do cliente
  total             NUMERIC(10,2)   NOT NULL DEFAULT 0,    -- subtotal - desconto - cashback_used + shipping_charged
  payment_method    payment_method  NOT NULL,
  sale_origin       customer_origin,
  notes             TEXT,
  sale_date         DATE            NOT NULL DEFAULT CURRENT_DATE,
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  CONSTRAINT sales_total_non_negative CHECK (total >= 0),
  CONSTRAINT sales_discount_valid CHECK (discount_amount >= 0 AND discount_amount <= subtotal),
  CONSTRAINT sales_cashback_valid CHECK (cashback_used >= 0)
);

-- -----------------------------------------------------------------------------
-- SALE_ITEMS
-- -----------------------------------------------------------------------------
CREATE TABLE sale_items (
  id                    SERIAL        PRIMARY KEY,
  sale_id               INT           NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_variation_id  INT           NOT NULL REFERENCES product_variations(id),
  stock_lot_id          INT           REFERENCES stock_lots(id),  -- lote consumido (FIFO)
  quantity              INT           NOT NULL,
  unit_price            NUMERIC(10,2) NOT NULL,   -- preço no momento da venda
  unit_cost             NUMERIC(10,4) NOT NULL,   -- custo do lote consumido
  discount_amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_price           NUMERIC(10,2) NOT NULL,   -- (unit_price * quantity) - discount_amount
  gross_profit          NUMERIC(10,2) GENERATED ALWAYS AS (
                          total_price - (unit_cost * quantity)
                        ) STORED,

  CONSTRAINT sale_items_qty_positive CHECK (quantity > 0),
  CONSTRAINT sale_items_price_positive CHECK (unit_price > 0)
);

-- -----------------------------------------------------------------------------
-- SALE_SHIPPING (frete separado para controle de custo real)
-- -----------------------------------------------------------------------------
CREATE TABLE sale_shipping (
  id                SERIAL        PRIMARY KEY,
  sale_id           INT           NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  charged_amount    NUMERIC(10,2) NOT NULL DEFAULT 0,   -- cobrado do cliente
  actual_cost       NUMERIC(10,2),                       -- custo real pago pela empresa
  carrier           TEXT,
  tracking_code     TEXT,
  shipped_at        TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ                          -- quando a empresa pagou o frete
);

-- =============================================================================
-- MIGRATION 007: RETURNS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RETURNS (devoluções e trocas)
-- -----------------------------------------------------------------------------
CREATE TABLE returns (
  id              SERIAL        PRIMARY KEY,
  sale_id         INT           NOT NULL REFERENCES sales(id),
  type            return_type   NOT NULL,
  reason          TEXT,
  status          return_status NOT NULL DEFAULT 'pending',
  total_refunded  NUMERIC(10,2) NOT NULL DEFAULT 0,
  processed_at    TIMESTAMPTZ,
  processed_by    UUID          REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      UUID          NOT NULL REFERENCES users(id)
);

-- -----------------------------------------------------------------------------
-- RETURN_ITEMS
-- -----------------------------------------------------------------------------
CREATE TABLE return_items (
  id                    SERIAL    PRIMARY KEY,
  return_id             INT       NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  sale_item_id          INT       NOT NULL REFERENCES sale_items(id),
  quantity              INT       NOT NULL,
  reason                TEXT,
  restocked             BOOLEAN   NOT NULL DEFAULT FALSE,
  restocked_lot_id      INT       REFERENCES stock_lots(id),   -- lote gerado na reposição
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT return_items_qty_positive CHECK (quantity > 0)
);

-- =============================================================================
-- MIGRATION 008: CASHBACK
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CASHBACK_CONFIG (configuração ativa — apenas 1 linha active=true)
-- -----------------------------------------------------------------------------
CREATE TABLE cashback_config (
  id                SERIAL        PRIMARY KEY,
  rate_pct          NUMERIC(5,2)  NOT NULL,         -- % sobre valor líquido
  min_order_value   NUMERIC(10,2) NOT NULL DEFAULT 0,
  release_days      INT           NOT NULL DEFAULT 30,
  expiry_days       INT           NOT NULL DEFAULT 180,
  min_use_value     NUMERIC(10,2) NOT NULL DEFAULT 10,
  active            BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by        UUID          REFERENCES users(id),

  CONSTRAINT cashback_config_rate_valid CHECK (rate_pct > 0 AND rate_pct <= 100),
  CONSTRAINT cashback_config_one_active UNIQUE (active) -- garante 1 config ativa
);

-- -----------------------------------------------------------------------------
-- CASHBACK_TRANSACTIONS
-- -----------------------------------------------------------------------------
CREATE TABLE cashback_transactions (
  id                SERIAL                    PRIMARY KEY,
  customer_id       INT                       NOT NULL REFERENCES customers(id),
  sale_id           INT                       REFERENCES sales(id),
  type              cashback_transaction_type NOT NULL,
  amount            NUMERIC(10,2)             NOT NULL,
  status            cashback_status           NOT NULL DEFAULT 'pending',
  release_date      DATE,         -- data de liberação (earn → pending → available)
  expiry_date       DATE,         -- data de expiração
  used_at           TIMESTAMPTZ,
  used_in_sale_id   INT           REFERENCES sales(id),
  reverse_reason    TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT cashback_amount_positive CHECK (amount > 0)
);

-- View de saldo por cliente (consultada frequentemente)
CREATE VIEW v_cashback_balance AS
SELECT
  customer_id,
  SUM(CASE WHEN type = 'earn' AND status = 'pending'   THEN amount ELSE 0 END) AS pending_balance,
  SUM(CASE WHEN type = 'earn' AND status = 'available' THEN amount ELSE 0 END) AS available_balance,
  SUM(CASE WHEN type = 'use'                            THEN amount ELSE 0 END) AS total_used,
  SUM(CASE WHEN type = 'expire'                         THEN amount ELSE 0 END) AS total_expired,
  SUM(CASE WHEN type = 'reverse'                        THEN amount ELSE 0 END) AS total_reversed
FROM cashback_transactions
GROUP BY customer_id;

-- =============================================================================
-- MIGRATION 009: MARKETING & FINANCE
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CAMPAIGNS
-- -----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id          SERIAL        PRIMARY KEY,
  name        TEXT          NOT NULL,
  channel     TEXT          NOT NULL,   -- instagram, google, tiktok, etc.
  start_date  DATE,
  end_date    DATE,
  budget      NUMERIC(10,2),
  objective   TEXT,
  notes       TEXT,
  active      BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by  UUID          NOT NULL REFERENCES users(id)
);

-- -----------------------------------------------------------------------------
-- MARKETING_COSTS
-- -----------------------------------------------------------------------------
CREATE TABLE marketing_costs (
  id              SERIAL              PRIMARY KEY,
  category        marketing_category  NOT NULL,
  description     TEXT                NOT NULL,
  amount          NUMERIC(10,2)       NOT NULL,
  cost_date       DATE                NOT NULL DEFAULT CURRENT_DATE,
  campaign_id     INT                 REFERENCES campaigns(id),
  is_recurring    BOOLEAN             NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  created_by      UUID                NOT NULL REFERENCES users(id),

  CONSTRAINT marketing_costs_amount_positive CHECK (amount > 0)
);

-- -----------------------------------------------------------------------------
-- FINANCE_ENTRIES (razão contábil — regime de competência)
-- -----------------------------------------------------------------------------
CREATE TABLE finance_entries (
  id                  SERIAL                PRIMARY KEY,
  type                finance_entry_type    NOT NULL,
  category            finance_category      NOT NULL,
  description         TEXT                  NOT NULL,
  amount              NUMERIC(12,2)         NOT NULL,
  reference_date      DATE                  NOT NULL,  -- data de competência
  sale_id             INT                   REFERENCES sales(id),
  stock_lot_id        INT                   REFERENCES stock_lots(id),
  marketing_cost_id   INT                   REFERENCES marketing_costs(id),
  return_id           INT                   REFERENCES returns(id),
  notes               TEXT,
  created_at          TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  created_by          UUID                  NOT NULL REFERENCES users(id),

  CONSTRAINT finance_entries_amount_positive CHECK (amount > 0)
);

-- =============================================================================
-- MIGRATION 010: AUDIT LOG
-- =============================================================================

CREATE TABLE audit_log (
  id          BIGSERIAL     PRIMARY KEY,
  table_name  TEXT          NOT NULL,
  record_id   TEXT          NOT NULL,
  action      TEXT          NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data    JSONB,
  new_data    JSONB,
  user_id     UUID          REFERENCES users(id),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- MIGRATION 011: INDEXES
-- =============================================================================

-- products
CREATE INDEX idx_products_sku             ON products(sku);
CREATE INDEX idx_products_category        ON products(category_id);
CREATE INDEX idx_products_supplier        ON products(supplier_id);
CREATE INDEX idx_products_active          ON products(active) WHERE active = TRUE;
CREATE INDEX idx_products_collection      ON products(collection_id);

-- product_variations
CREATE INDEX idx_pv_product_id            ON product_variations(product_id);
CREATE INDEX idx_pv_sku_variation         ON product_variations(sku_variation);
CREATE INDEX idx_pva_variation_value      ON product_variation_attributes(variation_value_id);

-- stock_lots
CREATE INDEX idx_sl_product_variation     ON stock_lots(product_variation_id);
CREATE INDEX idx_sl_entry_date            ON stock_lots(entry_date);
CREATE INDEX idx_sl_supplier              ON stock_lots(supplier_id);
CREATE INDEX idx_sl_remaining             ON stock_lots(quantity_remaining) WHERE quantity_remaining > 0;

-- customers
CREATE INDEX idx_customers_cpf            ON customers(cpf);
CREATE INDEX idx_customers_phone          ON customers(phone);
CREATE INDEX idx_customers_origin         ON customers(origin);
CREATE INDEX idx_customers_city           ON customers(city);

-- sales
CREATE INDEX idx_sales_customer           ON sales(customer_id);
CREATE INDEX idx_sales_seller             ON sales(seller_id);
CREATE INDEX idx_sales_status             ON sales(status);
CREATE INDEX idx_sales_date               ON sales(sale_date);
CREATE INDEX idx_sales_created_at         ON sales(created_at);
CREATE INDEX idx_sales_origin             ON sales(sale_origin);

-- sale_items
CREATE INDEX idx_si_sale_id               ON sale_items(sale_id);
CREATE INDEX idx_si_product_variation     ON sale_items(product_variation_id);
CREATE INDEX idx_si_stock_lot             ON sale_items(stock_lot_id);

-- cashback
CREATE INDEX idx_cbt_customer             ON cashback_transactions(customer_id);
CREATE INDEX idx_cbt_status               ON cashback_transactions(status);
CREATE INDEX idx_cbt_release_date         ON cashback_transactions(release_date);
CREATE INDEX idx_cbt_expiry_date          ON cashback_transactions(expiry_date);

-- finance
CREATE INDEX idx_fe_reference_date        ON finance_entries(reference_date);
CREATE INDEX idx_fe_type_category         ON finance_entries(type, category);
CREATE INDEX idx_fe_sale_id               ON finance_entries(sale_id);

-- marketing
CREATE INDEX idx_mc_cost_date             ON marketing_costs(cost_date);
CREATE INDEX idx_mc_category              ON marketing_costs(category);

-- audit
CREATE INDEX idx_audit_table_record       ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_created_at         ON audit_log(created_at);

-- =============================================================================
-- MIGRATION 012: MATERIALIZED VIEWS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- mv_daily_sales_summary (refresh: hourly)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_daily_sales_summary AS
SELECT
  s.sale_date,
  COUNT(DISTINCT s.id)                                    AS total_orders,
  COUNT(DISTINCT s.customer_id)                           AS unique_customers,
  SUM(s.total)                                            AS gross_revenue,
  SUM(s.discount_amount)                                  AS total_discounts,
  SUM(s.cashback_used)                                    AS total_cashback_used,
  SUM(s.shipping_charged)                                 AS total_shipping_charged,
  SUM(si.gross_profit)                                    AS gross_profit,
  AVG(s.total)                                            AS avg_ticket,
  COUNT(DISTINCT s.id) FILTER (WHERE s.status = 'cancelled') AS cancelled_orders
FROM sales s
JOIN sale_items si ON si.sale_id = s.id
WHERE s.status NOT IN ('cancelled', 'returned')
GROUP BY s.sale_date;

CREATE UNIQUE INDEX ON mv_daily_sales_summary(sale_date);

-- -----------------------------------------------------------------------------
-- mv_product_performance (refresh: every 6h)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_product_performance AS
SELECT
  p.id                        AS product_id,
  p.name                      AS product_name,
  p.sku,
  p.category_id,
  p.supplier_id,
  p.base_cost,
  p.base_price,
  p.margin_pct,
  SUM(si.quantity)            AS total_units_sold,
  SUM(si.total_price)         AS total_revenue,
  SUM(si.gross_profit)        AS total_gross_profit,
  SUM(si.quantity * si.unit_cost) AS total_cost,
  AVG(si.unit_price)          AS avg_selling_price,
  ROUND(
    CASE WHEN SUM(si.total_price) > 0
    THEN SUM(si.gross_profit) / SUM(si.total_price) * 100
    ELSE 0 END, 2
  )                           AS realized_margin_pct,
  MIN(s.sale_date)            AS first_sale_date,
  MAX(s.sale_date)            AS last_sale_date
FROM products p
JOIN product_variations pv ON pv.product_id = p.id
LEFT JOIN sale_items si ON si.product_variation_id = pv.id
LEFT JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
GROUP BY p.id, p.name, p.sku, p.category_id, p.supplier_id, p.base_cost, p.base_price, p.margin_pct;

CREATE UNIQUE INDEX ON mv_product_performance(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_revenue (refresh: every 6h)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_abc_by_revenue AS
WITH ranked AS (
  SELECT
    product_id,
    total_revenue,
    SUM(total_revenue) OVER () AS grand_total,
    SUM(total_revenue) OVER (ORDER BY total_revenue DESC ROWS UNBOUNDED PRECEDING) AS cumulative_revenue
  FROM mv_product_performance
  WHERE total_revenue > 0
),
pct AS (
  SELECT
    product_id,
    total_revenue,
    ROUND(total_revenue / grand_total * 100, 2) AS revenue_pct,
    ROUND(cumulative_revenue / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_revenue,
  revenue_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX ON mv_abc_by_revenue(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_profit (refresh: every 6h)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_abc_by_profit AS
WITH ranked AS (
  SELECT
    product_id,
    total_gross_profit,
    SUM(total_gross_profit) OVER () AS grand_total,
    SUM(total_gross_profit) OVER (ORDER BY total_gross_profit DESC ROWS UNBOUNDED PRECEDING) AS cumulative_profit
  FROM mv_product_performance
  WHERE total_gross_profit > 0
),
pct AS (
  SELECT
    product_id,
    total_gross_profit,
    ROUND(total_gross_profit / grand_total * 100, 2) AS profit_pct,
    ROUND(cumulative_profit / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_gross_profit,
  profit_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX ON mv_abc_by_profit(product_id);

-- -----------------------------------------------------------------------------
-- mv_abc_by_volume (refresh: every 6h)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_abc_by_volume AS
WITH ranked AS (
  SELECT
    product_id,
    total_units_sold,
    SUM(total_units_sold) OVER () AS grand_total,
    SUM(total_units_sold) OVER (ORDER BY total_units_sold DESC ROWS UNBOUNDED PRECEDING) AS cumulative_units
  FROM mv_product_performance
  WHERE total_units_sold > 0
),
pct AS (
  SELECT
    product_id,
    total_units_sold,
    ROUND(total_units_sold::NUMERIC / grand_total * 100, 2) AS volume_pct,
    ROUND(cumulative_units::NUMERIC / grand_total * 100, 2) AS cumulative_pct
  FROM ranked
)
SELECT
  product_id,
  total_units_sold,
  volume_pct,
  cumulative_pct,
  CASE
    WHEN cumulative_pct <= 80 THEN 'A'
    WHEN cumulative_pct <= 95 THEN 'B'
    ELSE 'C'
  END::abc_curve AS abc_class
FROM pct;

CREATE UNIQUE INDEX ON mv_abc_by_volume(product_id);

-- -----------------------------------------------------------------------------
-- mv_stock_status (refresh: hourly)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_stock_status AS
SELECT
  s.product_variation_id,
  p.id                              AS product_id,
  p.name                            AS product_name,
  p.sku,
  s.quantity                        AS current_qty,
  s.avg_cost,
  ROUND(s.quantity * s.avg_cost, 2) AS stock_value_at_cost,
  ROUND(s.quantity * COALESCE(pv.price_override, p.base_price), 2) AS stock_value_at_price,
  p.base_price,
  p.margin_pct,
  (SELECT MAX(sl.entry_date) FROM stock_lots sl
   WHERE sl.product_variation_id = s.product_variation_id) AS last_entry_date,
  (SELECT MIN(s2.sale_date) FROM sales s2
   JOIN sale_items si2 ON si2.sale_id = s2.id
   WHERE si2.product_variation_id = s.product_variation_id
   AND s2.status NOT IN ('cancelled', 'returned')
   ORDER BY s2.sale_date DESC
   LIMIT 1) AS last_sale_date
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id;

CREATE UNIQUE INDEX ON mv_stock_status(product_variation_id);

-- -----------------------------------------------------------------------------
-- mv_customer_rfm (refresh: daily)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_customer_rfm AS
WITH base AS (
  SELECT
    c.id AS customer_id,
    CURRENT_DATE - MAX(s.sale_date)             AS days_since_last_purchase,
    COUNT(DISTINCT s.id)                         AS purchase_count,
    SUM(s.total)                                 AS total_spent
  FROM customers c
  LEFT JOIN sales s ON s.customer_id = c.id
    AND s.status NOT IN ('cancelled', 'returned')
  GROUP BY c.id
),
scored AS (
  SELECT
    customer_id,
    days_since_last_purchase,
    purchase_count,
    total_spent,
    -- R: 5 = mais recente
    NTILE(5) OVER (ORDER BY days_since_last_purchase ASC)  AS r_score,
    -- F: 5 = mais frequente
    NTILE(5) OVER (ORDER BY purchase_count DESC)           AS f_score,
    -- M: 5 = maior gasto
    NTILE(5) OVER (ORDER BY total_spent DESC)              AS m_score
  FROM base
  WHERE total_spent > 0
)
SELECT
  customer_id,
  days_since_last_purchase,
  purchase_count,
  total_spent,
  r_score,
  f_score,
  m_score,
  (r_score + f_score + m_score) AS rfm_total,
  CASE
    WHEN r_score >= 4 AND f_score >= 4 AND m_score >= 4 THEN 'champions'
    WHEN f_score >= 4 AND m_score >= 3                  THEN 'loyal'
    WHEN r_score >= 3 AND f_score >= 2                  THEN 'potential_loyal'
    WHEN r_score >= 4 AND f_score <= 2                  THEN 'new_customers'
    WHEN r_score = 3  AND f_score <= 2                  THEN 'promising'
    WHEN r_score <= 2 AND f_score >= 3 AND m_score >= 3 THEN 'at_risk'
    WHEN r_score <= 2 AND f_score >= 4 AND m_score >= 4 THEN 'cant_lose'
    WHEN r_score <= 2 AND f_score <= 2 AND m_score <= 2 THEN 'hibernating'
    ELSE 'lost'
  END::rfm_segment AS segment
FROM scored;

CREATE UNIQUE INDEX ON mv_customer_rfm(customer_id);

-- -----------------------------------------------------------------------------
-- mv_monthly_financial (refresh: daily)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_monthly_financial AS
SELECT
  DATE_TRUNC('month', reference_date)::DATE   AS month,
  SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END) AS total_income,
  SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS total_expenses,
  SUM(CASE WHEN type = 'income'  THEN amount
           WHEN type = 'expense' THEN -amount ELSE 0 END) AS net_result,
  -- por categoria de receita
  SUM(CASE WHEN category = 'sale'           THEN amount ELSE 0 END) AS revenue_sales,
  SUM(CASE WHEN category = 'other_income'   THEN amount ELSE 0 END) AS revenue_other,
  -- por categoria de despesa
  SUM(CASE WHEN category = 'stock_purchase' THEN amount ELSE 0 END) AS exp_stock,
  SUM(CASE WHEN category = 'marketing'      THEN amount ELSE 0 END) AS exp_marketing,
  SUM(CASE WHEN category = 'rent'           THEN amount ELSE 0 END) AS exp_rent,
  SUM(CASE WHEN category = 'salaries'       THEN amount ELSE 0 END) AS exp_salaries,
  SUM(CASE WHEN category = 'freight_cost'   THEN amount ELSE 0 END) AS exp_freight,
  SUM(CASE WHEN category = 'taxes'          THEN amount ELSE 0 END) AS exp_taxes,
  SUM(CASE WHEN category = 'operational'    THEN amount ELSE 0 END) AS exp_operational,
  SUM(CASE WHEN category = 'other_expense'  THEN amount ELSE 0 END) AS exp_other
FROM finance_entries
GROUP BY DATE_TRUNC('month', reference_date);

CREATE UNIQUE INDEX ON mv_monthly_financial(month);

-- -----------------------------------------------------------------------------
-- mv_color_performance (ticket médio por cor, faturamento por cor)
-- Refresh: every 6h
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_color_performance AS
SELECT
  vv.value                          AS color_name,
  COUNT(DISTINCT si.id)             AS total_items_sold,
  SUM(si.quantity)                  AS total_units_sold,
  SUM(si.total_price)               AS total_revenue,
  SUM(si.gross_profit)              AS total_gross_profit,
  AVG(si.unit_price)                AS avg_price,
  AVG(s.total / NULLIF(
    (SELECT COUNT(*) FROM sale_items si2 WHERE si2.sale_id = s.id), 0
  ))                                AS avg_ticket_contribution
FROM sale_items si
JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
JOIN product_variation_attributes pva ON pva.product_variation_id = si.product_variation_id
JOIN variation_types vt ON vt.id = pva.variation_type_id AND vt.slug = 'cor'
JOIN variation_values vv ON vv.id = pva.variation_value_id
GROUP BY vv.value;

CREATE UNIQUE INDEX ON mv_color_performance(color_name);

-- -----------------------------------------------------------------------------
-- mv_supplier_performance (refresh: daily)
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_supplier_performance AS
SELECT
  sup.id                            AS supplier_id,
  sup.name                          AS supplier_name,
  COUNT(DISTINCT sl.id)             AS total_lots,
  SUM(sl.total_lot_cost)            AS total_purchased_value,
  SUM(si.quantity)                  AS total_units_sold,
  SUM(si.total_price)               AS total_revenue,
  SUM(si.gross_profit)              AS total_gross_profit,
  ROUND(
    CASE WHEN SUM(si.total_price) > 0
    THEN SUM(si.gross_profit) / SUM(si.total_price) * 100
    ELSE 0 END, 2
  )                                 AS avg_margin_pct,
  COUNT(DISTINCT p.id)              AS product_count
FROM suppliers sup
JOIN stock_lots sl ON sl.supplier_id = sup.id
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p ON p.id = pv.product_id
LEFT JOIN sale_items si ON si.product_variation_id = pv.id
LEFT JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('cancelled', 'returned')
GROUP BY sup.id, sup.name;

CREATE UNIQUE INDEX ON mv_supplier_performance(supplier_id);

-- =============================================================================
-- MIGRATION 013: FUNCTIONS & TRIGGERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Função: gerar sale_number
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION generate_sale_number()
RETURNS TEXT AS $$
DECLARE
  today_count INT;
  today_str TEXT;
BEGIN
  today_str := TO_CHAR(CURRENT_DATE, 'YYYYMMDD');
  SELECT COUNT(*) + 1 INTO today_count
  FROM sales
  WHERE sale_date = CURRENT_DATE;
  RETURN 'SNT-' || today_str || '-' || LPAD(today_count::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- Função: atualizar stock após entrada de lote
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_stock_on_lot_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO stock (product_variation_id, quantity, avg_cost, last_updated)
  VALUES (
    NEW.product_variation_id,
    NEW.quantity_original,
    NEW.cost_per_unit,
    NOW()
  )
  ON CONFLICT (product_variation_id) DO UPDATE SET
    avg_cost = (
      (stock.quantity * stock.avg_cost + NEW.quantity_original * NEW.cost_per_unit)
      / (stock.quantity + NEW.quantity_original)
    ),
    quantity = stock.quantity + NEW.quantity_original,
    last_updated = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_lot_insert
  AFTER INSERT ON stock_lots
  FOR EACH ROW EXECUTE FUNCTION update_stock_on_lot_insert();

-- -----------------------------------------------------------------------------
-- Função: decrementar stock após venda (FIFO)
-- Chamada pelo service layer via RPC — não via trigger direto
-- (lógica de negócio complexa melhor gerenciada no backend)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_stock_fifo(
  p_product_variation_id INT,
  p_quantity INT
)
RETURNS TABLE (lot_id INT, consumed INT, unit_cost NUMERIC) AS $$
DECLARE
  lot RECORD;
  remaining INT := p_quantity;
  consumed_qty INT;
BEGIN
  FOR lot IN
    SELECT id, quantity_remaining, cost_per_unit
    FROM stock_lots
    WHERE product_variation_id = p_product_variation_id
      AND quantity_remaining > 0
    ORDER BY entry_date ASC, id ASC
  LOOP
    EXIT WHEN remaining <= 0;
    consumed_qty := LEAST(remaining, lot.quantity_remaining);
    UPDATE stock_lots SET quantity_remaining = quantity_remaining - consumed_qty WHERE id = lot.id;
    remaining := remaining - consumed_qty;
    RETURN QUERY SELECT lot.id, consumed_qty, lot.cost_per_unit;
  END LOOP;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente para variação %: faltam % unidades', p_product_variation_id, remaining;
  END IF;

  -- Atualiza stock table
  UPDATE stock SET
    quantity = quantity - p_quantity,
    last_updated = NOW()
  WHERE product_variation_id = p_product_variation_id;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- Trigger: atualizar customer_metrics após venda
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_customer_metrics_on_sale()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO customer_metrics (customer_id, total_spent, order_count, avg_ticket, last_purchase_date, updated_at)
  VALUES (
    NEW.customer_id,
    NEW.total,
    1,
    NEW.total,
    NEW.sale_date,
    NOW()
  )
  ON CONFLICT (customer_id) DO UPDATE SET
    total_spent = customer_metrics.total_spent + NEW.total,
    order_count = customer_metrics.order_count + 1,
    avg_ticket  = (customer_metrics.total_spent + NEW.total) / (customer_metrics.order_count + 1),
    last_purchase_date = GREATEST(customer_metrics.last_purchase_date, NEW.sale_date),
    updated_at  = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_metrics_sale
  AFTER INSERT ON sales
  FOR EACH ROW
  WHEN (NEW.status = 'paid')
  EXECUTE FUNCTION update_customer_metrics_on_sale();

-- -----------------------------------------------------------------------------
-- Trigger: audit log genérico (aplicar nas tabelas críticas)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, user_id, created_at)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id::TEXT, OLD.id::TEXT),
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' THEN TO_JSONB(OLD) ELSE NULL END,
    CASE WHEN TG_OP != 'DELETE' THEN TO_JSONB(NEW) ELSE NULL END,
    auth.uid(),
    NOW()
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Aplicar audit em tabelas críticas:
CREATE TRIGGER audit_sales    AFTER INSERT OR UPDATE OR DELETE ON sales    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
CREATE TRIGGER audit_returns  AFTER INSERT OR UPDATE OR DELETE ON returns  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
CREATE TRIGGER audit_stock_lots AFTER INSERT OR UPDATE ON stock_lots       FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
CREATE TRIGGER audit_finance  AFTER INSERT OR UPDATE OR DELETE ON finance_entries FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- =============================================================================
-- MIGRATION 014: ROW LEVEL SECURITY (RLS)
-- =============================================================================

-- Habilitar RLS
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock               ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_lots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashback_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_costs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE parameters          ENABLE ROW LEVEL SECURITY;

-- Helper function: buscar role do usuário atual
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT AS $$
  SELECT role::TEXT FROM users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Products: todos autenticados podem ler, apenas admin escreve
CREATE POLICY products_select ON products FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY products_write  ON products FOR ALL    TO authenticated USING (current_user_role() = 'admin');

-- Stock: todos podem ler
CREATE POLICY stock_select ON stock      FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY stock_lots_select ON stock_lots FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY stock_lots_insert ON stock_lots FOR INSERT TO authenticated WITH CHECK (current_user_role() = 'admin');

-- Customers: todos podem criar, vendedor vê apenas os seus
CREATE POLICY customers_select_admin  ON customers FOR SELECT TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY customers_select_seller ON customers FOR SELECT TO authenticated USING (
  current_user_role() = 'seller' AND created_by = auth.uid()
);
CREATE POLICY customers_insert ON customers FOR INSERT TO authenticated WITH CHECK (TRUE);

-- Sales: vendedor cria e vê os seus, admin vê todos
CREATE POLICY sales_select_admin  ON sales FOR SELECT TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY sales_select_seller ON sales FOR SELECT TO authenticated USING (
  current_user_role() = 'seller' AND seller_id = auth.uid()
);
CREATE POLICY sales_insert ON sales FOR INSERT TO authenticated WITH CHECK (TRUE);

-- Finance: apenas admin
CREATE POLICY finance_admin ON finance_entries FOR ALL TO authenticated USING (current_user_role() = 'admin');

-- Parameters: apenas admin
CREATE POLICY params_admin ON parameters FOR ALL TO authenticated USING (current_user_role() = 'admin');

-- =============================================================================
-- MIGRATION: SHIPPING MODULE
-- =============================================================================

-- ======================================
-- SHIPPING ORIGINS
-- ======================================
CREATE TABLE shipping_origins (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cep TEXT NOT NULL,
  street TEXT NOT NULL,
  number TEXT,
  complement TEXT,
  neighborhood TEXT NOT NULL,
  city TEXT NOT NULL,
  state CHAR(2) NOT NULL,
  latitude NUMERIC(10,8) NOT NULL,
  longitude NUMERIC(11,8) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ======================================
-- SHIPPING ZONES
-- ======================================
CREATE TABLE shipping_zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'RN',
  city TEXT,
  neighborhoods_json JSONB DEFAULT '[]'::jsonb,
  cep_ranges_json JSONB DEFAULT '[]'::jsonb,
  min_km NUMERIC(6,2),
  max_km NUMERIC(6,2),
  color TEXT DEFAULT '#3b82f6',
  priority INT DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name)
);

-- ======================================
-- SHIPPING RULES
-- ======================================
CREATE TABLE shipping_rules (
  id SERIAL PRIMARY KEY,
  zone_id INT NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  client_price NUMERIC(10,2) NOT NULL,
  internal_cost NUMERIC(10,2) NOT NULL,
  estimated_hours INT DEFAULT 24,
  free_shipping_min_order NUMERIC(10,2),
  min_order_to_enable NUMERIC(10,2),
  allow_pickup BOOLEAN DEFAULT FALSE,
  allow_delivery BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ======================================
-- CUSTOMER ADDRESSES
-- ======================================
CREATE TABLE customer_addresses (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  cep TEXT NOT NULL,
  street TEXT NOT NULL,
  number TEXT NOT NULL,
  complement TEXT,
  neighborhood TEXT NOT NULL,
  city TEXT NOT NULL,
  state CHAR(2) NOT NULL,
  reference TEXT,
  latitude NUMERIC(10,8),
  longitude NUMERIC(11,8),
  geocode_source TEXT,
  is_validated BOOLEAN DEFAULT FALSE,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX idx_customer_addresses_cep ON customer_addresses(cep);

-- ======================================
-- SHIPMENTS
-- ======================================
CREATE TABLE shipments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL UNIQUE REFERENCES sales(id),
  customer_id INT NOT NULL REFERENCES customers(id),
  address_id INT REFERENCES customer_addresses(id),
  origin_id INT NOT NULL REFERENCES shipping_origins(id),
  zone_id INT REFERENCES shipping_zones(id),
  rule_id INT REFERENCES shipping_rules(id),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('pickup', 'delivery')),
  distance_km NUMERIC(8,2),
  client_shipping_price NUMERIC(10,2),
  internal_shipping_cost_estimated NUMERIC(10,2),
  internal_shipping_cost_real NUMERIC(10,2),
  shipping_subsidy NUMERIC(10,2),
  status TEXT DEFAULT 'aguardando_confirmacao',
  courier_name TEXT,
  courier_phone TEXT,
  dispatched_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  pickup_at TIMESTAMPTZ,
  notes TEXT,
  proof_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_shipments_zone ON shipments(zone_id);
CREATE INDEX idx_shipments_delivery_mode ON shipments(delivery_mode);

-- ======================================
-- SHIPMENT EVENTS
-- ======================================
CREATE TABLE shipment_events (
  id SERIAL PRIMARY KEY,
  shipment_id INT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  description TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipment_events_shipment ON shipment_events(shipment_id);
CREATE INDEX idx_shipment_events_status ON shipment_events(status);

-- RLS Policies for Shipping
CREATE POLICY shipping_origins_admin ON shipping_origins FOR ALL TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY shipping_zones_select ON shipping_zones FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY shipping_zones_write ON shipping_zones FOR ALL TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY shipping_rules_select ON shipping_rules FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY shipping_rules_write ON shipping_rules FOR ALL TO authenticated USING (current_user_role() = 'admin');

CREATE POLICY customer_addresses_select ON customer_addresses FOR SELECT TO authenticated USING (
  current_user_role() = 'admin' OR customer_id IN (
    SELECT id FROM customers WHERE created_by = auth.uid()
  )
);
CREATE POLICY customer_addresses_insert ON customer_addresses FOR INSERT TO authenticated WITH CHECK (
  customer_id IN (SELECT id FROM customers WHERE created_by = auth.uid())
);
CREATE POLICY customer_addresses_update ON customer_addresses FOR UPDATE TO authenticated USING (
  customer_id IN (SELECT id FROM customers WHERE created_by = auth.uid())
);

CREATE POLICY shipments_select_admin ON shipments FOR SELECT TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY shipments_select_seller ON shipments FOR SELECT TO authenticated USING (
  order_id IN (SELECT id FROM sales WHERE seller_id = auth.uid())
);
CREATE POLICY shipments_insert ON shipments FOR INSERT TO authenticated WITH CHECK (TRUE);

CREATE POLICY shipment_events_select ON shipment_events FOR SELECT TO authenticated USING (current_user_role() = 'admin');
CREATE POLICY shipment_events_insert ON shipment_events FOR INSERT TO authenticated WITH CHECK (TRUE);
