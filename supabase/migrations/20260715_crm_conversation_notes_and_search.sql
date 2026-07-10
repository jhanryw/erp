-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 9: Atendimento básico da Inbox.
--
-- Escopo desta migration: tabela de notas internas + RPC de busca. Nenhuma
-- coluna nova em crm_conversations/crm_messages, nenhuma mudança de
-- contrato existente — tudo aditivo.
--
-- Decisões desta entrega (aprovadas em revisão):
--   1. Notas internas em tabela própria (crm_conversation_notes), NÃO numa
--      coluna solta em crm_conversations — uma coluna única perderia
--      histórico (cada nota sobrescreveria a anterior). created_by é
--      NOT NULL (nota sempre tem autor humano, sem origem de automação
--      nesta entrega) — é o mesmo campo que a atribuição de atendente
--      (fora de escopo aqui, decisão explícita do usuário) vai reaproveitar
--      no futuro. PRÓXIMO PASSO NATURAL, não implementado agora:
--      `ALTER TABLE crm_conversations ADD COLUMN assigned_to UUID
--       REFERENCES auth.users(id)` — documentado aqui só como intenção,
--      criar a coluna agora seria migration sem consumidor nesta entrega.
--   2. Busca por pessoa/telefone/última mensagem via RPC com parâmetro
--      bindado (rpc_search_crm_conversations), não via `.or()` concatenado
--      no PostgREST — decisão explícita: `.or()` construído por
--      interpolação de string do termo digitado pelo usuário é vulnerável a
--      quebra/manipulação do filtro (vírgula, %, _, parênteses no termo).
--      A RPC evita isso porque o termo entra como parâmetro plpgsql, nunca
--      como texto SQL concatenado.
--   3. Transições de status (open/pending/closed) continuam livres — sem
--      máquina de estados nesta entrega (decisão explícita do usuário).
--      O tratamento do conflito de reabertura (índice único parcial de
--      conversa aberta por canal/identidade) fica na service layer
--      (conversations.service.ts), não aqui — é validação de aplicação,
--      não de schema.
-- =============================================================================

-- ─── 1. crm_conversation_notes ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.crm_conversation_notes (
  id              BIGSERIAL    PRIMARY KEY,
  company_id      INT          NOT NULL REFERENCES public.companies(id),
  conversation_id BIGINT       NOT NULL REFERENCES public.crm_conversations(id), -- sem ON DELETE (RESTRICT implícito) — mesmo princípio de crm_messages.conversation_id: CRM é histórico operacional
  content         TEXT         NOT NULL,
  created_by      UUID         NOT NULL REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_conversation_notes_conversation
  ON public.crm_conversation_notes(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_conversation_notes_company
  ON public.crm_conversation_notes(company_id);

ALTER TABLE public.crm_conversation_notes ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de crm_messages: SELECT-only para authenticated — a escrita
-- sempre passa pela API (requireRole valida sessão/role, admin client grava
-- created_by = usuário da sessão), nunca INSERT direto do lado do cliente.
DROP POLICY IF EXISTS "crm_conversation_notes_select" ON public.crm_conversation_notes;
CREATE POLICY "crm_conversation_notes_select" ON public.crm_conversation_notes FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

GRANT SELECT       ON public.crm_conversation_notes TO authenticated;
GRANT ALL          ON public.crm_conversation_notes TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.crm_conversation_notes_id_seq TO service_role, authenticated;

-- ─── 2. rpc_search_crm_conversations ─────────────────────────────────────────
-- Busca por nome da pessoa, valor da identidade de canal (telefone/handle) ou
-- conteúdo da última mensagem — numa RPC pra permitir OR entre 3 tabelas
-- diferentes com parâmetro bindado (não string concatenada), evitando o
-- problema de escape do `.or()` do PostgREST. Retorna só os IDs que batem;
-- quem pagina/ordena continua sendo listConversations() normalmente, com
-- um filtro `.in('id', ...)` a mais.

CREATE OR REPLACE FUNCTION public.rpc_search_crm_conversations(
  p_company_id int,
  p_search     text
)
RETURNS TABLE (conversation_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT c.id
  FROM crm_conversations c
  JOIN crm_persons p ON p.id = c.person_id
  JOIN crm_channel_identities ci ON ci.id = c.channel_identity_id
  LEFT JOIN v_crm_conversation_last_message lm ON lm.conversation_id = c.id
  WHERE c.company_id = p_company_id
    AND (
      p.display_name ILIKE '%' || p_search || '%'
      OR ci.value    ILIKE '%' || p_search || '%'
      OR lm.content  ILIKE '%' || p_search || '%'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_search_crm_conversations(int, text)
  TO service_role, authenticated;
