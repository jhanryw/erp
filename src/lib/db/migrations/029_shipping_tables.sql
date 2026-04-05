-- Migration 029: Tabelas de logística/frete
-- shipping_origins, shipping_zones, shipping_rules

-- ─── Origens (endereço de saída dos envios) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_origins (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER,
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
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipping_origins_company
  ON shipping_origins (company_id);

-- ─── Zonas de entrega ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_zones (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER,
  name                TEXT NOT NULL,
  description         TEXT,
  state               CHAR(2) NOT NULL DEFAULT 'RN',
  city                TEXT,
  neighborhoods_json  JSONB NOT NULL DEFAULT '[]',
  cep_ranges_json     JSONB NOT NULL DEFAULT '[]',
  min_km              NUMERIC(8, 2),
  max_km              NUMERIC(8, 2),
  color               TEXT NOT NULL DEFAULT '#3b82f6',
  priority            INTEGER NOT NULL DEFAULT 100,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipping_zones_company
  ON shipping_zones (company_id);
CREATE INDEX IF NOT EXISTS idx_shipping_zones_priority
  ON shipping_zones (company_id, priority) WHERE is_active = true;

-- ─── Regras de preço por zona ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipping_rules (
  id                     SERIAL PRIMARY KEY,
  zone_id                INTEGER NOT NULL REFERENCES shipping_zones(id) ON DELETE CASCADE,
  rule_type              TEXT NOT NULL DEFAULT 'zone',
  client_price           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  internal_cost          NUMERIC(10, 2) NOT NULL DEFAULT 0,
  estimated_hours        INTEGER NOT NULL DEFAULT 24,
  free_shipping_min_order NUMERIC(10, 2),
  min_order_to_enable    NUMERIC(10, 2),
  allow_pickup           BOOLEAN NOT NULL DEFAULT false,
  allow_delivery         BOOLEAN NOT NULL DEFAULT true,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipping_rules_zone
  ON shipping_rules (zone_id);

-- ─── Adicionar colunas opcionais à shipments (caso já exista) ─────────────────
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS zone_id      INTEGER REFERENCES shipping_zones(id),
  ADD COLUMN IF NOT EXISTS rule_id      INTEGER REFERENCES shipping_rules(id),
  ADD COLUMN IF NOT EXISTS distance_km  NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS client_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS internal_cost NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS subsidy      NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS motoboy      TEXT;
