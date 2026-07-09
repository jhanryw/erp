-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 7: Inbox Omnichannel.
--
-- Única migration desta entrega: 1 view read-only pra resolver "última
-- mensagem por conversa" em lote, sem duplicar dado em crm_conversations
-- (decisão já tomada na Entrega 2 e mantida aqui — a Inbox resolve isso por
-- consulta, não por coluna denormalizada). Mesmo idioma DISTINCT ON já
-- usado em v_crm_consent_status.
--
-- Nenhuma tabela nova, nenhuma coluna nova, nenhum índice novo (os já
-- existentes cobrem as consultas da Inbox), nenhuma RPC nova.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_crm_conversation_last_message AS
SELECT DISTINCT ON (conversation_id)
  conversation_id,
  id AS message_id,
  content,
  content_type,
  direction,
  status,
  created_at
FROM public.crm_messages
ORDER BY conversation_id, created_at DESC, id DESC;

GRANT SELECT ON public.v_crm_conversation_last_message TO authenticated, service_role;
