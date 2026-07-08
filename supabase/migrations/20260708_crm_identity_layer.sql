-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 1: camada de identidade.
--
-- Escopo: SOMENTE identidade. Sem conversa, mensagem, pipeline, inbox ou
-- automação — essas entregas vêm depois, cada uma com sua própria migration.
-- Puramente aditivo: nenhuma tabela existente (customers, sales, etc.) é
-- alterada. `customers` continua pertencendo a Vendas/OMS/Fiscal/Checkout/
-- Cashback; o CRM nunca a estende, só referencia via crm_person_customer_links.
--
-- Decisões arquiteturais definitivas desta entrega (aprovadas em revisão):
--   1. crm_persons é a identidade central do CRM — sem CPF, sem endereço
--      fiscal. Qualquer pessoa pode existir aqui sem nunca virar cliente.
--   2. crm_person_customer_links é M:N com proveniência (match_source) e
--      `is_primary` — nunca assume 1:1. Cobre múltiplos cadastros fiscais,
--      duplicidade e fusão sem precisar de tabela extra: fusão = link antigo
--      vira active=false, link novo nasce com is_primary=true.
--   3. Núcleo estrutural usa FK explícita (organization_id, person_id,
--      customer_id) — nada de entity_type/entity_id aqui. Polimorfismo fica
--      reservado para domínios genéricos (Timeline/Attachments/Tasks), que
--      não fazem parte desta entrega.
--   4. crm_channels (canal operacional da empresa: instância/provider) é
--      distinto de crm_channel_identities (identidade de canal de uma
--      pessoa). O mesmo telefone de um cliente pode ser alcançado por
--      qualquer WhatsApp da empresa — por isso channel_identities não tem
--      FK para um crm_channels específico, só o mesmo channel_type.
--      provider_instance_identifier é o campo que resolve o hoje hardcoded
--      "santtorini" no fluxo N8N — mapeamento empresa→instância passa a
--      existir no banco. external_config NUNCA guarda credencial/token/
--      senha — só configuração operacional não sensível.
--   5. crm_consent_events é ledger imutável (granted/revogado por evento,
--      nunca UPDATE). Estado atual é sempre lido via v_crm_consent_status.
--      Imutabilidade é reforçada por trigger (não só por convenção de
--      código) — proteção em duas camadas: RLS não concede INSERT/UPDATE/
--      DELETE a `authenticated`, e um trigger bloqueia UPDATE/DELETE
--      incondicionalmente, mesmo para service_role.
--
-- Fora de escopo desta entrega, por decisão explícita:
--   - qualquer API, rota, UI, componente, hook
--   - qualquer integração N8N/Evolution/webhook
--   - migração de dado legado de customers/customer_origin
--   - crm_conversations, crm_messages, crm_leads, crm_pipelines,
--     crm_opportunities, crm_tasks, crm_timeline_events
-- =============================================================================

-- ─── ENUM compartilhado ──────────────────────────────────────────────────────
-- Mesmo vocabulário fechado reusado literalmente em 3 tabelas (crm_channels,
-- crm_channel_identities, crm_consent_events) — por isso ENUM real, não
-- TEXT+CHECK duplicado em cada uma (diferente de media_usages.entity_type,
-- onde cada domínio define seu próprio subconjunto livremente).

