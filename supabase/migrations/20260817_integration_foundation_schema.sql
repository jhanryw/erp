-- FASE 2 (Integration Foundation) — fundação genérica de integrações
-- externas, multi-tenant. Nenhuma chamada externa real (Chatwoot/Meta/n8n)
-- é feita nesta fase — só schema, services e emissão transacional de
-- eventos de domínio. Ver relatório da Fase 2 para a justificativa de cada
-- decisão de modelagem.
--
-- Pré-condição (companies): `public.companies` não tem CREATE TABLE
-- rastreável em `supabase/migrations/` (achado da Fase 0, ainda NÃO
-- CONFIRMADO contra o banco real). As FKs abaixo usam `INT REFERENCES
-- public.companies(id)` — o MESMO padrão já usado com sucesso em
-- `customers`, `crm_persons`, `crm_person_customer_links` e dezenas de
-- outras tabelas rastreadas neste repositório, nunca inventado agora. Não é
-- uma suposição nova: é reaproveitar um padrão já comprovado. O que
-- continua bloqueado até confirmação real (script
-- fase0_confirmar_schema_producao.sql, bloco 1) é qualquer migration que
-- crie/altere a PRÓPRIA tabela `companies` — isso não é feito aqui.

-- =============================================================================
-- 1. company_integrations
-- =============================================================================
--
-- provider: TEXT + CHECK (não ENUM) — de propósito. Um ENUM Postgres exige
-- ALTER TYPE ... ADD VALUE pra cada provider novo (não roda dentro de
-- transação em versões antigas do Postgres, e mesmo em versões novas é uma
-- migration cerimoniosa pra algo que vai crescer com frequência — Chatwoot,
-- Meta, Nuvemshop hoje; WhatsApp Cloud API, Google Ads, TikTok amanhã). CHECK
-- constraint dá o mesmo controle (não aceita valor arbitrário) com uma
-- migration trivial (DROP+ADD CONSTRAINT) pra adicionar provider novo — já é
-- o padrão dominante neste projeto (match_source, content_type, event_type
-- de post_sale_automation_events etc. — nenhum é ENUM).
--
-- external_account_id: coluna própria, NUNCA dentro de `settings` (JSON) —
-- decisão explícita (ver seção 34 do pedido da Fase 2): é a chave que um
-- webhook recebido vai usar pra resolver "de qual empresa é isso", precisa
-- ser indexável/comparável direto, não land dentro de um blob JSON.
--
-- Unicidade: NÃO existe `UNIQUE(company_id, provider)` — uma empresa pode
-- ter mais de uma conta do mesmo provider (2 lojas Nuvemshop, 2 pixels Meta).
-- Em vez disso, um índice único GLOBAL (todas as empresas) em
-- `(provider, external_account_id) WHERE external_account_id IS NOT NULL` —
-- garante que a MESMA conta externa nunca é acidentalmente vinculada a duas
-- empresas diferentes (o mesmo raciocínio de segurança já usado em
-- `crm_channels.provider_instance_identifier`, Fase 3 do CRM: sem isso, um
-- erro de configuração causaria resolução ambígua de tenant a partir de um
-- webhook — risco de vazamento cross-tenant). Enquanto external_account_id
-- ainda não é conhecido (integração em configuração, sem OAuth completo
-- ainda), múltiplas linhas com NULL convivem sem conflito — semântica padrão
-- de índice único do Postgres (NULL nunca colide com NULL).

