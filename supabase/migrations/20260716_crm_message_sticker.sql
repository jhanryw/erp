-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 2 do versionamento de contrato N8N→ERP:
-- suporte a sticker.
--
-- crm_messages.content_type ganha 'sticker' — mesmo padrão da Entrega 4
-- (20260711_crm_media_attachments.sql), que já ampliou este CHECK para
-- 'contact'. Sticker chega como mídia (mesmo fluxo de attachment via Media
-- Hub já usado por image/audio/video/document), só precisa de um
-- content_type próprio para o consumidor da API distinguir a renderização
-- de uma imagem comum.
--
-- Alteração aditiva única — nenhuma outra coluna/tabela tocada, nenhuma
-- migration antiga alterada.
-- =============================================================================

ALTER TABLE public.crm_messages DROP CONSTRAINT IF EXISTS crm_messages_content_type_check;
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_content_type_check
  CHECK (content_type IN ('text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'sticker', 'other'));
