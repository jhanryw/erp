-- =============================================================================
-- 20260729_pim_product_types_models.sql
--
-- Entrega 2 da refatoração de taxonomia do PIM (Tipo → Categoria → Modelo).
-- Plano completo, diagnóstico e decisão de arquitetura em
-- /Users/jhanry/.claude/plans/robust-booping-sun.md (Opção A aprovada:
-- Modelo como entidade reutilizável via tabela de vínculo, não árvore
-- estrita nem sistema de atributos).
--
-- CONTEXTO CONFIRMADO POR QUERY REAL (não hipótese):
--   - `products.tipo`/`products.modelo` são TEXT livre, validados só contra
--     o mapa hardcoded `src/lib/sku/sku-map.ts` — sem tabela, sem FK.
--   - `categories` hoje mistura Tipo e Categoria: das 14 linhas de topo,
--     a maioria (Calcinha, Camisola, Body, Robe, Cinta, Pijama, Pijama
--     Americano, Pijama Rendado) é Tipo disfarçado; só "Sutiã com Bojo/sem
--     Bojo/Adesivo/de Silicone" e as 4 filhas de Cinta (via parent_id) são
--     Categoria de verdade. "Sutiã" nunca existiu como Tipo próprio.
--   - Confirmado com IDs reais: produtos 187–199 ("Calcinha Canelada ...")
--     têm modelo='Algodão' porque "canelada" nunca foi uma chave válida em
--     SKU_MODELO['02'] — não é erro de digitação, é lacuna estrutural.
--   - `categories.parent_id` tem só 4 linhas não-nulas em 18 (as filhas de
--     Cinta) — confirmado morto no resto do código E dos dados.
--
-- O QUE FAZ:
--   1. Cria `product_types` (Tipo) — nova, vazia nesta migration.
--   2. Estende `categories` (Categoria) com `product_type_id` (nullable) e
--      `sku_code` (nullable) — nenhuma linha existente é alterada além de
--      ganhar essas duas colunas NULL.
--   3. Corrige `categories.slug` de UNIQUE global para
--      UNIQUE(company_id, product_type_id, slug) — o formato atual
--      impediria "Renda" existir como Categoria de Calcinha E de Sutiã ao
--      mesmo tempo, exatamente o cenário que a nova taxonomia precisa.
--   4. Cria `product_models` (Modelo) — nova, escopada por
--      `product_type_id` (não por categoria — permite "Fio" ser reutilizado
--      por várias Categorias do mesmo Tipo sem duplicar cadastro).
--   5. Cria `category_models` — tabela de vínculo Categoria↔Modelo, mesma
--      forma de `category_attributes` (já provada em produção).
--   6. Adiciona `products.model_id` (nullable) — convive com `tipo`/
--      `modelo` (texto) durante toda a transição; nenhum dos dois é
--      removido ou tem seu comportamento alterado aqui.
--
-- O QUE NÃO FAZ (fora de escopo desta entrega, ver plano):
--   - Não faz nenhum backfill de dado (Entrega 3a/3b, entregas futuras,
--     dependem de mapeamento confirmado com o usuário).
--   - Não altera `generateSKUFromCodes()`/geração de SKU (Entrega 4).
--   - Não altera nenhuma API, formulário ou validação (Entregas 5/6).
--   - Não remove `categories.parent_id` (fica como legado congelado — não
--     lido nem escrito por nenhum código novo, mas não apagado da tabela).
--   - Não altera a constraint de duplicidade `uq_products_company_name_tipo_modelo_ano`
--     (continua usando o texto `tipo`/`modelo`, que continua sendo a fonte
--     de verdade até `model_id` estar comprovadamente confiável).
--
-- IDEMPOTENTE: sim — CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS.
-- =============================================================================

-- =============================================================================
-- PARTE 1 — product_types (Tipo)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_types (
  id          SERIAL      PRIMARY KEY,
  company_id  INT         NOT NULL REFERENCES public.companies(id),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  sku_code    TEXT,
  active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_types_company_slug
  ON public.product_types(company_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_types_company_sku_code
  ON public.product_types(company_id, sku_code) WHERE sku_code IS NOT NULL;

-- =============================================================================
-- PARTE 2 — categories ganha product_type_id + sku_code, slug deixa de ser
-- único globalmente
-- =============================================================================

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS product_type_id INT REFERENCES public.product_types(id),
  ADD COLUMN IF NOT EXISTS sku_code TEXT;

-- Nome confirmado via pg_constraint antes de aplicar (não adivinhado):
-- categories_slug_key, UNIQUE (slug).
ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_company_type_slug
  ON public.categories(company_id, product_type_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_company_type_sku_code
  ON public.categories(company_id, product_type_id, sku_code) WHERE sku_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_categories_product_type_id
  ON public.categories(product_type_id);

-- =============================================================================
-- PARTE 3 — product_models (Modelo), escopado por Tipo — não por Categoria
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.product_models (
  id                SERIAL      PRIMARY KEY,
  company_id        INT         NOT NULL REFERENCES public.companies(id),
  product_type_id   INT         NOT NULL REFERENCES public.product_types(id),
  name              TEXT        NOT NULL,
  slug              TEXT        NOT NULL,
  sku_code          TEXT,
  active            BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_models_company_type_slug
  ON public.product_models(company_id, product_type_id, slug);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_models_company_type_sku_code
  ON public.product_models(company_id, product_type_id, sku_code) WHERE sku_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_models_product_type_id
  ON public.product_models(product_type_id);

-- =============================================================================
-- PARTE 4 — category_models: quais Modelos aparecem no select de cada
-- Categoria. Mesma forma de category_attributes. Populada de forma
-- permissiva quando a Entrega 3 rodar (todo Modelo do Tipo liberado para
-- toda Categoria do mesmo Tipo) — nunca fica bloqueando o cadastro por
-- estar vazia; aqui só a estrutura é criada.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.category_models (
  category_id  INT     NOT NULL REFERENCES public.categories(id),
  model_id     INT     NOT NULL REFERENCES public.product_models(id),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (category_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_category_models_model_id
  ON public.category_models(model_id);

-- =============================================================================
-- PARTE 5 — products.model_id (convive com tipo/modelo texto)
-- =============================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS model_id INT REFERENCES public.product_models(id);

CREATE INDEX IF NOT EXISTS idx_products_model_id
  ON public.products(model_id);

-- =============================================================================
-- Smoke test inline
-- =============================================================================

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('product_types', 'product_models', 'category_models')
ORDER BY table_name;
-- Esperado: 3 linhas

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'categories'
  AND column_name IN ('product_type_id', 'sku_code')
ORDER BY column_name;
-- Esperado: 2 linhas

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'products'
  AND column_name = 'model_id';
-- Esperado: 1 linha

SELECT conname FROM pg_constraint
WHERE conrelid = 'public.categories'::regclass AND conname = 'categories_slug_key';
-- Esperado: 0 linhas (constraint antiga removida)

SELECT indexname FROM pg_indexes
WHERE tablename = 'categories' AND indexname = 'uq_categories_company_type_slug';
-- Esperado: 1 linha (nova constraint no lugar)

-- =============================================================================
-- FIM DA MIGRATION 20260729
-- =============================================================================
