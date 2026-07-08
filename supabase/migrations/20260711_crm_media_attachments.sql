-- =============================================================================
-- Fase 3 (CRM Omnichannel) — Entrega 4: integração real CRM ↔ Evolution ↔
-- Media Hub. Ampliações aditivas em 3 tabelas existentes — nenhuma alteração
-- destrutiva, nenhum dado existente tocado.
--
-- 1. crm_messages ganha `metadata JSONB` (localização/contato/payload bruto
--    de tipos futuros, mesmo padrão de extensibilidade de `media.metadata`)
--    e `content_type` ganha 'contact' (vCard do WhatsApp).
--
-- 2. media.created_source ganha 'channel_inbound' — mídia recebida via
--    automação de canal (N8N/Evolution) não se encaixava em nenhum valor
--    existente (upload/migration/marketplace/import/camera/api).
--
-- 3. media_usages.entity_type ganha 'crm_message' — decisão que ficou
--    deliberadamente pendente desde a Entrega 2 (ver 20260709_crm_
--    conversations_layer.sql), agora feita com política de autorização
--    explícita definida em código (não em migration):
--      - ALLOWED_ROLES_BY_ENTITY['crm_message'] = ['attachment'] em
--        media.service.ts — real, usada pela ingestão interna do CRM.
--      - As 3 rotas humanas do Media Hub (usages POST/DELETE, primary POST)
--        BLOQUEIAM crm_message explicitamente — POST via zod schema que
--        deliberadamente não lista 'crm_message' (mediaUsageSchema/
--        bodySchema locais ficam intocados), DELETE via guard explícito no
--        próprio handler antes da checagem de role. Decisão do usuário:
--        nada de "aceitar com lista de role vazia" — bloqueio tem que ser
--        explícito na fronteira HTTP, liberação só pela service layer
--        interna do CRM (chamada direta de função, nunca via rota).
--
-- Fora de escopo: media_renditions (pendência geral do Media Hub, não
-- exclusiva do CRM), pgvector/embeddings, antivírus.
-- =============================================================================

ALTER TABLE public.crm_messages ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE public.crm_messages DROP CONSTRAINT IF EXISTS crm_messages_content_type_check;
ALTER TABLE public.crm_messages ADD CONSTRAINT crm_messages_content_type_check
  CHECK (content_type IN ('text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'other'));

ALTER TABLE public.media DROP CONSTRAINT IF EXISTS media_created_source_check;
ALTER TABLE public.media ADD CONSTRAINT media_created_source_check
  CHECK (created_source IN ('upload', 'migration', 'marketplace', 'import', 'camera', 'api', 'channel_inbound'));

ALTER TABLE public.media_usages DROP CONSTRAINT IF EXISTS media_usages_entity_type_check;
ALTER TABLE public.media_usages ADD CONSTRAINT media_usages_entity_type_check
  CHECK (entity_type IN ('product', 'product_variation', 'shipment', 'crm_message'));

-- Nota: os nomes de constraint acima seguem a convenção padrão do Postgres
-- para CHECK inline sem nome explícito (<tabela>_<coluna>_check) — mesma
-- lógica já documentada na Entrega 2 para media_usages. Ao aplicar, confirme
-- que os 3 ALTER tiveram efeito (um insert de teste com cada valor novo deve
-- passar) antes de seguir para o próximo passo.
