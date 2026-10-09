-- Banners do atacado: imagem mobile separada + textos opcionais (título,
-- subtítulo, botão) + flag para exibir só a imagem.
--
-- 100% aditiva: colunas nullable (ou com DEFAULT), nenhuma linha existente é
-- alterada de forma destrutiva. Banners atuais continuam idênticos
-- (sem textos, sem imagem mobile → usam a imagem desktop).
-- Reaplicável: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS.

ALTER TABLE public.wholesale_site_banners
  ADD COLUMN IF NOT EXISTS mobile_media_id BIGINT REFERENCES public.media(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS title           TEXT,
  ADD COLUMN IF NOT EXISTS subtitle        TEXT,
  ADD COLUMN IF NOT EXISTS cta_label       TEXT,
  -- true = exibe os textos sobre a imagem (quando preenchidos); false = só a imagem.
  ADD COLUMN IF NOT EXISTS show_text       BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.wholesale_site_banners DROP CONSTRAINT IF EXISTS chk_wholesale_site_banners_text_len;
ALTER TABLE public.wholesale_site_banners ADD CONSTRAINT chk_wholesale_site_banners_text_len CHECK (
  (title     IS NULL OR char_length(title)     BETWEEN 1 AND 80)  AND
  (subtitle  IS NULL OR char_length(subtitle)  BETWEEN 1 AND 160) AND
  (cta_label IS NULL OR char_length(cta_label) BETWEEN 1 AND 30)
);

CREATE INDEX IF NOT EXISTS idx_wholesale_site_banners_mobile_media
  ON public.wholesale_site_banners (mobile_media_id) WHERE mobile_media_id IS NOT NULL;

-- ROLLBACK
/*
DROP INDEX IF EXISTS public.idx_wholesale_site_banners_mobile_media;
ALTER TABLE public.wholesale_site_banners DROP CONSTRAINT IF EXISTS chk_wholesale_site_banners_text_len;
ALTER TABLE public.wholesale_site_banners
  DROP COLUMN IF EXISTS show_text, DROP COLUMN IF EXISTS cta_label,
  DROP COLUMN IF EXISTS subtitle, DROP COLUMN IF EXISTS title, DROP COLUMN IF EXISTS mobile_media_id;
*/
