-- =============================================================================
-- 031_nuvemshop_sync_improvements.sql
-- Melhora observabilidade e rastreabilidade da sincronização ERP ↔ Nuvemshop.
-- Idempotente: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- =============================================================================

-- 1. Adicionar last_stock_synced_at ao produto_map
--    Permite saber quando cada variante foi sincronizada pela última vez.
ALTER TABLE produto_map
  ADD COLUMN IF NOT EXISTS last_stock_synced_at TIMESTAMPTZ;

-- 2. Tabela de logs de sincronização
--    Rastreia cada tentativa de push/pull de estoque entre ERP e Nuvemshop.
CREATE TABLE IF NOT EXISTS nuvemshop_sync_logs (
  id                   BIGSERIAL    PRIMARY KEY,

  -- Tipo do evento:
  --   'stock_push_erp'   = ERP fez venda → enviou estoque final para NS
  --   'stock_confirm_ns' = Webhook NS recebido → confirmou qtd de volta para NS
  event_type           TEXT         NOT NULL,

  -- Direção do fluxo
  direction            TEXT         NOT NULL
                         CHECK (direction IN ('erp_to_ns', 'ns_to_erp')),

  product_variation_id INT,          -- Variação envolvida
  external_product_id  TEXT,         -- ID do produto na Nuvemshop
  external_variant_id  TEXT,         -- ID da variante na Nuvemshop
  external_order_id    TEXT,         -- Pedido de origem (quando aplicável)

  stock_before         INT,          -- Saldo antes (quando disponível)
  stock_after          INT,          -- Saldo enviado para NS

  success              BOOLEAN      NOT NULL DEFAULT TRUE,
  error_message        TEXT,         -- Mensagem de erro (quando success = false)
  metadata             JSONB,        -- Dados extras para debug

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Índices para queries frequentes
CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_pv
  ON nuvemshop_sync_logs (product_variation_id, created_at DESC)
  WHERE product_variation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_event
  ON nuvemshop_sync_logs (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_order
  ON nuvemshop_sync_logs (external_order_id)
  WHERE external_order_id IS NOT NULL;

-- Índice para identificar falhas rapidamente
CREATE INDEX IF NOT EXISTS idx_ns_sync_logs_failures
  ON nuvemshop_sync_logs (created_at DESC)
  WHERE success = FALSE;

-- =============================================================================
-- FIM DA MIGRAÇÃO 031
-- =============================================================================
