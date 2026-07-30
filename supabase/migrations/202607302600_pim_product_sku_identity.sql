-- =============================================================================
-- 202607302600_pim_product_sku_identity.sql
--
-- Implementa a Opção B aprovada: um discriminador de produto persistente
-- (product_sku_identities), propagado ao SKU-pai E a todas as variantes de
-- um mesmo produto — resolvendo o "Conflito de SKU: dois ou mais produtos
-- do próprio lote compartilham o mesmo SKU" sem usar o nome do produto e
-- sem quebrar nenhum SKU já emitido.
--
-- PRÉ-REQUISITO: 202607302400_rpc_import_products_batch.sql já aplicada.
--
-- CORREÇÃO FUNDAMENTAL NESTA VERSÃO (diagnóstico real do banco, não do
-- arquivo consolidado): products.sku NUNCA teve UNIQUE. Existem apenas
-- idx_products_sku e idx_products_company_sku — ambos índices NÃO
-- únicos. src/lib/db/migrations/000_schema_completo.sql (que eu tinha
-- usado como referência) está errado nisso — mais uma vez desatualizado
-- em relação ao schema real (mesma classe de problema já encontrada com
-- rpc_stock_initialize e a tabela stock/stock_balances). Isso muda o
-- desenho de fundo:
--   - SKUs repetidos em products.sku NÃO são anomalia a ser rejeitada —
--     são dado histórico legítimo: o sistema antigo cadastrava cada cor
--     como um produto separado, todos compartilhando o mesmo SKU-base
--     (o maior grupo tem 44 produtos, dentro do limite de 99 do
--     discriminador). Por isso NÃO existe mais uma guarda que aborta por
--     "products.sku duplicado" — isso seria abortar sobre dado real e
--     válido.
--   - Não criamos UNIQUE(products.sku) nesta migration — os dados
--     históricos legítimos impedem isso agora. A proteção contra
--     duplicidade passa a ser: (a) o ledger, que é a única fonte
--     confiável de "próximo discriminador disponível" pra qualquer
--     produto NOVO criado a partir de agora, encadeado por
--     products.sku_identity_id; (b) disciplina arquitetural — todo
--     caminho de criação de produto precisa passar por
--     rpc_import_products_batch/rpc_create_product (nunca inserir em
--     products diretamente por fora), já que não há mais um UNIQUE pra
--     pegar isso na marra. Isso é uma proteção mais fraca que uma
--     constraint de banco — reportado como risco residual no
--     acompanhamento desta entrega, não resolvido aqui (resolver
--     exigiria decidir o que fazer com os grupos históricos de até 44
--     produtos, fora do escopo desta correção).
--
-- ACHADO AINDA EM ABERTO: não confirmei (nem foi pedido) se
-- product_variations.sku_variation realmente tem UNIQUE — o mesmo
-- arquivo consolidado afirma que sim, mas dado que ele já errou duas
-- vezes nesta sessão sobre unicidade/schema real (stock e agora
-- products.sku), recomendo validar isso también antes de confiar
-- cegamente no mecanismo de sufixo de variação (_resolve_unique_sku_variation,
-- 202607302400) contra o schema real.
--
-- O QUE FAZ:
--   1. Cria product_sku_identities — ledger permanente (nunca apagado,
--      mesmo quando o produto é excluído fisicamente — confirmado que
--      este sistema faz DELETE físico real via deleteProductCascade em
--      src/services/produtos.service.ts). product_id tem ON DELETE SET
--      NULL: a linha do ledger sobrevive à exclusão do produto, só perde
--      a referência. UNIQUE(product_id): um produto nunca pode estar
--      ligado a duas identidades diferentes.
--   2. Adiciona products.sku_identity_id (FK pra product_sku_identities),
--      com índice UNIQUE parcial (WHERE sku_identity_id IS NOT NULL) —
--      vínculo explícito e indexado nos dois sentidos (ledger→produto via
--      product_id, produto→ledger via sku_identity_id).
--   3. Backfill: para cada produto já existente, calcula
--      ROW_NUMBER() OVER (PARTITION BY sku ORDER BY created_at NULLS
--      LAST, id) como discriminator — preservando a ordem histórica real
--      (mais antigo = discriminator 1 = "produto lógico 01", omitido do
--      SKU) — SEM alterar nenhum SKU já emitido. Duas guardas antes:
--      (a) formato de 10 dígitos puros; (b) nenhuma base com mais de 99
--      produtos (limite do discriminador). Cinco guardas depois,
--      confirmando a consistência do resultado.
--   4. _resolve_product_sku_identity(sku_base, company_id) — função
--      privada: serializa por sku_base (pg_advisory_xact_lock), consulta
--      o MAX(discriminator) já usado NO LEDGER (nunca em
--      products/product_variations diretamente), reserva o próximo e
--      devolve (identity_id, discriminator, sku final). Erro explícito
--      se passaria de 99.
--   5. _build_variant_sku(variant_base, discriminator) — função privada,
--      pura: monta o SKU de variante embutindo o MESMO discriminador do
--      produto-pai — nenhum resolvedor independente por variante.
--   6. _persist_single_product(company_id, system_user_id, product
--      JSONB) — função privada: valida, resolve identidade, insere
--      produto (já com sku_identity_id preenchido) + product_attribute_
--      values + variantes + estoque — tudo na mesma transação do
--      chamador. Compartilhada entre as duas RPCs públicas abaixo.
--   7. rpc_import_products_batch (revisada) e rpc_create_product (nova) —
--      inalteradas em relação à versão anterior desta migration além de
--      repassar system_user_id corretamente (ver bug corrigido na sessão
--      anterior).
--
-- O QUE NÃO FAZ:
--   - Não altera nenhum SKU já emitido (products.sku/product_variations.
--     sku_variation existentes ficam exatamente como estão).
--   - Não cria UNIQUE(products.sku) — dado histórico legítimo impede.
--   - Não remove nem altera _resolve_unique_sku_variation (202607302400).
--   - Não altera nenhuma rota Node — mudança de banco apenas.
--
-- IDEMPOTENTE: CREATE TABLE/FUNCTION IF NOT EXISTS / CREATE OR REPLACE
-- FUNCTION / ON CONFLICT DO NOTHING no backfill.
-- =============================================================================

