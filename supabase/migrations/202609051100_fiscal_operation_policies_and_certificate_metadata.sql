-- =============================================================================
-- 202609051100_fiscal_operation_policies_and_certificate_metadata.sql
--
-- Motor Fiscal Configurável (Fase 1) — fundação de dados.
--
-- HISTÓRICO: este arquivo documenta uma migration que já foi executada
-- MANUALMENTE no Supabase self-hosted de produção (workflow obrigatório do
-- projeto — Supabase self-hosted, sem execução automática de migrations) e
-- já foi VALIDADA contra o banco real (BLOCO 4 da rodada de revisão: PK/
-- CHECKs/FKs/UNIQUE conferidos, 7 policies da Santtorini conferidas linha a
-- linha, 10 colunas novas conferidas, constraint de provider conferida,
-- integrações antigas confirmadas intactas, zero secret criado). Este
-- arquivo existe para que o histórico do Git reflita EXATAMENTE o estado
-- real do banco, e para que instalações futuras (nova empresa/ambiente)
-- apliquem o mesmo schema — não é uma migration pendente de execução.
--
-- Idempotente onde tecnicamente apropriado: `CREATE TABLE IF NOT EXISTS`,
-- `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, seed com
-- `ON CONFLICT DO NOTHING`. A única exceção inevitável é o
-- DROP CONSTRAINT + ADD CONSTRAINT do CHECK de `company_integrations.
-- provider` — Postgres não tem um "ALTER CONSTRAINT IF DIFFERENT", então
-- rodar este arquivo de novo faz DROP+CREATE da mesma constraint (sem
-- efeito colateral: mesma definição final, apenas reafirmada).
--
-- Reaproveita 100% de infraestrutura existente — nenhuma tabela nova além
-- de `fiscal_operation_policies`: certificado/CSC/senha (secretos) vão em
-- `company_integrations`/`integration_secrets` (já existentes, já com
-- criptografia AES-256-GCM em `src/lib/security/secretCipher.ts`); só
-- metadados NÃO secretos do certificado (status/titular/validade/
-- fingerprint) viram colunas em `company_fiscal_settings`.
-- =============================================================================

BEGIN;

-- ─── 1. fiscal_operation_policies (tabela nova) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.fiscal_operation_policies (
  id                        BIGSERIAL PRIMARY KEY,

  company_id                INT NOT NULL
                              REFERENCES public.companies(id),

  operation_type            TEXT NOT NULL
                              CHECK (operation_type IN (
                                'pos_retail',
                                'pos_pickup',
                                'pos_delivery',
                                'wholesale',
                                'website',
                                'whatsapp',
                                'manual'
                              )),

  fiscal_enabled            BOOLEAN NOT NULL DEFAULT false,

  document_mode             TEXT NOT NULL DEFAULT 'none'
                              CHECK (document_mode IN ('auto', 'nfce', 'nfe', 'none')),

  auto_issue                BOOLEAN NOT NULL DEFAULT false,

  auto_print                BOOLEAN NOT NULL DEFAULT false,

  print_non_fiscal_receipt  BOOLEAN NOT NULL DEFAULT true,

  manual_issue_allowed      BOOLEAN NOT NULL DEFAULT true,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  updated_by                UUID
                              REFERENCES public.users(id),

  CONSTRAINT uq_fiscal_operation_policies_company_operation
    UNIQUE (company_id, operation_type)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_operation_policies_company
  ON public.fiscal_operation_policies (company_id);

-- Reaproveita o trigger function já existente de company_integrations
-- (corpo validado real: só `NEW.updated_at := NOW(); RETURN NEW;`, genérico,
-- sem nenhuma referência a colunas específicas de company_integrations —
-- seguro reutilizar sem alteração).
DROP TRIGGER IF EXISTS trg_fiscal_operation_policies_touch_updated_at
  ON public.fiscal_operation_policies;

CREATE TRIGGER trg_fiscal_operation_policies_touch_updated_at
  BEFORE UPDATE ON public.fiscal_operation_policies
  FOR EACH ROW
  EXECUTE FUNCTION public.company_integrations_touch_updated_at();

ALTER TABLE public.fiscal_operation_policies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.fiscal_operation_policies FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.fiscal_operation_policies TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.fiscal_operation_policies_id_seq TO service_role;

COMMENT ON TABLE public.fiscal_operation_policies IS
  'Política fiscal configurável por empresa e tipo de operação (pos_retail/pos_pickup/pos_delivery/wholesale/website/whatsapp/manual). Substitui regra comercial hardcoded por configuração — o resolver fiscal (resolveFiscalDocumentType) continua sendo a camada de ELEGIBILIDADE LEGAL, nunca sobreposta por esta política.';


-- ─── 2. Metadados de certificado/CSC (NÃO secretos) em company_fiscal_settings ───
ALTER TABLE public.company_fiscal_settings
  ADD COLUMN IF NOT EXISTS certificate_status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (certificate_status IN (
      'not_configured',
      'valid',
      'expired',
      'invalid',
      'replaced'
    )),
  ADD COLUMN IF NOT EXISTS certificate_subject        TEXT,
  ADD COLUMN IF NOT EXISTS certificate_cnpj           TEXT,
  ADD COLUMN IF NOT EXISTS certificate_issuer         TEXT,
  ADD COLUMN IF NOT EXISTS certificate_serial         TEXT,
  ADD COLUMN IF NOT EXISTS certificate_fingerprint    TEXT,
  ADD COLUMN IF NOT EXISTS certificate_valid_from     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS certificate_valid_until    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS certificate_uploaded_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS csc_id                     TEXT;

COMMENT ON COLUMN public.company_fiscal_settings.certificate_status IS
  'Status LOCAL do certificado (metadado, não secreto) — o PFX e a senha ficam criptografados em integration_secrets (integração provider=fiscal_certificate), nunca em texto/base64 nesta tabela.';

COMMENT ON COLUMN public.company_fiscal_settings.csc_id IS
  'Identificador do CSC (Código de Segurança do Contribuinte) — NÃO é o token secreto. O token (csc_token) fica em integration_secrets, criptografado, nunca aqui.';


-- ─── 3. Amplia company_integrations_provider_check ─────────────────────────
-- Preserva os 4 valores já em uso (chatwoot, meta, nuvemshop, focus_nfe) e
-- adiciona 'fiscal_certificate'. O PostgreSQL revalida todas as linhas
-- existentes contra a nova definição no ADD CONSTRAINT — seguro aqui porque
-- a nova lista contém TODOS os valores já em uso.
ALTER TABLE public.company_integrations
  DROP CONSTRAINT company_integrations_provider_check;

ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_provider_check
  CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop', 'focus_nfe', 'fiscal_certificate'));

COMMIT;


-- =============================================================================
-- SEED — Santtorini (esta instalação)
--
-- Identificado explicitamente como o seed DESTA instalação (company_id=1
-- confirmado real no banco desta instalação) — nunca vira `if company_id
-- === 1` em código de aplicação. Uma instalação nova do ERP para outro
-- cliente roda este arquivo (a parte estrutural acima é genérica), mas
-- precisa de seu PRÓPRIO seed com o company_id real dessa instalação — não
-- reaproveita estes 7 INSERTs.
--
-- ON CONFLICT DO NOTHING: nunca sobrescreve uma configuração que um admin
-- já tenha alterado pela UI (Configurações → Fiscal) depois da aplicação
-- inicial — rodar este arquivo de novo é seguro e não reverte nada.
-- =============================================================================

INSERT INTO public.fiscal_operation_policies
  (company_id, operation_type, fiscal_enabled, document_mode, auto_issue, auto_print, print_non_fiscal_receipt, manual_issue_allowed)
VALUES
  (1, 'pos_retail',   true, 'nfce', true,  true,  false, true),
  (1, 'pos_pickup',   true, 'nfce', true,  true,  false, true),
  (1, 'pos_delivery', true, 'nfe',  true,  false, false, true),
  (1, 'wholesale',    true, 'nfe',  false, false, true,  true),
  (1, 'website',      true, 'nfe',  true,  false, false, true),
  (1, 'whatsapp',     true, 'auto', false, false, true,  true),
  (1, 'manual',       true, 'auto', false, false, true,  true)
ON CONFLICT (company_id, operation_type) DO NOTHING;