DO $$ BEGIN
  CREATE TYPE crm_channel_type AS ENUM (
    'whatsapp', 'instagram', 'messenger', 'email',
    'mercado_livre', 'shopee', 'site_chat', 'telegram', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 1. crm_persons ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_persons (
  id             BIGSERIAL    PRIMARY KEY,
  company_id     INT          NOT NULL REFERENCES public.companies(id),
  display_name   TEXT         NOT NULL,
  notes          TEXT,
  created_source TEXT         NOT NULL
                   CHECK (created_source IN (
                     'manual', 'import', 'whatsapp_inbound', 'instagram_inbound',
                     'marketplace_sync', 'sale_checkout', 'website_form', 'other'
                   )),
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_persons_company ON public.crm_persons(company_id);

-- ─── 2. crm_organizations (B2B — nome escolhido para não colidir com a ────────
--        tabela `companies`, que representa o tenant do ERP) ─────────────────

CREATE TABLE IF NOT EXISTS public.crm_organizations (
  id             BIGSERIAL    PRIMARY KEY,
  company_id     INT          NOT NULL REFERENCES public.companies(id),
  name           TEXT         NOT NULL,
  tax_id         TEXT,        -- CNPJ informativo — não é o cadastro fiscal autoritativo
  segment        TEXT,
  notes          TEXT,
  created_source TEXT         NOT NULL
                   CHECK (created_source IN (
                     'manual', 'import', 'whatsapp_inbound', 'instagram_inbound',
                     'marketplace_sync', 'sale_checkout', 'website_form', 'other'
                   )),
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by     UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_crm_organizations_company ON public.crm_organizations(company_id);

-- ─── 3. crm_company_contacts (FK explícita pessoa↔organização) ────────────────

CREATE TABLE IF NOT EXISTS public.crm_company_contacts (
  id              BIGSERIAL    PRIMARY KEY,
  company_id      INT          NOT NULL REFERENCES public.companies(id),
  organization_id BIGINT       NOT NULL REFERENCES public.crm_organizations(id) ON DELETE CASCADE,
  person_id       BIGINT       NOT NULL REFERENCES public.crm_persons(id) ON DELETE CASCADE,
  role            TEXT,        -- ex.: "Comprador", "Financeiro" — texto livre
  is_primary      BOOLEAN      NOT NULL DEFAULT FALSE,
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by      UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Permite reativar o mesmo par organização/pessoa após desativação (pessoa
-- muda de emprego e volta) sem violar unicidade de um vínculo antigo inativo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_company_contacts_active
  ON public.crm_company_contacts(organization_id, person_id) WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_company_contacts_primary
  ON public.crm_company_contacts(organization_id) WHERE is_primary AND active;

CREATE INDEX IF NOT EXISTS idx_crm_company_contacts_company ON public.crm_company_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_company_contacts_person  ON public.crm_company_contacts(person_id);

-- ─── 4. crm_channels (canal operacional da empresa) ───────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_channels (
  id                          BIGSERIAL         PRIMARY KEY,
  company_id                  INT               NOT NULL REFERENCES public.companies(id),
  name                        TEXT              NOT NULL,   -- rótulo humano, ex. "WhatsApp Comercial"
  channel_type                crm_channel_type  NOT NULL,
  provider                    TEXT              NOT NULL
                                CHECK (provider IN (
                                  'evolution', 'meta_cloud_api', 'gmail', 'microsoft365',
                                  'smtp', 'mercado_livre', 'shopee', 'custom', 'other'
                                )),
  provider_instance_identifier TEXT,            -- nome da instância Evolution, caixa de e-mail, conta de marketplace
  -- NUNCA guardar credencial/token/senha aqui — apenas configuração operacional
  -- não sensível. Segredo continua em variável de ambiente / cofre do N8N.
  external_config             JSONB             NOT NULL DEFAULT '{}'::jsonb,
  status                      TEXT              NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'inactive', 'error')),
  active                      BOOLEAN           NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_by                  UUID              REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT uq_crm_channels_company_name UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_crm_channels_company ON public.crm_channels(company_id);

-- ─── 5. crm_channel_identities (identidade de canal de uma pessoa) ────────────

CREATE TABLE IF NOT EXISTS public.crm_channel_identities (
  id             BIGSERIAL         PRIMARY KEY,
  company_id     INT               NOT NULL REFERENCES public.companies(id), -- redundante por desempenho de RLS + defesa em profundidade, mesmo padrão de media_usages.company_id
  person_id      BIGINT            NOT NULL REFERENCES public.crm_persons(id) ON DELETE CASCADE,
  channel_type   crm_channel_type  NOT NULL,
  value          TEXT              NOT NULL, -- identificador normalizado: telefone E.164, @handle, e-mail, buyer id de marketplace
  verified       BOOLEAN           NOT NULL DEFAULT FALSE,
  created_source TEXT              NOT NULL
                   CHECK (created_source IN (
                     'manual', 'inbound_message', 'import', 'sale_checkout', 'marketplace_sync', 'other'
                   )),
  active         BOOLEAN           NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Mesmo valor não pode apontar para duas pessoas ativas diferentes na mesma
-- empresa/canal — mas permite readicionar após correção (active=false).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_channel_identities_active
  ON public.crm_channel_identities(company_id, channel_type, value) WHERE active;

CREATE INDEX IF NOT EXISTS idx_crm_channel_identities_person  ON public.crm_channel_identities(person_id);
CREATE INDEX IF NOT EXISTS idx_crm_channel_identities_company ON public.crm_channel_identities(company_id);

-- ─── 6. crm_person_customer_links (M:N pessoa↔cliente fiscal) ─────────────────

CREATE TABLE IF NOT EXISTS public.crm_person_customer_links (
  id           BIGSERIAL    PRIMARY KEY,
  company_id   INT          NOT NULL REFERENCES public.companies(id), -- redundante, mesma justificativa de media_usages.company_id
  person_id    BIGINT       NOT NULL REFERENCES public.crm_persons(id) ON DELETE CASCADE,
  customer_id  INT          NOT NULL REFERENCES public.customers(id), -- sem ON DELETE explícito (NO ACTION) — mesma proteção de integridade já usada em sales.customer_id/cashback_transactions.customer_id
  match_source TEXT         NOT NULL
                 CHECK (match_source IN (
                   'manual', 'cpf_match', 'phone_match', 'email_match', 'import', 'sale_checkout', 'merge'
                 )),
  is_primary   BOOLEAN      NOT NULL DEFAULT FALSE,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by   UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

-- checksum de tipo: customers.id é SERIAL (integer) e crm_person_customer_links.customer_id
-- foi declarado INT para bater exatamente — confirmado em 000_schema_completo.sql:482
-- antes de escrever esta FK (nenhum tipo foi assumido).

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_person_customer_links_active
  ON public.crm_person_customer_links(person_id, customer_id) WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_person_customer_links_primary
  ON public.crm_person_customer_links(person_id) WHERE is_primary AND active;

CREATE INDEX IF NOT EXISTS idx_crm_person_customer_links_customer ON public.crm_person_customer_links(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_person_customer_links_company  ON public.crm_person_customer_links(company_id);

-- ─── 7. crm_consent_events (ledger imutável) + view de estado atual ───────────

CREATE TABLE IF NOT EXISTS public.crm_consent_events (
  id           BIGSERIAL         PRIMARY KEY,
  company_id   INT               NOT NULL REFERENCES public.companies(id),
  person_id    BIGINT            NOT NULL REFERENCES public.crm_persons(id) ON DELETE RESTRICT, -- protege histórico LGPD: pessoa com consentimento nunca é hard-deletável, só active=false
  purpose      TEXT              NOT NULL CHECK (purpose IN ('transactional', 'marketing', 'other')),
  channel_type crm_channel_type,  -- NULL = aplica a todos os canais; valor específico = escopo por canal
  event_type   TEXT              NOT NULL CHECK (event_type IN ('granted', 'revoked')),
  source       TEXT              NOT NULL
                 CHECK (source IN (
                   'whatsapp_message', 'web_form', 'manual', 'sale_checkout', 'import', 'verbal_pos', 'other'
                 )),
  evidence     JSONB,             -- snapshot de prova: texto da mensagem, campo de formulário, IP
  occurred_at  TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_by   UUID              REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_consent_events_person
  ON public.crm_consent_events(person_id, purpose, channel_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_consent_events_company ON public.crm_consent_events(company_id);

-- Estado atual = último evento por (pessoa, finalidade, canal) — nunca por
-- UPDATE. Mesma lógica de "saldo derivado de ledger" já usada em v_cashback_balance.
CREATE OR REPLACE VIEW public.v_crm_consent_status AS
SELECT DISTINCT ON (person_id, purpose, channel_type)
  person_id,
  company_id,
  purpose,
  channel_type,
  event_type   AS status,
  source       AS last_source,
  occurred_at  AS last_occurred_at
FROM public.crm_consent_events
ORDER BY person_id, purpose, channel_type, occurred_at DESC, id DESC;

-- Imutabilidade em duas camadas: RLS (abaixo) não concede INSERT/UPDATE/DELETE
-- a `authenticated`, e este trigger bloqueia UPDATE/DELETE incondicionalmente,
-- inclusive para service_role — nenhum caminho de código pode corrigir um
-- evento de consentimento, só registrar um novo.
CREATE OR REPLACE FUNCTION public.crm_consent_events_block_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'crm_consent_events é um ledger imutável — UPDATE/DELETE não são permitidos. Registre um novo evento em vez de alterar um existente.'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_consent_events_block_update ON public.crm_consent_events;
CREATE TRIGGER trg_crm_consent_events_block_update
  BEFORE UPDATE ON public.crm_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_consent_events_block_mutation();

DROP TRIGGER IF EXISTS trg_crm_consent_events_block_delete ON public.crm_consent_events;
CREATE TRIGGER trg_crm_consent_events_block_delete
  BEFORE DELETE ON public.crm_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.crm_consent_events_block_mutation();

-- ─── RLS ───────────────────────────────────────────────────────────────────
-- 6 tabelas de identidade: FOR ALL company-scoped, mesmo padrão de
-- customers_company. Sem GRANT de DELETE a `authenticated` — hard delete
-- fica restrito a service_role, disciplina de soft-delete (active=false)
-- é a única via de escrita de usuário para "remover" um registro.
-- crm_consent_events: FOR SELECT apenas — nenhum papel de aplicação escreve
-- por RLS; INSERT acontece via service_role (bypassa RLS), reforçado pelo
-- trigger acima contra UPDATE/DELETE.

ALTER TABLE public.crm_persons               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_organizations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_company_contacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_channels              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_channel_identities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_person_customer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_consent_events        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_persons_company" ON public.crm_persons;
CREATE POLICY "crm_persons_company" ON public.crm_persons FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_organizations_company" ON public.crm_organizations;
CREATE POLICY "crm_organizations_company" ON public.crm_organizations FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_company_contacts_company" ON public.crm_company_contacts;
CREATE POLICY "crm_company_contacts_company" ON public.crm_company_contacts FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_channels_company" ON public.crm_channels;
CREATE POLICY "crm_channels_company" ON public.crm_channels FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_channel_identities_company" ON public.crm_channel_identities;
CREATE POLICY "crm_channel_identities_company" ON public.crm_channel_identities FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_person_customer_links_company" ON public.crm_person_customer_links;
CREATE POLICY "crm_person_customer_links_company" ON public.crm_person_customer_links FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_consent_events_company" ON public.crm_consent_events;
CREATE POLICY "crm_consent_events_company" ON public.crm_consent_events FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- ─── GRANTS ────────────────────────────────────────────────────────────────
-- authenticated: SELECT/INSERT/UPDATE nas 6 tabelas de identidade (nunca
-- DELETE — soft-delete via active=false é a única forma de "remover").
-- crm_consent_events: authenticated só SELECT; service_role só SELECT+INSERT
-- (nem o admin client tem UPDATE/DELETE — defesa em profundidade além do
-- trigger).

GRANT SELECT, INSERT, UPDATE ON public.crm_persons               TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.crm_organizations         TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.crm_company_contacts      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.crm_channels              TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.crm_channel_identities    TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.crm_person_customer_links TO authenticated;
GRANT SELECT                 ON public.crm_consent_events        TO authenticated;
GRANT SELECT                 ON public.v_crm_consent_status      TO authenticated, service_role;

GRANT ALL ON public.crm_persons               TO service_role;
GRANT ALL ON public.crm_organizations         TO service_role;
GRANT ALL ON public.crm_company_contacts      TO service_role;
GRANT ALL ON public.crm_channels              TO service_role;
GRANT ALL ON public.crm_channel_identities    TO service_role;
GRANT ALL ON public.crm_person_customer_links TO service_role;
GRANT SELECT, INSERT ON public.crm_consent_events TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.crm_persons_id_seq               TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_organizations_id_seq         TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_company_contacts_id_seq      TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_channels_id_seq              TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_channel_identities_id_seq    TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_person_customer_links_id_seq TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_consent_events_id_seq        TO service_role;
