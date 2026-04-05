-- Migration 028: Adiciona company_id à cashback_config e corrige constraint de unicidade
-- A constraint antiga "cashback_config_single_active" era global (um ativo por vez).
-- Substituímos por índice parcial único POR EMPRESA.

-- 1. Adicionar colunas caso não existam
ALTER TABLE cashback_config
  ADD COLUMN IF NOT EXISTS company_id INTEGER,
  ADD COLUMN IF NOT EXISTS updated_by UUID;

-- 2. Dropar constraint global antiga
ALTER TABLE cashback_config
  DROP CONSTRAINT IF EXISTS cashback_config_single_active;

-- 3. Criar índice parcial único por empresa (permite um ativo por empresa)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashback_config_company_active
  ON cashback_config (company_id)
  WHERE active = true;

-- 4. Índice normal para lookup
CREATE INDEX IF NOT EXISTS idx_cashback_config_company_id
  ON cashback_config (company_id);
