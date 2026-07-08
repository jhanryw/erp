-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 2: camada de conversas.
--
-- Escopo: crm_conversations + crm_messages, sobre a camada de identidade da
-- Entrega 1 (20260708_crm_identity_layer.sql). Puramente schema + service
-- layer — sem API, rota, UI ou integração N8N/Evolution real ainda (fica
-- para a Entrega 3). Núcleo estrutural continua com FK explícita, nunca
-- entity_type/entity_id (Ajuste 3 da Fase 3).
--
-- Sem anexo de mídia nesta entrega. media_usages.entity_type NÃO é alterado —
-- decidido em revisão que autorização de anexo (que role/rota pode vincular
-- mídia a uma mensagem) é política própria, não deve ser decidida de
-- passagem por causa de um erro de type-check em ALLOWED_ROLES_BY_ENTITY/
-- ROLE_BY_ENTITY (código existente do Media Hub, Fase 2). O vínculo mídia↔
-- mensagem fica para a Entrega 3, junto do desenho da ingestão real via
-- N8N/Evolution/service_role — provavelmente o caminho de escrita real nunca
-- passa pelas 3 rotas HTTP atuais do Media Hub (pensadas para usuário
-- autenticado via sessão), então decidir a política agora seria prematuro.
--
-- Decisões desta entrega (aprovadas em revisão):
--   1. crm_conversations vincula channel_id (crm_channels — qual instância
--      operacional) e channel_identity_id (crm_channel_identities — qual
--      identidade da pessoa) separadamente, porque o mesmo número de uma
--      pessoa pode ser alcançado por mais de um canal da empresa. Nada no
--      banco garante que os dois tenham o mesmo channel_type — isso é
--      checado na service layer (channelAndIdentityTypesMatch()), mesma
--      categoria de entityBelongsToCompany()/organizationAndPersonBelongToCompany()
--      já usadas no Media Hub e na Entrega 1.
--   2. Idempotência em dois níveis: (a) no máximo uma conversa 'open'/'pending'
--      por (channel_id, channel_identity_id) — índice único parcial, protege
--      contra corrida de duas mensagens inbound quase simultâneas; (b)
--      external_message_id + n8n_execution_id em crm_messages, mesmo padrão
--      já usado em post_sale_automation_events.
--   3. crm_messages.channel_id é explícito (redundante com
--      crm_conversations.channel_id) — decisão do usuário: usado na chave de
--      idempotência (channel_id, external_message_id), em performance de
--      consulta e em auditoria, sem depender de join com crm_conversations.
--   4. crm_messages.conversation_id é RESTRICT, não CASCADE — decisão do
--      usuário: CRM é histórico operacional, conversa com mensagens nunca é
--      hard-deletável. Pela mesma razão, as FKs de crm_conversations para
--      crm_channels/crm_channel_identities/crm_persons também ficam sem
--      ON DELETE explícito (NO ACTION/RESTRICT implícito) — não é só a
--      relação que o usuário apontou, é o mesmo princípio aplicado de forma
--      consistente às demais FKs estruturais desta entrega.
--   5. status de crm_messages é uma única coluna cobrindo os dois sentidos
--      (inbound nasce 'received', outbound nasce 'pending' e evolui) — sem
--      colunas separadas sent_at/delivered_at/read_at nesta entrega
--      (decisão deliberada de não desenhar granularidade que a integração
--      real ainda não confirmou que a Evolution API entrega de forma
--      confiável). status_updated_at cobre a última transição.
--   6. last_message_at em crm_conversations é mantido por trigger (não por
--      convenção de código) — é um valor derivado de outra tabela
--      (crm_messages), e depender de todo código futuro lembrar de
--      atualizá-lo manualmente é frágil. Sem last_message_preview/
--      last_message_id — seriam otimização de UI que ainda não existe.
--
-- Fora de escopo desta entrega, por decisão explícita:
--   - qualquer API, rota, UI, componente, hook
--   - qualquer integração N8N/Evolution real
--   - qualquer alteração no Media Hub (media_usages.entity_type NÃO ganha
--     'crm_message' nesta entrega — anexo de mensagem fica sem suporte real
--     até a Entrega 3, quando a política de autorização de anexo puder ser
--     desenhada com atenção própria, não decidida de passagem por causa de
--     um erro de type-check em ALLOWED_ROLES_BY_ENTITY/ROLE_BY_ENTITY,
--     código existente do Media Hub, Fase 2)
--   - crm_leads, crm_pipelines, crm_opportunities, crm_tasks,
--     crm_timeline_events
-- =============================================================================

-- Nenhuma tabela pré-existente é tocada nesta entrega.

