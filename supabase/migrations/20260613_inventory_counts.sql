-- =============================================================================
-- 20260613_inventory_counts.sql
--
-- Cria as tabelas para o inventário por leitor de código de barras.
--
-- DESIGN:
--   inventory_counts       — sessão de contagem (1 por local, no máximo 1 aberta)
--   inventory_count_items  — linha por variação: expected vs counted
--
-- MULTI-ESTOQUE:
--   Cada sessão pertence a exatamente um stock_location.
--   O snapshot lê stock_balances WHERE stock_location_id = escolhido.
--
-- FILTROS FUTUROS (ponto 3 do aprovado):
--   Colunas supplier_id e category_id já existem na sessão (NULL = sem filtro).
--   O snapshot na API filtra por p.supplier_id / p.category_id quando preenchidos.
--   products.supplier_id  ← vínculo produto↔fornecedor já existe no schema.
--   products.category_id  ← vínculo produto↔categoria já existe no schema.
--   stock_lots.supplier_id também existe, mas para a primeira versão usamos
--   products.supplier_id (fornecedor principal do produto).
--
-- PRODUTOS NÃO PREVISTOS (ponto 4):
--   is_unplanned = true quando o SKU bipado não estava no snapshot original.
--   expected_quantity = 0 nesses casos.
--
-- BLOQUEIO DE SESSÃO DUPLA:
--   Índice parcial único em (company_id, stock_location_id) WHERE status='open'.
--   Impede criar duas sessões abertas para o mesmo local.
--
-- AUDITORIA:
--   Na finalização o endpoint chama rpc_stock_adjust com:
--     p_reason = 'inventario-contagem-<id>'
--     p_notes  = 'Inventário #<id> — <local>'
--   O stock_movements.reference_id ficará com 'inventario-contagem-<id>'.
--   movement_type continua 'adjustment' (padrão do RPC).
--
-- ROLLBACK (seguro):
--   As duas tabelas novas são independentes. DROP CASCADE não afeta nada mais.
--   Ver bloco ROLLBACK no final.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — inventory_counts
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inventory_counts (
  id                serial        PRIMARY KEY,
  company_id        int           NOT NULL REFERENCES public.companies(id),
  stock_location_id int           NOT NULL REFERENCES public.stock_locations(id),

  -- Filtros opcionais para snapshot parcial (ponto 3 — fornecedor, categoria)
  -- NULL = sem filtro = contagem de TUDO no local
  supplier_id       int           REFERENCES public.suppliers(id),
  category_id       int           REFERENCES public.categories(id),

  status            text          NOT NULL DEFAULT 'open'
                                  CONSTRAINT chk_ic_status
                                  CHECK (status IN ('open', 'finalized', 'cancelled')),

  notes             text,

  created_by        uuid          REFERENCES public.users(id),
  created_at        timestamptz   NOT NULL DEFAULT NOW(),

  finalized_by      uuid          REFERENCES public.users(id),
  finalized_at      timestamptz
);

-- Índice principal: busca por empresa + status
CREATE INDEX IF NOT EXISTS idx_ic_company_status
  ON public.inventory_counts(company_id, status, created_at DESC);

-- Bloqueio: no máximo 1 sessão aberta por empresa + local
-- (índice parcial — só vale quando status = 'open')
CREATE UNIQUE INDEX IF NOT EXISTS uq_ic_one_open_per_location
  ON public.inventory_counts(company_id, stock_location_id)
  WHERE status = 'open';

COMMENT ON TABLE public.inventory_counts IS
  'Sessão de inventário físico por leitor. Uma sessão aberta por local por vez.';
COMMENT ON COLUMN public.inventory_counts.supplier_id IS
  'Filtro opcional: conta apenas produtos do fornecedor. NULL = tudo.';
COMMENT ON COLUMN public.inventory_counts.category_id IS
  'Filtro opcional: conta apenas produtos da categoria. NULL = tudo.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — inventory_count_items
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inventory_count_items (
  id                     serial        PRIMARY KEY,
  inventory_count_id     int           NOT NULL
                                       REFERENCES public.inventory_counts(id)
                                       ON DELETE CASCADE,
  product_variation_id   int           NOT NULL
                                       REFERENCES public.product_variations(id),

  -- Quantidade no sistema no momento em que a sessão foi aberta
  expected_quantity      int           NOT NULL DEFAULT 0,

  -- Quantidade acumulada pelas bipagens (NÃO altera stock_balances)
  counted_quantity       int           NOT NULL DEFAULT 0,

  -- true = produto bipado que não estava no snapshot original
  -- (produto novo, em local errado, ou cadastro incorreto)
  is_unplanned           boolean       NOT NULL DEFAULT false,

  last_scanned_at        timestamptz,

  -- difference é derivada: counted_quantity - expected_quantity
  -- calculada na query, não armazenada (evita inconsistência)

  CONSTRAINT uq_ici_count_variation
    UNIQUE (inventory_count_id, product_variation_id),

  CONSTRAINT chk_ici_expected_non_neg
    CHECK (expected_quantity >= 0),

  CONSTRAINT chk_ici_counted_non_neg
    CHECK (counted_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ici_count_id
  ON public.inventory_count_items(inventory_count_id);

CREATE INDEX IF NOT EXISTS idx_ici_variation_id
  ON public.inventory_count_items(product_variation_id);

COMMENT ON TABLE public.inventory_count_items IS
  'Linha de contagem por variação. counted_quantity cresce a cada bipagem. Não altera stock_balances.';
COMMENT ON COLUMN public.inventory_count_items.is_unplanned IS
  'true = SKU bipado não estava no snapshot (produto novo, local errado, erro de cadastro).';
COMMENT ON COLUMN public.inventory_count_items.expected_quantity IS
  'Saldo em stock_balances no momento em que a sessão foi aberta. Imutável após criação.';
COMMENT ON COLUMN public.inventory_count_items.counted_quantity IS
  'Soma das bipagens. Cada bipagem incrementa em +1. Nunca altera stock_balances diretamente.';


-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP TABLE IF EXISTS public.inventory_count_items CASCADE;
DROP TABLE IF EXISTS public.inventory_counts      CASCADE;

-- Não é necessário remover nada mais:
-- products, product_variations, stock_balances, stock_movements
-- e rpc_stock_adjust permanecem intactos.
*/
