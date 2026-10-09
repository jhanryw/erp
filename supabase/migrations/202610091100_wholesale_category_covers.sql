-- Capas (fotografias) das categorias na home do atacado.
--
-- Reaproveita o Media Hub: a capa referencia `media` (bucket media-public) —
-- mesmo padrão de wholesale_site_banners. Tabela própria (e não
-- media_usages) porque uq_media_usages_singular_role é GLOBAL por
-- (entity_type, entity_id, role): uma categoria legada compartilhada
-- (categories.company_id NULL) não poderia ter uma capa por empresa.
--
-- 100% aditiva e reaplicável. Nenhuma linha existente é tocada.

CREATE TABLE IF NOT EXISTS public.wholesale_category_covers (
  id          BIGSERIAL    PRIMARY KEY,
  company_id  INT          NOT NULL REFERENCES public.companies(id),
  category_id INT          NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  media_id    BIGINT       NOT NULL REFERENCES public.media(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Uma capa por categoria por empresa (upsert por esta chave).
  CONSTRAINT uq_wholesale_category_covers_company_category UNIQUE (company_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_wholesale_category_covers_media ON public.wholesale_category_covers (media_id);

DROP TRIGGER IF EXISTS trg_wholesale_category_covers_touch_updated_at ON public.wholesale_category_covers;
CREATE TRIGGER trg_wholesale_category_covers_touch_updated_at
  BEFORE UPDATE ON public.wholesale_category_covers
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- RLS: mesmo padrão de wholesale_site_banners — só service_role. Lida pelo
-- servidor (catálogo público e tela do ERP), nunca direto pelo browser.
ALTER TABLE public.wholesale_category_covers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesale_category_covers FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_category_covers TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_category_covers_id_seq TO service_role;

-- ROLLBACK
/*
DROP TABLE IF EXISTS public.wholesale_category_covers;
*/
