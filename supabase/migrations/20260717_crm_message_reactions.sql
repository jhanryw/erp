-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 5 do versionamento de contrato N8N→ERP:
-- reactions.
--
-- Uma reaction do WhatsApp (via Evolution/Baileys) não é uma nova mensagem:
-- sem `content`, sem ciclo de status de entrega — forçá-la em crm_messages
-- quebraria o CHECK de `status`. Tabela própria.
--
-- Confirmação técnica (protocolo WhatsApp Web multi-device/Baileys, que a
-- Evolution API encapsula, evento `reactionMessage`): uma reaction é sempre
-- por (mensagem original, quem reagiu) — reagir de novo com outro emoji
-- SUBSTITUI a reação anterior da mesma pessoa na mesma mensagem (nunca
-- acumula, mesmo em grupo — reação é por participante individual); reagir
-- com string vazia REMOVE. Logo UNIQUE(message_id, channel_identity_id) —
-- no máximo 1 reação ativa por pessoa por mensagem — representa
-- corretamente o protocolo. Baseado em documentação pública do protocolo,
-- não em payload real capturado desta integração — validar contra um
-- payload real assim que disponível.
--
-- Sem ON DELETE CASCADE em message_id/channel_identity_id — mesma política
-- de preservação de histórico já usada em crm_messages/crm_conversations
-- (RESTRICT implícito).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.crm_message_reactions (
  id                    BIGSERIAL    PRIMARY KEY,
  company_id            INT          NOT NULL REFERENCES public.companies(id),
  message_id            BIGINT       NOT NULL REFERENCES public.crm_messages(id),           -- sem CASCADE, histórico operacional
  channel_identity_id   BIGINT       NOT NULL REFERENCES public.crm_channel_identities(id),  -- quem reagiu, sem CASCADE
  emoji                 TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- No máximo 1 reação ativa por pessoa por mensagem (ver confirmação acima).
-- upsert (ON CONFLICT nesta chave) é o que implementa "trocar emoji" e
-- "evitar duplicidade" na camada de aplicação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_message_reactions_message_identity
  ON public.crm_message_reactions(message_id, channel_identity_id);

CREATE INDEX IF NOT EXISTS idx_crm_message_reactions_company ON public.crm_message_reactions(company_id);
CREATE INDEX IF NOT EXISTS idx_crm_message_reactions_message ON public.crm_message_reactions(message_id);

ALTER TABLE public.crm_message_reactions ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de crm_messages: SELECT para authenticated por company_id,
-- escrita sempre via service_role (rota de automação), nunca rota humana.
CREATE POLICY "crm_message_reactions_company" ON public.crm_message_reactions FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());
