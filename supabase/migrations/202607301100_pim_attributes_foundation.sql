-- =============================================================================
-- 202607301100_pim_attributes_foundation.sql
--
-- Fase A da especificação v2.2 (arquitetura de atributos do PIM). Aditivo,
-- zero impacto em código/dado existente. Seguro para reexecução: nenhuma
-- UPDATE incondicional que possa sobrescrever configuração futura ou
-- reverter products.sku_scheme='dynamic' de volta pra 'legacy'.
--
-- O QUE FAZ:
--   1. variation_types ganha include_in_sku, data_type, cardinality,
--      value_governance — com CHECK cruzado impedindo cardinality='multiple'
--      fora de data_type='select'. As 3 colunas (data_type, cardinality,
--      value_governance) já nascem corretas pras 2 linhas reais (cor,
--      tamanho) via DEFAULT — não precisam de UPDATE. Só include_in_sku
--      exige um UPDATE pontual (default é false, cor/tamanho precisam de
--      true), restrito aos slugs 'cor'/'tamanho' e guardado por WHERE pra
--      nunca reafirmar sobre uma linha já ajustada manualmente depois.
--   2. products ganha sku_scheme ('legacy'|'dynamic') — o DEFAULT
--      'legacy' já backfilla todas as linhas existentes no momento da
--      criação da coluna, uma única vez. Nenhuma UPDATE adicional — evita
--      reverter produtos que futuramente virarem 'dynamic' numa reexecução
--      acidental deste arquivo.
--
-- O QUE NÃO FAZ:
--   - Não renomeia variation_types/variation_values (Fase K).
--   - Não cria type_attributes/product_attribute_values (Fases B/D).
--   - Não altera categories.parent_id (continua ativo, sem mudança).
--   - Não altera nenhuma API, formulário ou geração de SKU.
--
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS; constraints via DO block checando
-- pg_constraint; único UPDATE restante restrito a slugs específicos e
-- guardado por WHERE que só afeta linhas ainda no estado inicial.
-- =============================================================================

ALTER TABLE public.variation_types
  ADD COLUMN IF NOT EXISTS include_in_sku    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS data_type         TEXT    NOT NULL DEFAULT 'select',
  ADD COLUMN IF NOT EXISTS cardinality       TEXT    NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS value_governance  TEXT    NOT NULL DEFAULT 'unrestricted';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.variation_types'::regclass
      AND conname = 'variation_types_data_type_check'
  ) THEN
    ALTER TABLE public.variation_types
      ADD CONSTRAINT variation_types_data_type_check
      CHECK (data_type IN ('select', 'boolean', 'text', 'number'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.variation_types'::regclass
      AND conname = 'variation_types_cardinality_check'
  ) THEN
    ALTER TABLE public.variation_types
      ADD CONSTRAINT variation_types_cardinality_check
      CHECK (cardinality IN ('single', 'multiple'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.variation_types'::regclass
      AND conname = 'variation_types_value_governance_check'
  ) THEN
    ALTER TABLE public.variation_types
      ADD CONSTRAINT variation_types_value_governance_check
      CHECK (value_governance IN ('unrestricted', 'type_restricted', 'category_restricted'));
  END IF;

  -- Regra 4: cardinality='multiple' só é permitido junto de data_type='select'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.variation_types'::regclass
      AND conname = 'variation_types_cardinality_requires_select'
  ) THEN
    ALTER TABLE public.variation_types
      ADD CONSTRAINT variation_types_cardinality_requires_select
      CHECK (cardinality = 'single' OR data_type = 'select');
  END IF;
END $$;

-- Único UPDATE necessário: data_type/cardinality/value_governance já saem
-- corretos do DEFAULT pras 2 linhas reais (cor, tamanho) — só include_in_sku
-- precisa virar true. Restrito aos slugs reais e guardado por
-- "AND include_in_sku = false" para nunca reafirmar sobre uma linha que
-- alguém já tenha ajustado manualmente depois desta migration rodar.
UPDATE public.variation_types
SET include_in_sku = true
WHERE slug IN ('cor', 'tamanho')
  AND include_in_sku = false;

-- =============================================================================
-- products.sku_scheme
-- =============================================================================

-- NOT NULL DEFAULT 'legacy' já backfilla todas as linhas existentes no
-- momento da criação da coluna — nenhuma UPDATE adicional aqui.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sku_scheme TEXT NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_sku_scheme_check'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_sku_scheme_check
      CHECK (sku_scheme IN ('legacy', 'dynamic'));
  END IF;
END $$;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT slug, include_in_sku, data_type, cardinality, value_governance
FROM variation_types
WHERE slug IN ('cor', 'tamanho')
ORDER BY slug;
-- Esperado: 2 linhas — include_in_sku=true, data_type='select',
-- cardinality='single', value_governance='unrestricted'

SELECT count(*) FROM variation_types
WHERE data_type NOT IN ('select','boolean','text','number')
   OR cardinality NOT IN ('single','multiple')
   OR value_governance NOT IN ('unrestricted','type_restricted','category_restricted')
   OR (cardinality = 'multiple' AND data_type <> 'select');
-- Esperado: 0

SELECT count(*) FROM products WHERE sku_scheme = 'legacy';
-- Esperado: total de produtos existentes na hora de aplicar

SELECT count(*) FROM products WHERE sku_scheme IS NULL OR sku_scheme NOT IN ('legacy','dynamic');
-- Esperado: 0

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
