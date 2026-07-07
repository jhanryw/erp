-- Governança de atributos por categoria — Fase 1 PIM.
--
-- Duas peças, ambas puramente aditivas e sem consumidor de código ainda:
--
-- 1. variation_types.kind: distingue atributo de variação (gera SKU — cor
--    e tamanho hoje, únicos tipos existentes em produção) de atributo
--    descritivo (não gera SKU, ex.: material, país de origem). Default
--    'variant' preserva exatamente o comportamento atual de cor/tamanho,
--    sem alterar nenhuma linha existente.
--
-- 2. category_attributes: liga categories a variation_types, com
--    `required` indicando se o atributo é obrigatório para produtos
--    daquela categoria. Nenhuma API, UI ou fluxo de cadastro/edição/
--    importação lê esta tabela ainda — é só a base de dados.

ALTER TABLE public.variation_types
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'variant'
    CHECK (kind IN ('variant', 'descriptive'));

CREATE INDEX IF NOT EXISTS idx_variation_types_kind
  ON public.variation_types(kind);

CREATE TABLE IF NOT EXISTS public.category_attributes (
  id                 SERIAL      PRIMARY KEY,
  category_id        INT         NOT NULL REFERENCES public.categories(id),
  variation_type_id  INT         NOT NULL REFERENCES public.variation_types(id),
  required           BOOLEAN     NOT NULL DEFAULT FALSE,
  active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_category_attributes UNIQUE (category_id, variation_type_id)
);

CREATE INDEX IF NOT EXISTS idx_category_attributes_category_id
  ON public.category_attributes(category_id);

CREATE INDEX IF NOT EXISTS idx_category_attributes_variation_type_id
  ON public.category_attributes(variation_type_id);