-- ─── 1. crm_conversations ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_conversations (
  id                   BIGSERIAL         PRIMARY KEY,
  company_id           INT               NOT NULL REFERENCES public.companies(id),
  channel_id           BIGINT            NOT NULL REFERENCES public.crm_channels(id),
  channel_identity_id  BIGINT            NOT NULL REFERENCES public.crm_channel_identities(id),
  person_id            BIGINT            NOT NULL REFERENCES public.crm_persons(id),
  status               TEXT              NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'pending', 'closed')),
  last_message_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- No máximo uma conversa aberta/pendente por (canal, identidade) — idempotência
-- de conversa, protege contra corrida de duas mensagens inbound concorrentes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_conversations_open_per_identity
  ON public.crm_conversations(channel_id, channel_identity_id) WHERE status IN ('open', 'pending');

CREATE INDEX IF NOT EXISTS idx_crm_conversations_company ON public.crm_conversations(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_person  ON public.crm_conversations(person_id);
CREATE INDEX IF NOT EXISTS idx_crm_conversations_channel ON public.crm_conversations(channel_id);

-- ─── 2. crm_messages ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_messages (
  id                  BIGSERIAL    PRIMARY KEY,
  company_id          INT          NOT NULL REFERENCES public.companies(id),
  conversation_id     BIGINT       NOT NULL REFERENCES public.crm_conversations(id), -- sem ON DELETE (RESTRICT implícito) — decisão explícita: CRM é histórico operacional
  channel_id          BIGINT       NOT NULL REFERENCES public.crm_channels(id),      -- redundante com crm_conversations.channel_id — decisão explícita: idempotência, performance e auditoria sem join
  person_id           BIGINT       NOT NULL REFERENCES public.crm_persons(id),       -- redundante, mesmo padrão de company_id em outras tabelas do CRM
  direction           TEXT         NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status              TEXT         NOT NULL
                         CHECK (status IN ('received', 'pending', 'sent', 'delivered', 'read', 'failed')),
  status_updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  content              TEXT,
  content_type         TEXT        NOT NULL
                         CHECK (content_type IN ('text', 'image', 'audio', 'video', 'document', 'location', 'other')),
  failure_reason       TEXT,
  external_message_id  TEXT,   -- id da mensagem no provider (ex. WAMID) — chave de idempotência de ingestão
  n8n_execution_id     TEXT,   -- idempotência secundária, mesmo campo/uso de post_sale_automation_events
  created_source       TEXT    NOT NULL
                         CHECK (created_source IN ('manual', 'automation', 'inbound_webhook', 'other')),
  created_by           UUID    REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotência primária: mesma mensagem do provider não é inserida duas vezes
-- (reentrega de webhook). Escopada por channel_id, não global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_messages_external_id
  ON public.crm_messages(channel_id, external_message_id) WHERE external_message_id IS NOT NULL;

-- Idempotência secundária (outbound, antes de existir external_message_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_messages_n8n_execution
  ON public.crm_messages(conversation_id, n8n_execution_id) WHERE n8n_execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_crm_messages_conversation
  ON public.crm_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_messages_company ON public.crm_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_messages_person  ON public.crm_messages(person_id);
CREATE INDEX IF NOT EXISTS idx_crm_messages_channel ON public.crm_messages(channel_id);

-- ─── Trigger: mantém crm_conversations.last_message_at em dia ────────────────
-- Valor derivado de outra tabela — não confiar em cada caminho de código
-- futuro (API, N8N, automação) lembrar de atualizar manualmente.

CREATE OR REPLACE FUNCTION public.crm_conversations_bump_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.crm_conversations
  SET last_message_at = NEW.created_at,
      updated_at      = NOW()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_messages_bump_conversation ON public.crm_messages;
CREATE TRIGGER trg_crm_messages_bump_conversation
  AFTER INSERT ON public.crm_messages
  FOR EACH ROW EXECUTE FUNCTION public.crm_conversations_bump_last_message();

-- ─── RLS ───────────────────────────────────────────────────────────────────
-- crm_conversations: FOR ALL company-scoped (mesmo padrão da Entrega 1),
-- sem GRANT de DELETE — status='closed' é a única forma de "encerrar".
-- crm_messages: SELECT-only para authenticated — nenhuma mutação de mensagem
-- vem direto de sessão de usuário (mesmo uma futura UI de resposta manual
-- passaria por uma API usando service_role); service_role tem UPDATE
-- legítimo aqui (progressão de status), diferente do ledger imutável de
-- crm_consent_events.

ALTER TABLE public.crm_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "crm_conversations_company" ON public.crm_conversations;
CREATE POLICY "crm_conversations_company" ON public.crm_conversations FOR ALL TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "crm_messages_company" ON public.crm_messages;
CREATE POLICY "crm_messages_company" ON public.crm_messages FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- ─── GRANTS ────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON public.crm_conversations TO authenticated;
GRANT SELECT                 ON public.crm_messages      TO authenticated;

GRANT ALL ON public.crm_conversations TO service_role;
GRANT ALL ON public.crm_messages      TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.crm_conversations_id_seq TO service_role, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.crm_messages_id_seq      TO service_role, authenticated;