-- PARTE 1 — Ledger permanente de identidade de produto
CREATE TABLE IF NOT EXISTS public.product_sku_identities (
  id            BIGSERIAL   PRIMARY KEY,
  sku_base      TEXT        NOT NULL,
  discriminator SMALLINT    NOT NULL CHECK (discriminator BETWEEN 1 AND 99),
  company_id    INT         NOT NULL REFERENCES public.companies(id),
  product_id    INT         REFERENCES public.products(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_product_sku_identities_base_discriminator UNIQUE (sku_base, discriminator),
  CONSTRAINT uq_product_sku_identities_product_id UNIQUE (product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_sku_identities_sku_base
  ON public.product_sku_identities(sku_base);

COMMENT ON TABLE public.product_sku_identities IS
  'Ledger permanente (nunca apagado) de discriminadores de produto por sku_base. discriminator=1 é o "produto lógico 01", omitido do SKU-pai/variantes por compatibilidade retroativa. Nunca reutilizado, mesmo após exclusão física do produto (product_id vira NULL, a linha permanece). products.sku NÃO tem UNIQUE — SKUs repetidos são dado histórico legítimo (cada cor cadastrada como produto separado); este ledger é quem garante discriminador único por base para produtos criados a partir desta migration.';

-- PARTE 2 — Vínculo explícito produto → identidade
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS sku_identity_id BIGINT REFERENCES public.product_sku_identities(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_sku_identity_id
  ON public.products(sku_identity_id) WHERE sku_identity_id IS NOT NULL;

-- PARTE 3 — Guardas PRÉ-backfill
DO $$
DECLARE
  v_bad_format_count INT;
  v_oversized_count  INT;
BEGIN
  -- Guarda (a): todo sku existente precisa ser uma base de 10 dígitos
  -- puros — formato esperado por TT+MM+'00'+'00'+AA. NÃO valida
  -- unicidade — duplicidade é dado histórico legítimo, não anomalia.
  SELECT count(*) INTO v_bad_format_count
  FROM public.products
  WHERE sku !~ '^\d{10}$';

  IF v_bad_format_count > 0 THEN
    RAISE EXCEPTION
      'Backfill abortado: encontrados % produtos com sku fora do formato de 10 dígitos numéricos — investigue antes de aplicar esta migration (SELECT id, sku FROM products WHERE sku !~ ''^\d{10}$'').',
      v_bad_format_count;
  END IF;

  -- Guarda (b): nenhuma base pode ter mais de 99 produtos — é o limite
  -- físico do discriminador (SMALLINT CHECK 1..99).
  SELECT count(*) INTO v_oversized_count
  FROM (
    SELECT sku FROM public.products GROUP BY sku HAVING count(*) > 99
  ) big;

  IF v_oversized_count > 0 THEN
    RAISE EXCEPTION
      'Backfill abortado: % base(s) de SKU têm mais de 99 produtos, excedendo o limite do discriminador — investigue antes de aplicar esta migration (SELECT sku, count(*) FROM products GROUP BY sku HAVING count(*) > 99).',
      v_oversized_count;
  END IF;
END $$;

-- PARTE 4 — Backfill: discriminator = ordem histórica real de criação
-- (mais antigo primeiro = discriminator 1, sem sufixo, SKU inalterado)
WITH ranked AS (
  SELECT
    id,
    sku,
    company_id,
    ROW_NUMBER() OVER (PARTITION BY sku ORDER BY created_at NULLS LAST, id) AS discriminator
  FROM public.products
)
INSERT INTO public.product_sku_identities (sku_base, discriminator, company_id, product_id)
SELECT sku, discriminator, company_id, id
FROM ranked
ON CONFLICT (sku_base, discriminator) DO NOTHING;

UPDATE public.products p
SET sku_identity_id = psi.id
FROM public.product_sku_identities psi
WHERE psi.product_id = p.id AND p.sku_identity_id IS NULL;

-- PARTE 5 — Guardas PÓS-backfill: confirma a consistência do resultado
-- explicitamente, não por suposição (mesmo que as constraints já
-- protejam alguns destes casos estruturalmente).
DO $$
DECLARE
  v_missing_identity    INT;
  v_dup_product_ledger  INT;
  v_dup_identity_link   INT;
  v_dup_discriminator   INT;
  v_mismatched_max      INT;
BEGIN
  -- (a) todo produto possui sku_identity_id
  SELECT count(*) INTO v_missing_identity FROM public.products WHERE sku_identity_id IS NULL;
  IF v_missing_identity > 0 THEN
    RAISE EXCEPTION 'Backfill incompleto: % produtos sem sku_identity_id.', v_missing_identity;
  END IF;

  -- (b) nenhum product_id aparece duas vezes no ledger
  SELECT count(*) INTO v_dup_product_ledger
  FROM (
    SELECT product_id FROM public.product_sku_identities
    WHERE product_id IS NOT NULL
    GROUP BY product_id HAVING count(*) > 1
  ) d;
  IF v_dup_product_ledger > 0 THEN
    RAISE EXCEPTION 'Backfill inconsistente: % product_id aparecem mais de uma vez no ledger.', v_dup_product_ledger;
  END IF;

  -- (c) nenhuma identidade está ligada a dois produtos
  SELECT count(*) INTO v_dup_identity_link
  FROM (
    SELECT sku_identity_id FROM public.products
    WHERE sku_identity_id IS NOT NULL
    GROUP BY sku_identity_id HAVING count(*) > 1
  ) d;
  IF v_dup_identity_link > 0 THEN
    RAISE EXCEPTION 'Backfill inconsistente: % sku_identity_id compartilhados por mais de um produto.', v_dup_identity_link;
  END IF;

  -- (d) discriminadores únicos por sku_base
  SELECT count(*) INTO v_dup_discriminator
  FROM (
    SELECT sku_base, discriminator FROM public.product_sku_identities
    GROUP BY sku_base, discriminator HAVING count(*) > 1
  ) d;
  IF v_dup_discriminator > 0 THEN
    RAISE EXCEPTION 'Backfill inconsistente: % combinações sku_base+discriminator duplicadas.', v_dup_discriminator;
  END IF;

  -- (e) o maior discriminador de cada base bate com a quantidade
  -- histórica de produtos daquela base (sem gaps na enumeração)
  SELECT count(*) INTO v_mismatched_max
  FROM (
    SELECT p.sku, count(*) AS qtd, MAX(psi.discriminator) AS max_disc
    FROM public.products p
    JOIN public.product_sku_identities psi ON psi.product_id = p.id
    GROUP BY p.sku
    HAVING count(*) <> MAX(psi.discriminator)
  ) mismatch;
  IF v_mismatched_max > 0 THEN
    RAISE EXCEPTION 'Backfill inconsistente: % bases onde o maior discriminador não bate com a quantidade de produtos.', v_mismatched_max;
  END IF;
END $$;

-- PARTE 6 — Resolve e reserva o próximo discriminador disponível pra um
-- sku_base — nunca reutiliza (consulta o ledger, que nunca perde linhas).
CREATE OR REPLACE FUNCTION public._resolve_product_sku_identity(
  p_sku_base   TEXT,
  p_company_id INT
)
RETURNS TABLE(identity_id BIGINT, discriminator SMALLINT, sku TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_next SMALLINT;
  v_id   BIGINT;
BEGIN
  IF p_sku_base IS NULL OR length(p_sku_base) = 0 THEN
    RAISE EXCEPTION 'sku_base vazio — não é possível resolver identidade de produto.';
  END IF;

  -- Serializa por sku_base (domínio real: products.sku não tem UNIQUE,
  -- mas a garantia de "discriminador único por base" pertence inteira ao
  -- ledger — o lock protege a leitura+reserva do MAX(discriminator)).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_sku_base, 0));

  SELECT COALESCE(MAX(psi.discriminator), 0) + 1 INTO v_next
  FROM public.product_sku_identities psi
  WHERE psi.sku_base = p_sku_base;

  IF v_next > 99 THEN
    RAISE EXCEPTION
      'Limite de 99 produtos atingido para a base de SKU "%". Não é possível criar um novo produto com este Tipo+Modelo+Ano.',
      p_sku_base;
  END IF;

  -- Reserva já aqui, na mesma transação do chamador — product_id fica
  -- NULL até o INSERT em products acontecer logo em seguida (mesma
  -- transação). Se o chamador falhar depois, a reserva é desfeita junto.
  INSERT INTO public.product_sku_identities (sku_base, discriminator, company_id, product_id)
  VALUES (p_sku_base, v_next, p_company_id, NULL)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT
    v_id,
    v_next,
    p_sku_base || CASE WHEN v_next = 1 THEN '' ELSE lpad(v_next::text, 2, '0') END;
END;
$$;

-- PARTE 7 — Monta o SKU de variante embutindo o discriminador do
-- produto-pai — função pura, sem resolução independente por variante.
CREATE OR REPLACE FUNCTION public._build_variant_sku(
  p_variant_base  TEXT,
  p_discriminator SMALLINT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_variant_base || CASE WHEN p_discriminator <= 1 THEN '' ELSE lpad(p_discriminator::text, 2, '0') END;
$$;

-- PARTE 8 — Persiste um único produto (+ atributo Modelo + variantes +
-- estoque) — compartilhada entre rpc_import_products_batch (chamada uma
-- vez por produto do lote) e rpc_create_product (chamada uma única vez).
CREATE OR REPLACE FUNCTION public._persist_single_product(
  p_company_id     INT,
  p_system_user_id UUID,
  p_product        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_identity         RECORD;
  v_product_id       INT;
  v_variation_id     INT;
  v_variant_sku      TEXT;
  v_variant          JSONB;
  v_variants_out     JSONB := '[]'::jsonb;
  v_seen_variant_idx SMALLINT[] := ARRAY[]::SMALLINT[];
  v_variant_idx      SMALLINT;
BEGIN
  -- Validação estrutural mínima deste produto
  IF p_product->>'client_index' IS NULL THEN
    RAISE EXCEPTION 'client_index de produto ausente.';
  END IF;
  IF p_product->>'sku_base' IS NULL OR length(p_product->>'sku_base') = 0 THEN
    RAISE EXCEPTION 'sku_base ausente (produto client_index=%).', p_product->>'client_index';
  END IF;
  IF p_product->'variants' IS NOT NULL AND jsonb_typeof(p_product->'variants') <> 'array' THEN
    RAISE EXCEPTION 'variants deve ser um array (produto client_index=%).', p_product->>'client_index';
  END IF;
  IF (p_product->>'sku_scheme') NOT IN ('legacy', 'dynamic') THEN
    RAISE EXCEPTION 'sku_scheme inválido ''%'' (produto client_index=%) — só aceita legacy ou dynamic.',
      p_product->>'sku_scheme', p_product->>'client_index';
  END IF;
  IF (p_product->>'sku_scheme') = 'dynamic'
     AND ((p_product->>'modelo_variation_type_id') IS NULL) <> ((p_product->>'modelo_value_id') IS NULL) THEN
    RAISE EXCEPTION
      'modelo_variation_type_id e modelo_value_id devem estar ambos presentes ou ambos ausentes (produto client_index=%).',
      p_product->>'client_index';
  END IF;
  IF (p_product->>'sku_scheme') = 'dynamic' AND (p_product->>'modelo_value_id') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.variation_values
      WHERE id = (p_product->>'modelo_value_id')::int
        AND variation_type_id = (p_product->>'modelo_variation_type_id')::int
    ) THEN
      RAISE EXCEPTION
        'modelo_value_id % não pertence ao modelo_variation_type_id % (produto client_index=%).',
        p_product->>'modelo_value_id', p_product->>'modelo_variation_type_id', p_product->>'client_index';
    END IF;
  END IF;
  IF COALESCE((p_product->>'base_cost')::numeric, 0) < 0 THEN
    RAISE EXCEPTION 'base_cost negativo (produto client_index=%).', p_product->>'client_index';
  END IF;
  IF COALESCE((p_product->>'base_price')::numeric, 0) <= 0 THEN
    RAISE EXCEPTION 'base_price deve ser maior que zero (produto client_index=%).', p_product->>'client_index';
  END IF;

  -- Escopo de empresa — nunca confia cegamente em IDs do payload.
  IF NOT EXISTS (
    SELECT 1 FROM public.categories
    WHERE id = (p_product->>'category_id')::int
      AND (company_id = p_company_id OR company_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Categoria % não existe ou não pertence à empresa %.', p_product->>'category_id', p_company_id;
  END IF;
  IF (p_product->>'supplier_id') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.suppliers WHERE id = (p_product->>'supplier_id')::int AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Fornecedor % não existe ou não pertence à empresa %.', p_product->>'supplier_id', p_company_id;
  END IF;
  IF (p_product->>'brand_id') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.brands WHERE id = (p_product->>'brand_id')::int AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'Marca % não existe ou não pertence à empresa %.', p_product->>'brand_id', p_company_id;
  END IF;

  -- Resolve e reserva a identidade (discriminador) do produto-pai — mesma
  -- transação que o INSERT logo abaixo.
  SELECT * INTO v_identity
  FROM public._resolve_product_sku_identity(p_product->>'sku_base', p_company_id);

  INSERT INTO public.products (
    name, tipo, modelo, ano, category_id, supplier_id, brand_id, origin,
    base_cost, base_price, active, sku, sku_scheme, sku_identity_id,
    subcategory_id, collection_id, company_id
  ) VALUES (
    p_product->>'name',
    p_product->>'tipo',
    p_product->>'modelo',
    p_product->>'ano',
    (p_product->>'category_id')::int,
    (p_product->>'supplier_id')::int,
    (p_product->>'brand_id')::int,
    (p_product->>'origin')::product_origin,
    (p_product->>'base_cost')::numeric,
    (p_product->>'base_price')::numeric,
    COALESCE((p_product->>'active')::boolean, true),
    v_identity.sku,
    p_product->>'sku_scheme',
    v_identity.identity_id,
    NULL,
    NULL,
    p_company_id
  )
  RETURNING id INTO v_product_id;

  -- Vincula a reserva do ledger ao produto recém-criado (mesma transação —
  -- se algo falhar depois, tudo desfaz junto). Busca por PK (identity_id),
  -- não mais por (sku_base, discriminator).
  UPDATE public.product_sku_identities
  SET product_id = v_product_id
  WHERE id = v_identity.identity_id;

  -- Atributo Modelo do produto-pai — só caminho dinâmico com Modelo
  -- efetivamente escolhido.
  IF (p_product->>'sku_scheme') = 'dynamic' AND (p_product->>'modelo_value_id') IS NOT NULL THEN
    INSERT INTO public.product_attribute_values (product_id, variation_type_id, variation_value_id)
    VALUES (
      v_product_id,
      (p_product->>'modelo_variation_type_id')::int,
      (p_product->>'modelo_value_id')::int
    );
  END IF;

  -- Variantes: SKU embute o MESMO discriminador do produto-pai — nenhum
  -- resolvedor independente por variante.
  FOR v_variant IN SELECT * FROM jsonb_array_elements(COALESCE(p_product->'variants', '[]'::jsonb))
  LOOP
    IF v_variant->>'client_index' IS NULL THEN
      RAISE EXCEPTION 'client_index de variante ausente (produto client_index=%).', p_product->>'client_index';
    END IF;
    v_variant_idx := (v_variant->>'client_index')::smallint;

    IF v_variant_idx = ANY(v_seen_variant_idx) THEN
      RAISE EXCEPTION 'client_index de variante duplicado (produto client_index=%, variante client_index=%).',
        p_product->>'client_index', v_variant_idx;
    END IF;
    v_seen_variant_idx := array_append(v_seen_variant_idx, v_variant_idx);

    IF COALESCE((v_variant->>'initial_stock')::int, 0) < 0 THEN
      RAISE EXCEPTION 'initial_stock negativo (produto client_index=%, variante client_index=%).',
        p_product->>'client_index', v_variant_idx;
    END IF;
    IF (v_variant->>'cost_override') IS NOT NULL AND (v_variant->>'cost_override')::numeric < 0 THEN
      RAISE EXCEPTION 'cost_override negativo (produto client_index=%, variante client_index=%).',
        p_product->>'client_index', v_variant_idx;
    END IF;
    IF (v_variant->>'price_override') IS NOT NULL AND (v_variant->>'price_override')::numeric <= 0 THEN
      RAISE EXCEPTION 'price_override deve ser maior que zero (produto client_index=%, variante client_index=%).',
        p_product->>'client_index', v_variant_idx;
    END IF;
    IF (v_variant->>'color_value_id') IS NOT NULL THEN
      IF (v_variant->>'color_variation_type_id') IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.variation_values
        WHERE id = (v_variant->>'color_value_id')::int
          AND variation_type_id = (v_variant->>'color_variation_type_id')::int
      ) THEN
        RAISE EXCEPTION
          'color_value_id % não pertence ao variation_type_id % (produto client_index=%, variante client_index=%).',
          v_variant->>'color_value_id', v_variant->>'color_variation_type_id', p_product->>'client_index', v_variant_idx;
      END IF;
    END IF;
    IF (v_variant->>'size_value_id') IS NOT NULL THEN
      IF (v_variant->>'size_variation_type_id') IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.variation_values
        WHERE id = (v_variant->>'size_value_id')::int
          AND variation_type_id = (v_variant->>'size_variation_type_id')::int
      ) THEN
        RAISE EXCEPTION
          'size_value_id % não pertence ao variation_type_id % (produto client_index=%, variante client_index=%).',
          v_variant->>'size_value_id', v_variant->>'size_variation_type_id', p_product->>'client_index', v_variant_idx;
      END IF;
    END IF;

    v_variant_sku := public._build_variant_sku(v_variant->>'sku_base', v_identity.discriminator);

    -- Guarda explícita (aplicação, não depende de constraint de banco em
    -- product_variations.sku_variation não confirmada nesta sessão): se
    -- colidir, é cor+tamanho duplicado dentro do MESMO produto.
    IF EXISTS (SELECT 1 FROM public.product_variations WHERE sku_variation = v_variant_sku) THEN
      RAISE EXCEPTION
        'sku_variation ''%'' já existe — provável cor/tamanho duplicado dentro do mesmo produto (produto client_index=%, variante client_index=%).',
        v_variant_sku, p_product->>'client_index', v_variant_idx;
    END IF;

    INSERT INTO public.product_variations (product_id, sku_variation, cost_override, price_override, active)
    VALUES (
      v_product_id,
      v_variant_sku,
      (v_variant->>'cost_override')::numeric,
      (v_variant->>'price_override')::numeric,
      true
    )
    RETURNING id INTO v_variation_id;

    IF (v_variant->>'color_value_id') IS NOT NULL THEN
      INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
      VALUES (v_variation_id, (v_variant->>'color_variation_type_id')::int, (v_variant->>'color_value_id')::int);
    END IF;
    IF (v_variant->>'size_value_id') IS NOT NULL THEN
      INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
      VALUES (v_variation_id, (v_variant->>'size_variation_type_id')::int, (v_variant->>'size_value_id')::int);
    END IF;

    IF COALESCE((v_variant->>'initial_stock')::int, 0) > 0 THEN
      PERFORM public.rpc_stock_initialize(
        v_variation_id,
        (v_variant->>'initial_stock')::int,
        COALESCE((v_variant->>'cost_override')::numeric, (p_product->>'base_cost')::numeric),
        p_system_user_id
      );
    END IF;

    v_variants_out := v_variants_out || jsonb_build_object(
      'client_index',  v_variant_idx,
      'id',            v_variation_id,
      'sku_variation', v_variant_sku
    );
  END LOOP;

  RETURN jsonb_build_object(
    'client_index',  (p_product->>'client_index')::int,
    'id',            v_product_id,
    'sku',           v_identity.sku,
    'discriminator', v_identity.discriminator,
    'variants',      v_variants_out
  );
END;
$$;

-- PARTE 9 — rpc_import_products_batch (revisada): autoriza, valida o lote
-- e delega a persistência de cada produto a _persist_single_product. Não
-- rejeita sku_base repetido — o discriminador resolve.
CREATE OR REPLACE FUNCTION public.rpc_import_products_batch(
  p_company_id      INT,
  p_system_user_id  UUID,
  p_products        JSONB,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_active      BOOLEAN;
  v_user_company_id  INT;
  v_user_role        TEXT;
  v_existing_result  JSONB;
  v_result           JSONB;
  v_product          JSONB;
  v_products_out     JSONB := '[]'::jsonb;
  v_seen_product_idx INT[] := ARRAY[]::INT[];
  v_product_idx      INT;
BEGIN
  -- 0. Autorização
  IF p_system_user_id IS NULL THEN
    RAISE EXCEPTION 'p_system_user_id é obrigatório.';
  END IF;

  SELECT active, company_id, role
    INTO v_user_active, v_user_company_id, v_user_role
  FROM public.users
  WHERE id = p_system_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuário % não encontrado.', p_system_user_id;
  END IF;
  IF NOT v_user_active THEN
    RAISE EXCEPTION 'Usuário % está inativo.', p_system_user_id;
  END IF;
  IF v_user_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Usuário % não pertence à empresa %.', p_system_user_id, p_company_id;
  END IF;
  IF v_user_role NOT IN ('admin', 'gerente') THEN
    RAISE EXCEPTION 'Usuário % não tem permissão de gerente ou superior para importar produtos (role=%).', p_system_user_id, v_user_role;
  END IF;

  -- 1. Idempotência
  IF p_idempotency_key IS NOT NULL THEN
    BEGIN
      INSERT INTO public.import_batches (company_id, idempotency_key, result)
      VALUES (p_company_id, p_idempotency_key, NULL);
    EXCEPTION WHEN unique_violation THEN
      SELECT result INTO v_existing_result
      FROM public.import_batches
      WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

      IF v_existing_result IS NOT NULL THEN
        RETURN v_existing_result;
      END IF;

      RAISE EXCEPTION
        'Importação com idempotency_key "%" já está em andamento para esta empresa.',
        p_idempotency_key;
    END;
  END IF;

  -- 2. Validação estrutural mínima do lote
  IF p_products IS NULL OR jsonb_typeof(p_products) <> 'array' OR jsonb_array_length(p_products) = 0 THEN
    RAISE EXCEPTION 'Nenhum produto informado para importação.';
  END IF;

  -- 3. client_index único entre produtos do lote
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_products)
  LOOP
    IF v_product->>'client_index' IS NULL THEN
      RAISE EXCEPTION 'client_index de produto ausente.';
    END IF;
    v_product_idx := (v_product->>'client_index')::int;
    IF v_product_idx = ANY(v_seen_product_idx) THEN
      RAISE EXCEPTION 'client_index de produto duplicado: %.', v_product_idx;
    END IF;
    v_seen_product_idx := array_append(v_seen_product_idx, v_product_idx);
  END LOOP;

  -- 4. Persiste cada produto — sku_base repetido dentro do lote é
  -- esperado e resolvido pelo discriminador.
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_products)
  LOOP
    v_products_out := v_products_out || public._persist_single_product(p_company_id, p_system_user_id, v_product);
  END LOOP;

  v_result := jsonb_build_object(
    'imported', jsonb_array_length(v_products_out),
    'products', v_products_out
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.import_batches
    SET result = v_result
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  END IF;

  RETURN v_result;
END;
$$;

-- PARTE 10 — rpc_create_product (nova): mesma autorização, persiste um
-- único produto. Destinada a substituir os inserts diretos de
-- /api/produtos/route.ts (mudança de rota Node é um passo seguinte).
CREATE OR REPLACE FUNCTION public.rpc_create_product(
  p_company_id     INT,
  p_system_user_id UUID,
  p_product        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_active     BOOLEAN;
  v_user_company_id INT;
  v_user_role       TEXT;
BEGIN
  IF p_system_user_id IS NULL THEN
    RAISE EXCEPTION 'p_system_user_id é obrigatório.';
  END IF;

  SELECT active, company_id, role
    INTO v_user_active, v_user_company_id, v_user_role
  FROM public.users
  WHERE id = p_system_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuário % não encontrado.', p_system_user_id;
  END IF;
  IF NOT v_user_active THEN
    RAISE EXCEPTION 'Usuário % está inativo.', p_system_user_id;
  END IF;
  IF v_user_company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Usuário % não pertence à empresa %.', p_system_user_id, p_company_id;
  END IF;
  IF v_user_role NOT IN ('admin', 'gerente') THEN
    RAISE EXCEPTION 'Usuário % não tem permissão de gerente ou superior para cadastrar produtos (role=%).', p_system_user_id, v_user_role;
  END IF;

  IF p_product IS NULL OR jsonb_typeof(p_product) <> 'object' THEN
    RAISE EXCEPTION 'Nenhum produto informado.';
  END IF;

  RETURN public._persist_single_product(p_company_id, p_system_user_id, p_product);
END;
$$;

-- PARTE 11 — GRANTs/REVOKEs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'Role "service_role" não existe neste banco — confirme que este é um projeto Supabase padrão antes de aplicar esta migration.';
  END IF;
END $$;

-- Helpers internos: nunca chamados de fora, sem GRANT nenhum.
REVOKE ALL ON FUNCTION public._resolve_product_sku_identity(TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._build_variant_sku(TEXT, SMALLINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._persist_single_product(INT, UUID, JSONB) FROM PUBLIC;

-- Pontos de entrada públicos: só service_role, nunca PUBLIC.
REVOKE ALL ON FUNCTION public.rpc_import_products_batch(INT, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_import_products_batch(INT, UUID, JSONB, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_create_product(INT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_create_product(INT, UUID, JSONB) TO service_role;

-- =============================================================================
-- Smoke tests (estruturais — testes funcionais reais em
-- supabase/tests/product_sku_identity.test.sql)
-- =============================================================================

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'product_sku_identities';
-- Esperado: 1 linha

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'sku_identity_id';
-- Esperado: 1 linha

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    '_resolve_product_sku_identity', '_build_variant_sku', '_persist_single_product',
    'rpc_import_products_batch', 'rpc_create_product'
  );
-- Esperado: 5 linhas

-- Backfill: todo produto existente tem exatamente 1 linha no ledger,
-- vinculada nos dois sentidos (product_id e sku_identity_id)
SELECT count(*) FROM public.products p
WHERE p.sku_identity_id IS NULL
   OR NOT EXISTS (
        SELECT 1 FROM public.product_sku_identities psi
        WHERE psi.id = p.sku_identity_id AND psi.product_id = p.id AND psi.sku_base = p.sku
      );
-- Esperado: 0

-- Nenhum produto existente teve seu sku alterado pelo backfill
SELECT count(*) FROM public.products p
JOIN public.product_sku_identities psi ON psi.product_id = p.id
WHERE psi.sku_base <> p.sku;
-- Esperado: 0

-- Confirma que o maior grupo histórico (até 44, conforme relatado) está
-- corretamente enumerado 1..N sem gaps — mostra TODOS os grupos (não só
-- os inconsistentes) para inspeção manual: qtd_identidades deve ser igual
-- a maior_discriminador em toda linha.
SELECT company_id,
       sku_base,
       count(*) AS qtd_identidades,
       max(discriminator) AS maior_discriminador
FROM public.product_sku_identities
GROUP BY company_id, sku_base;
-- Esperado: em toda linha, qtd_identidades = maior_discriminador

-- PUBLIC não tem EXECUTE em nenhuma das 5 funções
SELECT p.proname,
       NOT EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_sem_execute
FROM pg_proc p
WHERE p.proname IN (
  '_resolve_product_sku_identity', '_build_variant_sku', '_persist_single_product',
  'rpc_import_products_batch', 'rpc_create_product'
);
-- Esperado: 5 linhas, public_sem_execute = true em todas

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
