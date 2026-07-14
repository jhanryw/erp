-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Parte A: mensagens fromMe=true (enviadas
-- diretamente no WhatsApp, fora do CRM).
--
-- crm_messages.created_source ganha 'external_echo' — diferencia
-- explicitamente outbound originado pelo CRM ('manual', já existente) de
-- outbound recebido depois via webhook porque o agente mandou direto no
-- WhatsApp conectado, não pelo ERP. Mesmo padrão já usado pra 'sticker'
-- (20260716) e 'contact' (20260711): CHECK ampliado, aditivo.
--
-- Não é uma mensagem nova de verdade quando o CRM já enviou e a Evolution
-- ecoa de volta (mesmo external_message_id) — nesse caso a idempotência já
-- existente (uq_crm_messages_external_id) barra a duplicata antes de
-- chegar aqui, sem precisar de created_source novo. 'external_echo' só se
-- aplica quando a mensagem NUNCA passou pelo ERP antes.
-- =============================================================================

ALTER TABLE public.crm_messages DROP CONSTRAINT IF EXISTS crm_messages_created_source_check;
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_created_source_check
  CHECK (created_source IN ('manual', 'automation', 'inbound_webhook', 'external_echo', 'other'));
