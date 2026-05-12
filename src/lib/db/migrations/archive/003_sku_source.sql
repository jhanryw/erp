-- =============================================================================
-- 003_sku_source.sql — Rastreabilidade de origem do SKU pai
--
-- Adiciona `sku_source` à tabela `products` para distinguir SKUs gerados
-- automaticamente pelo servidor (via generateSKU) de SKUs alterados
-- manualmente por um gerente ou admin.
--
-- Valores possíveis:
--   'auto'   — SKU gerado pelo servidor no momento do cadastro (padrão)
--   'manual' — SKU alterado manualmente via PUT /api/produtos/[id]
--
-- Qualquer alteração via PUT com SKU diferente do original grava 'manual'
-- e registra um evento 'sku_manual_override' em audit_logs.
-- =============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sku_source TEXT
    NOT NULL
    DEFAULT 'auto'
    CHECK (sku_source IN ('auto', 'manual'));

COMMENT ON COLUMN public.products.sku_source IS
  'Origem do SKU pai: ''auto'' = gerado por generateSKU(), ''manual'' = sobrescrito por gerente/admin';
