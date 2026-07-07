-- Base de dados de Marca (brands) — Fase 1 PIM, primeira entrega do tema Marca.
--
-- Marca é uma entidade própria, distinta de Fornecedor (vínculo comercial/
-- procurement) e de products.origin (fabricação própria vs. terceiro — uma
-- classificação binária, não uma identidade). Nasce opcional: brand_id em
-- products é nullable, nenhum produto existente é afetado ou preenchido.
--
-- Escopo desta migration: apenas base de dados (tabela + coluna + índice).
-- Sem API, sem formulário, sem preenchimento de produtos existentes, sem
-- tornar obrigatório.

CREATE TABLE IF NOT EXISTS public.brands (
  id          SERIAL      PRIMARY KEY,
  company_id  INT         NOT NULL REFERENCES public.companies(id),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_brands_company_slug UNIQUE (company_id, slug)
);

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS brand_id INT REFERENCES public.brands(id);

CREATE INDEX IF NOT EXISTS idx_products_brand_id
  ON public.products(brand_id);
