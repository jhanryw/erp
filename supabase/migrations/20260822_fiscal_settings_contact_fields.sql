-- =============================================================================
-- 20260822_fiscal_settings_contact_fields.sql
--
-- Fase Fiscal 2A — adiciona telefone/email a company_fiscal_settings.
--
-- Necessário pro cadastro de empresa na Focus NFe (`POST/PUT /v2/empresas`)
-- — telefone e email são campos aceitos pelo cadastro de empresa,
-- confirmado na doc oficial (doc.focusnfe.com.br/reference/criar_empresa).
-- `companies` não tem esses campos (confirmado, mesma auditoria da Fase
-- Fiscal 1) — não há duplicação de campo cadastral existente.
--
-- Ambos nullable: cadastro incremental, mesmo padrão dos demais campos de
-- company_fiscal_settings.
-- =============================================================================

ALTER TABLE public.company_fiscal_settings
  ADD COLUMN IF NOT EXISTS telefone TEXT,
  ADD COLUMN IF NOT EXISTS email    TEXT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
ALTER TABLE public.company_fiscal_settings
  DROP COLUMN IF EXISTS telefone,
  DROP COLUMN IF EXISTS email;
*/