CREATE TABLE IF NOT EXISTS public.company_integrations (
  id                   BIGSERIAL    PRIMARY KEY,
  company_id           INT          NOT NULL REFERENCES public.companies(id),
  provider             TEXT         NOT NULL
                          CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop')),
  external_account_id  TEXT,        -- ex.: account_id do Chatwoot, pixel/business id do Meta, store_id do Nuvemshop. NULL até a integração ser configurada/validada.
  status               TEXT         NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'inactive', 'error')),
  settings             JSONB        NOT NULL DEFAULT '{}'::jsonb, -- NUNCA secrets aqui — só config não sensível (base_url, account_id de exibição, inbox_ids, pixel_id...)
  last_error           TEXT,        -- diagnóstico de status='error', nunca um segredo
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by           UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_integrations_provider_account
  ON public.company_integrations (provider, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_company_integrations_company ON public.company_integrations (company_id);
CREATE INDEX IF NOT EXISTS idx_company_integrations_provider_status ON public.company_integrations (provider, status);

CREATE OR REPLACE FUNCTION public.company_integrations_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_company_integrations_touch_updated_at ON public.company_integrations;
CREATE TRIGGER trg_company_integrations_touch_updated_at
  BEFORE UPDATE ON public.company_integrations
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- =============================================================================
-- 2. integration_secrets
-- =============================================================================
--
-- Tabela SEPARADA de company_integrations (opção B do pedido da Fase 2), não
-- uma coluna `ciphertext` a mais em company_integrations (opção A).
-- Justificativa: um único provider frequentemente precisa de MAIS de um
-- segredo (Chatwoot = API token + webhook signing secret; um futuro OAuth
-- de qualquer provider = access_token + refresh_token) — opção A exigiria
-- empacotar múltiplos segredos num único blob cifrado (perde a capacidade de
-- rotacionar um sem re-cifrar os outros) ou colunas fixas por segredo
-- conhecido (não escala pra provider novo sem migration de schema). Tabela
-- separada com `key` livre (mas único por integration_id) resolve os dois:
-- `getIntegrationSecret(integrationId, 'webhook_secret')` é uma função só,
-- nunca decodifica sem essa chamada explícita — reforça a regra "secret
-- nunca volta junto da integração por padrão" (seção 14 do pedido).
--
-- `ciphertext`: AES-256-GCM (autenticado), pacote auto-contido
-- iv(12)||authTag(16)||dados, base64 — nunca Base64 sozinho, nunca hash (teria
-- que ser recuperável). Master key nunca fica no banco — só em variável de
-- ambiente do processo Next.js (mesmo nível de confiança que
-- SUPABASE_SERVICE_ROLE_KEY já tem hoje), versionada (`key_version`) pra
-- permitir rotação sem exigir re-cifrar tudo no mesmo instante. Ver
-- `src/lib/security/secretCipher.ts` e relatório da Fase 2, seção B, pro
-- threat model completo.

CREATE TABLE IF NOT EXISTS public.integration_secrets (
  id              BIGSERIAL    PRIMARY KEY,
  integration_id  BIGINT       NOT NULL REFERENCES public.company_integrations(id) ON DELETE CASCADE,
  company_id      INT          NOT NULL REFERENCES public.companies(id), -- redundante com integration_id->company_id, mesmo padrão já usado em media_usages/crm_person_customer_links (RLS/query direta sem join)
  key             TEXT         NOT NULL, -- ex.: 'api_token', 'webhook_secret', 'oauth_refresh_token' — livre, não é ENUM (cada provider tem os seus)
  ciphertext      TEXT         NOT NULL, -- base64(iv || authTag || dados), nunca plaintext, nunca Base64 sozinho
  key_version     INT          NOT NULL, -- qual master key (env var) foi usada — necessário pra decifrar e pra rotação
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (integration_id, key)
);

CREATE INDEX IF NOT EXISTS idx_integration_secrets_company ON public.integration_secrets (company_id);

DROP TRIGGER IF EXISTS trg_integration_secrets_touch_updated_at ON public.integration_secrets;
CREATE TRIGGER trg_integration_secrets_touch_updated_at
  BEFORE UPDATE ON public.integration_secrets
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- =============================================================================
-- 3. external_entity_links
-- =============================================================================
--
-- Separada de identidade humana (crm_channel_identities) de propósito —
-- decisão já fechada antes desta fase: um `chatwoot_contact_id` é uma
-- REFERÊNCIA a uma entidade em sistema externo, não uma identidade de
-- pessoa (telefone/email/@handle). Ver seção 2 do pedido da Fase 2.
--
-- entity_type: CHECK controlado (não FK polimórfica falsa — Postgres não
-- suporta FK que aponte pra "uma tabela ou outra" de forma segura; a
-- integridade real vem da camada de serviço, igual já é feito em
-- `media_usages.entity_type`/`entity_id` e `audit_logs.resource`/`resource_id`
-- — mesmo padrão idiomático deste schema, não uma invenção nova).
-- entity_id é TEXT mesmo `crm_persons.id` sendo bigint e `customers.id`
-- sendo int — unifica o tipo do lado polimórfico sem forçar cast condicional
-- em toda query.
--
-- external_id: SEMPRE text, mesmo o Chatwoot usando inteiro hoje — nunca
-- amarra a bigint (seção 12 do pedido: providers futuros podem usar
-- UUID/string/id composto).

-- `active`: soft-delete, mesmo padrão já usado em crm_channel_identities/
-- crm_person_customer_links — permite desfazer um link (ex.: contato
-- mesclado errado no Chatwoot) e recriar depois sem colidir com o índice
-- único de um link antigo já inativo.
CREATE TABLE IF NOT EXISTS public.external_entity_links (
  id                     BIGSERIAL    PRIMARY KEY,
  company_id             INT          NOT NULL REFERENCES public.companies(id),
  integration_id         BIGINT       NOT NULL REFERENCES public.company_integrations(id) ON DELETE CASCADE,
  provider               TEXT         NOT NULL, -- redundante com integration_id->provider (mesmo padrão de crm_messages.channel_id redundante com crm_conversations.channel_id — decisão já usada no CRM: idempotência/performance/auditoria sem join)
  entity_type            TEXT         NOT NULL
                            CHECK (entity_type IN ('crm_person', 'crm_conversation', 'customer')),
  entity_id              TEXT         NOT NULL,
  external_entity_type   TEXT         NOT NULL, -- nomenclatura do provider: 'contact', 'conversation', 'customer' etc.
  external_id            TEXT         NOT NULL,
  metadata               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  active                 BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Impede o mesmo contato/conversa externa virar dono de 2 linhas ATIVAS
-- nesta integração (ex.: 2 crm_persons "roubando" o mesmo Chatwoot contact).
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_entity_links_external
  ON public.external_entity_links (integration_id, external_entity_type, external_id)
  WHERE active;

-- Impede recriar o mesmo link repetidamente (idempotência) — uma entidade
-- interna só tem 1 referência ATIVA por (integração, tipo externo). Não
-- impede a MESMA entidade interna ter links em integrações diferentes
-- (providers diferentes) nem tipos externos diferentes na mesma integração.
CREATE UNIQUE INDEX IF NOT EXISTS uq_external_entity_links_internal
  ON public.external_entity_links (integration_id, entity_type, entity_id, external_entity_type)
  WHERE active;

CREATE INDEX IF NOT EXISTS idx_external_entity_links_company ON public.external_entity_links (company_id);
CREATE INDEX IF NOT EXISTS idx_external_entity_links_entity ON public.external_entity_links (entity_type, entity_id);

DROP TRIGGER IF EXISTS trg_external_entity_links_touch_updated_at ON public.external_entity_links;
CREATE TRIGGER trg_external_entity_links_touch_updated_at
  BEFORE UPDATE ON public.external_entity_links
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- =============================================================================
-- 4. integration_outbox
-- =============================================================================
--
-- Uma linha por EVENTO DE DOMÍNIO, não uma linha por destino (Meta/
-- Chatwoot/n8n) — opção A do pedido da Fase 2 (seção 20), não a opção B
-- ("integration_event_deliveries" separada) que o usuário disse preferir
-- arquiteturalmente. Escolhido A porque, nesta fase, ZERO consumidor existe
-- — nenhum worker Meta/Chatwoot/n8n foi construído ainda (proibido
-- explicitamente nesta fase), então "destino" não é um conceito real ainda:
-- não dá pra saber hoje se um evento vai pra 1, 2 ou 3 destinos, e decidir
-- isso agora seria inventar requisito sem consumidor, o mesmo tipo de
-- decisão que este projeto já evitou antes (ver
-- crm_conversations.assigned_to, adiado por falta de consumidor real).
-- Quando o primeiro consumidor de verdade for construído (Fase 6, Meta
-- CAPI), aí sim dá pra decidir com informação real se vale a pena separar
-- em `integration_event_deliveries` — esta tabela não muda pra isso
-- acontecer, só nasce uma tabela nova ao lado.
--
-- event_id: idempotência determinística (`sale:<id>:completed` etc.) — UNIQUE.
-- aggregate_id: TEXT (mesmo padrão de external_entity_links.entity_id, id de
-- domínio pode não ser sempre int no futuro).
-- status: pending → processing → processed | failed → dead. 5 estados, não
-- mais — "falhou agora" (failed, pode tentar de novo) é distinto de "falhou
-- definitivamente" (dead, esgotou tentativas) conforme pedido.
-- available_at/attempts/last_error: preparam exponential backoff futuro,
-- sem implementar o scheduler agora (proibido nesta fase).
-- locked_at/locked_by: suportam `FOR UPDATE SKIP LOCKED` multi-worker
-- futuro — ver rpc_claim_outbox_events abaixo.

CREATE TABLE IF NOT EXISTS public.integration_outbox (
  id              BIGSERIAL    PRIMARY KEY,
  company_id      INT          NOT NULL REFERENCES public.companies(id),
  event_id        TEXT         NOT NULL UNIQUE,
  event_type      TEXT         NOT NULL
                     CHECK (event_type IN ('sale.completed', 'sale.cancelled', 'sale.refunded')),
  aggregate_type  TEXT         NOT NULL
                     CHECK (aggregate_type IN ('sale')),
  aggregate_id    TEXT         NOT NULL,
  payload         JSONB        NOT NULL,
  status          TEXT         NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead')),
  attempts        INT          NOT NULL DEFAULT 0,
  available_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  last_error      TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_outbox_company_created ON public.integration_outbox (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_outbox_status_available ON public.integration_outbox (status, available_at);
CREATE INDEX IF NOT EXISTS idx_integration_outbox_event_type ON public.integration_outbox (event_type);
CREATE INDEX IF NOT EXISTS idx_integration_outbox_aggregate ON public.integration_outbox (aggregate_type, aggregate_id);

-- ─── Claim concorrente (SKIP LOCKED) ────────────────────────────────────────
-- Nenhum worker real consome isso nesta fase (proibido) — existe pra provar,
-- com teste de concorrência real (ver
-- supabase/tests/integration_outbox_claim.concurrency.md, mesmo padrão de
-- 2 terminais já usado em rpc_import_products_batch.concurrency.md), que o
-- desenho suporta múltiplos workers futuros sem processar o mesmo evento
-- duas vezes.
CREATE OR REPLACE FUNCTION public.rpc_claim_outbox_events(
  p_limit     int  DEFAULT 10,
  p_worker_id text DEFAULT 'unknown'
)
RETURNS SETOF public.integration_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.integration_outbox
  SET status     = 'processing',
      locked_at  = NOW(),
      locked_by  = p_worker_id,
      attempts   = attempts + 1
  WHERE id IN (
    SELECT id FROM public.integration_outbox
    WHERE status = 'pending' AND available_at <= NOW()
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_claim_outbox_events(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_claim_outbox_events(int, text) TO service_role;

-- =============================================================================
-- 5. RLS
-- =============================================================================
-- Deny-by-default pro browser: nenhuma policy dá acesso a `authenticated`
-- em nenhuma das 4 tabelas — são dados operacionais server-side (secrets,
-- outbox, mapeamento de integração externa), nunca consumidos por
-- componente client-side. `service_role` bypassa RLS (mesmo padrão já
-- estabelecido em todo o projeto) — a barreira real de tenant é o filtro
-- explícito de `company_id` nos services (seção 33 do pedido).

ALTER TABLE public.company_integrations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_secrets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_entity_links  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_outbox     ENABLE ROW LEVEL SECURITY;

-- Nenhuma CREATE POLICY — RLS habilitada sem nenhuma policy = deny total pra
-- qualquer role que não seja o dono/service_role (mesmo padrão já usado em
-- authorization_tokens: "Acesso restrito ao service_role — nenhuma policy
-- pública necessária").

REVOKE ALL ON public.company_integrations   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.integration_secrets    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.external_entity_links  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.integration_outbox     FROM PUBLIC, anon, authenticated;

GRANT ALL ON public.company_integrations   TO service_role;
GRANT ALL ON public.integration_secrets    TO service_role;
GRANT ALL ON public.external_entity_links  TO service_role;
GRANT ALL ON public.integration_outbox     TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.company_integrations_id_seq   TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.integration_secrets_id_seq    TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.external_entity_links_id_seq  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.integration_outbox_id_seq     TO service_role;
