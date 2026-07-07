-- Media Hub — Fase 2, Entrega 1: schema aditivo.
--
-- Serviço oficial de arquivos do ERP: media, media_renditions, media_usages.
-- Nenhum domínio é dono das mídias — todos referenciam via media_usages
-- (vínculo polimórfico, mesmo padrão já usado em audit_logs.resource/resource_id).
--
-- Puramente aditivo. Nenhuma tabela existente é alterada. Nenhuma API, UI ou
-- fluxo de cadastro/edição/importação lê estas tabelas ainda — é só a base
-- de dados, seguindo a mesma metodologia da Fase 1 (auditoria → arquitetura →
-- pequenas entregas → aprovação antes de cada uma).
--
-- Fora de escopo desta entrega, por decisão explícita:
--   - bucket do Supabase Storage (ação em serviço externo, entrega própria)
--   - RLS (entrega própria, futura)
--   - migração de dado legado (products.photo_url, product_variations.photo_url,
--     shipments.proof_url permanecem intocados)
--   - qualquer API/UI consumidora

DO $$ BEGIN
  CREATE TYPE media_status AS ENUM ('processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.media (
  id                BIGSERIAL     PRIMARY KEY,
  public_id         UUID          NOT NULL DEFAULT gen_random_uuid(),
  company_id        INT           NOT NULL REFERENCES public.companies(id),
  storage_key       TEXT,
  external_url      TEXT,
  visibility        TEXT          NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  original_filename TEXT,
  extension         TEXT,
  mime_type         TEXT          NOT NULL,
  file_size         BIGINT        NOT NULL CHECK (file_size > 0),
  width             INT,
  height            INT,
  checksum_sha256   TEXT,
  status            media_status  NOT NULL DEFAULT 'ready',
  created_source    TEXT          NOT NULL
                      CHECK (created_source IN ('upload', 'migration', 'marketplace', 'import', 'camera', 'api')),
  metadata          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by       UUID          REFERENCES auth.users(id) ON DELETE SET NULL,
  alt_text          TEXT,
  active            BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_media_public_id UNIQUE (public_id),
  CONSTRAINT chk_media_storage_xor CHECK (
    (storage_key IS NOT NULL) <> (external_url IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_storage_key ON public.media(storage_key)
  WHERE storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_company  ON public.media(company_id);
CREATE INDEX IF NOT EXISTS idx_media_checksum ON public.media(company_id, checksum_sha256)
  WHERE checksum_sha256 IS NOT NULL;
-- não único por decisão explícita — deduplicação fica para entrega futura,
-- depois que o upload real existir e o comportamento de reenvio for observado.

CREATE TABLE IF NOT EXISTS public.media_renditions (
  id           BIGSERIAL   PRIMARY KEY,
  media_id     BIGINT      NOT NULL REFERENCES public.media(id) ON DELETE CASCADE,
  variant      TEXT        NOT NULL CHECK (variant IN ('thumbnail', 'medium', 'large')),
  storage_key  TEXT        NOT NULL,
  mime_type    TEXT        NOT NULL,
  width        INT,
  height       INT,
  file_size    BIGINT      NOT NULL CHECK (file_size > 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (media_id, variant)
);

CREATE TABLE IF NOT EXISTS public.media_usages (
  id           BIGSERIAL   PRIMARY KEY,
  media_id     BIGINT      NOT NULL REFERENCES public.media(id) ON DELETE RESTRICT,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('product', 'product_variation', 'shipment')),
  entity_id    TEXT        NOT NULL,
  role         TEXT        NOT NULL DEFAULT 'gallery'
                 CHECK (role IN ('primary', 'gallery', 'logo', 'banner', 'avatar', 'proof', 'attachment', 'document')),
  position     INT         NOT NULL DEFAULT 0,
  company_id   INT         NOT NULL REFERENCES public.companies(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,

  UNIQUE (entity_type, entity_id, role, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_media_usages_singular_role
  ON public.media_usages(entity_type, entity_id, role)
  WHERE role IN ('primary', 'logo', 'banner', 'avatar');

CREATE INDEX IF NOT EXISTS idx_media_usages_entity  ON public.media_usages(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_media_usages_media   ON public.media_usages(media_id);
CREATE INDEX IF NOT EXISTS idx_media_usages_company ON public.media_usages(company_id);
