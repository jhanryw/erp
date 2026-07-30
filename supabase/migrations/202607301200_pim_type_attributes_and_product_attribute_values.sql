-- =============================================================================
-- 202607301200_pim_type_attributes_and_product_attribute_values.sql
--
-- Fases B+D da especificação v2.2 — escopo mínimo acelerado para liberar
-- cadastro de Calcinha nova com Modelo correto. Aditivo, sem tocar em
-- nenhum produto/API/formulário existente.
--
-- O QUE FAZ:
--   1. type_attributes — quais variation_types um Tipo permite/exige.
--      Mesma forma de category_attributes (já provada em produção). Ainda
--      vazia — a linha Calcinha<->Modelo entra na Fase E.
--   2. product_attribute_values — atributos do produto-pai (onde Modelo
--      vive). Só suporta select/single por enquanto — colunas escalares
--      (value_boolean/text/number) ficam para quando um atributo não-select
--      for realmente necessário.
--
-- O QUE NÃO FAZ:
--   - Não cria type_attribute_values/category_attribute_values.
--   - Não popula nenhuma linha (Fase E é separada).
--   - Não altera products, variation_types, category_attributes,
--     product_models, category_models.
--   - Não altera nenhuma API/formulário/geração de SKU.
--
-- PRIMARY KEY composta (product_id, variation_type_id) em
-- product_attribute_values garante no máximo 1 valor por atributo por
-- produto — assume cardinality='single' para tudo que passar por aqui.
--
-- IDEMPOTENTE: CREATE TABLE/INDEX IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.type_attributes (
  id                 SERIAL      PRIMARY KEY,
  product_type_id    INT         NOT NULL REFERENCES public.product_types(id),
  variation_type_id  INT         NOT NULL REFERENCES public.variation_types(id),
  required           BOOLEAN     NOT NULL DEFAULT FALSE,
  active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_type_attributes UNIQUE (product_type_id, variation_type_id)
);

CREATE INDEX IF NOT EXISTS idx_type_attributes_product_type_id
  ON public.type_attributes(product_type_id);

CREATE INDEX IF NOT EXISTS idx_type_attributes_variation_type_id
  ON public.type_attributes(variation_type_id);

CREATE TABLE IF NOT EXISTS public.product_attribute_values (
  product_id         INT         NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variation_type_id  INT         NOT NULL REFERENCES public.variation_types(id),
  variation_value_id INT         NOT NULL REFERENCES public.variation_values(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, variation_type_id)
);

CREATE INDEX IF NOT EXISTS idx_product_attribute_values_variation_type_id
  ON public.product_attribute_values(variation_type_id);

CREATE INDEX IF NOT EXISTS idx_product_attribute_values_variation_value_id
  ON public.product_attribute_values(variation_value_id);

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('type_attributes', 'product_attribute_values')
ORDER BY table_name;
-- Esperado: 2 linhas

SELECT count(*) FROM type_attributes;
-- Esperado: 0 (populada na Fase E)

SELECT count(*) FROM product_attribute_values;
-- Esperado: 0

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
