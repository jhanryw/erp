-- Agrupamento EXPLÍCITO de cores do mesmo modelo (site de atacado).
--
-- Contexto: cada cor é um PRODUTO próprio (ex.: "Calcinha Invisible Low Fio Rosa" e "... Fio Preto"), com o
-- nome carregando a cor e categorias que nem sempre coincidem. Não existe identificador de família
-- confiável; casar por nome mistura peças. Esta migration cria o vínculo explícito e gerenciável no ERP.
--
-- 100% aditiva e reaplicável; nenhum produto é vinculado automaticamente (color_group_id nasce NULL).
-- A FK composta (color_group_id, company_id) garante NO BANCO que o grupo é da mesma empresa do produto.
-- Requer PostgreSQL 15+ (ON DELETE SET NULL com lista de colunas).

CREATE TABLE IF NOT EXISTS public.product_color_groups (
  id          BIGSERIAL    PRIMARY KEY,
  company_id  INT          NOT NULL REFERENCES public.companies(id),
  name        TEXT         NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_product_color_groups_id_company UNIQUE (id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_product_color_groups_company ON public.product_color_groups (company_id);

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS color_group_id BIGINT;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS fk_products_color_group;
ALTER TABLE public.products
  ADD CONSTRAINT fk_products_color_group
  FOREIGN KEY (color_group_id, company_id)
  REFERENCES public.product_color_groups (id, company_id)
  ON DELETE SET NULL (color_group_id);

CREATE INDEX IF NOT EXISTS idx_products_color_group
  ON public.products (company_id, color_group_id) WHERE color_group_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_product_color_groups_touch_updated_at ON public.product_color_groups;
CREATE TRIGGER trg_product_color_groups_touch_updated_at
  BEFORE UPDATE ON public.product_color_groups
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- RLS: só service_role (mesmo padrão das tabelas do atacado).
ALTER TABLE public.product_color_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_color_groups FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.product_color_groups TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.product_color_groups_id_seq TO service_role;

-- ROLLBACK
/*
DROP INDEX IF EXISTS public.idx_products_color_group;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS fk_products_color_group;
ALTER TABLE public.products DROP COLUMN IF EXISTS color_group_id;
DROP TABLE IF EXISTS public.product_color_groups;
*/
