-- =============================================================================
-- 014_products_sku_parent_not_unique.sql
--
-- Contexto:
--   products.sku armazena o SKU mãe (TTMM0000AA): um agrupador por
--   tipo/modelo/ano que NÃO inclui cor nem tamanho. Dois produtos distintos
--   (ex: "Conjunto Preto" e "Conjunto Bege") do mesmo tipo/modelo/ano geram
--   o mesmo SKU mãe, o que é correto no modelo de negócio.
--
--   O identificador verdadeiramente único é product_variations.sku_variation,
--   que codifica tipo + modelo + cor + tamanho + ano. Essa constraint de
--   unicidade em product_variations.sku_variation NÃO É ALTERADA aqui.
--
-- O que esta migration faz:
--   1. Remove todo índice/constraint UNIQUE que envolva a coluna `sku` na
--      tabela `products` (nome pode variar por ambiente).
--   2. Cria índice regular (não-único) em (company_id, sku) para manter
--      performance de queries de busca por SKU mãe.
--
-- Segura para re-execução: usa IF EXISTS em todos os passos.
-- =============================================================================

-- ─── 1. Remover constraints UNIQUE que incluam `sku` em products ─────────────

DO $$
DECLARE
  r RECORD;
BEGIN
  -- 1a. Drop unique constraints declaradas como CONSTRAINT (pg_constraint)
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname   = 'public'
      AND t.relname   = 'products'
      AND c.contype   = 'u'    -- unique constraint
      AND EXISTS (
        SELECT 1
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE a.attname = 'sku'
      )
  LOOP
    RAISE NOTICE 'Removendo constraint única: %', r.conname;
    EXECUTE format('ALTER TABLE public.products DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;

  -- 1b. Drop unique indexes criados via CREATE UNIQUE INDEX (sem constraint explícita)
  FOR r IN
    SELECT i.relname AS index_name
    FROM pg_index    ix
    JOIN pg_class    t ON t.oid = ix.indrelid
    JOIN pg_class    i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname       = 'public'
      AND t.relname       = 'products'
      AND ix.indisunique  = true
      AND NOT ix.indisprimary
      -- ainda existe (não foi derrubado pelo DROP CONSTRAINT acima)
      AND EXISTS (
        SELECT 1
        FROM unnest(ix.indkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE a.attname = 'sku'
      )
  LOOP
    RAISE NOTICE 'Removendo índice único: %', r.index_name;
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.index_name);
  END LOOP;
END;
$$;

-- ─── 2. Índice regular para performance de lookup por SKU mãe ────────────────

-- Drops o índice se porventura já existir (re-execução segura)
DROP INDEX IF EXISTS public.idx_products_company_sku;

CREATE INDEX idx_products_company_sku
  ON public.products(company_id, sku);

COMMENT ON INDEX public.idx_products_company_sku IS
  'Busca por SKU mãe dentro de uma empresa. Não-único: o mesmo SKU mãe pode existir '
  'em vários produtos com cores diferentes. A unicidade real está em '
  'product_variations.sku_variation.';

-- ─── 3. Documentação do papel de cada coluna ─────────────────────────────────

COMMENT ON COLUMN public.products.sku IS
  'SKU mãe (agrupador): TTMM0000AA — não inclui cor nem tamanho. '
  'Pode repetir entre produtos da mesma empresa com cores diferentes. '
  'Não é único. O identificador unitário único é product_variations.sku_variation.';
