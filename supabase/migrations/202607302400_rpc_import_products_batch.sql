-- =============================================================================
-- 202607302400_rpc_import_products_batch.sql
--
-- Substitui a persistência da importação CSV (hoje um loop de inserts
-- independentes em /api/produtos/import/route.ts, com "rollback" via DELETE
-- compensatório que pode falhar — auditado numa sessão anterior) por uma
-- única função PostgreSQL transacional. Qualquer exceção durante a função
-- desfaz automaticamente TODO o lote via ROLLBACK nativo do Postgres.
--
-- REVISÃO DESTA VERSÃO (auditoria final antes de aplicar em produção) —
-- adiciona em relação à primeira versão:
--   1. Autorização DENTRO da função (não confia só em requireRole('gerente')
--      da rota Node): valida que p_system_user_id existe, está ativo,
--      pertence a p_company_id e tem role gerente/admin.
--   2. pg_advisory_xact_lock em _resolve_unique_sku_variation, serializando
--      a alocação de sufixo por SKU-base — evita que duas transações
--      concorrentes vejam a mesma base "livre" e uma delas aborte por
--      unique_violation desnecessariamente. A constraint UNIQUE em
--      product_variations.sku_variation continua como proteção obrigatória
--      (o lock é otimização, não substituto).
--   3. Validação de coerência do payload inteira ANTES de qualquer INSERT:
--      client_index único (produto e variante), variants é array,
--      sku_scheme só legacy/dynamic, modelo_variation_type_id/
--      modelo_value_id ambos presentes ou ambos ausentes, color/size
--      value_id pertence de fato ao variation_type_id informado,
--      initial_stock/cost_override/base_cost >= 0, price_override/
--      base_price > 0.
--   4. REVOKE EXECUTE FROM PUBLIC nas duas funções + GRANT restrito.
--
-- O QUE FAZ:
--   1. Cria import_batches — registro de idempotência (chave opcional
--      fornecida pelo cliente). Repetir a mesma company_id+idempotency_key
--      devolve o resultado já processado, sem reinserir nada.
--   2. Cria _resolve_unique_sku_variation(base) — reproduz a lógica de
--      src/lib/sku/sku-unique.ts (base, depois +'02'..+'99' se colidir)
--      dentro da mesma transação, serializada por SKU-base via advisory
--      lock.
--   3. Cria rpc_import_products_batch(...) — recebe o lote JÁ RESOLVIDO E
--      NORMALIZADO pelo servidor Node (Tipo/Modelo via resolveTipoModelo,
--      SKU-base via buildDynamicSkuBase/generateSKUFromCodes — nenhuma
--      regra de negócio de Tipo/Modelo é duplicada aqui). Autoriza,
--      valida, e só então persiste: products, product_attribute_values
--      (Modelo do produto-pai, só caminho dinâmico), product_variations,
--      product_variation_attributes, estoque (via rpc_stock_initialize,
--      mesma transação). Retorna os IDs e SKUs criados em JSONB.
--
-- O QUE NÃO FAZ:
--   - Não recalcula Tipo/Modelo nem valida governança de novo — isso já
--     aconteceu em resolveTipoModelo (Node, com testes próprios).
--   - Não usa ON CONFLICT DO NOTHING pra esconder conflito de SKU.
--   - Não faz DELETE compensatório — o ROLLBACK é do Postgres, automático.
--   - Não adiciona validação a rpc_stock_initialize (função pré-existente,
--     usada por outros fluxos de estoque) — ver ACHADO abaixo.
--
-- CORREÇÃO DE DIVERGÊNCIA DE SCHEMA (encontrada investigando a falha do
-- cenário 9 no script funcional): src/lib/db/migrations/000_schema_completo.sql
-- está DESATUALIZADO em relação a supabase/migrations/20260610_multi_estoque.sql
-- (já aplicada de verdade). Desde essa migration:
--   - stock_balances (chave composta product_variation_id + stock_location_id)
--     é a fonte de verdade de saldo — não mais "stock" (mantida congelada só
--     como backup, comentário "LEGADO/BACKUP: stock (preservada intacta para
--     rollback)" no próprio arquivo). stock_balances.product_variation_id TEM
--     ON DELETE CASCADE — a lacuna de cascade encontrada anteriormente na
--     tabela "stock" antiga não se aplica mais a escritas atuais.
--   - rpc_stock_initialize tem 5 parâmetros, não 4: ganhou
--     p_stock_location_id INT DEFAULT NULL (resolve pro "Estoque Loja"
--     principal da empresa via fn_main_store_id() quando omitido — é assim
--     que esta migration chama, com 4 argumentos posicionais e o 5º
--     implícito).
--   - stock_movements ganhou as colunas source_location_id,
--     destination_location_id, movement_type, reference_type, notes E
--     created_by (uuid, FK pra users) — rpc_stock_initialize PASSA
--     p_system_user_id como created_by. A afirmação anterior desta migration
--     ("stock_movements não tem created_by, p_system_user_id nunca é usado")
--     estava errada — baseada no arquivo consolidado desatualizado, não no
--     schema real.
--
-- ACHADO DE AUDITORIA que CONTINUA válido (rpc_stock_initialize, pré-
-- existente, não criada nesta sessão): mesmo passando p_system_user_id
-- adiante como created_by, a função NUNCA o valida (existência/ativo/
-- empresa/role) — só grava o valor recebido. Isso é seguro PARA ESTE FLUXO
-- porque rpc_import_products_batch já autoriza o chamador (ver PARTE 3,
-- bloco 0) antes de chamar rpc_stock_initialize internamente — mas é uma
-- lacuna pré-existente na própria rpc_stock_initialize (hoje GRANTed a
-- service_role E authenticated — teoricamente qualquer usuário autenticado,
-- de qualquer role, pode chamá-la direto e criar estoque arbitrário em
-- qualquer variação, sem checagem de empresa/role). Fora do escopo desta
-- migration (mudar uma RPC já em uso por outros fluxos de estoque é uma
-- mudança maior e separada) — reportado ao usuário, não corrigido aqui.
--
-- SEGURANÇA: SECURITY DEFINER com search_path fixo (mesmo padrão de
-- rpc_stock_initialize/rpc_stock_adjust já existentes) — necessário pra
-- escrever em stock_balances (trigger prevent_direct_stock_balances_write
-- bloqueia INSERT/UPDATE direto fora de RPCs autorizadas). Ao contrário das
-- RPCs de estoque (GRANT pra service_role E authenticated), esta função só
-- é GRANTed a service_role — nunca é chamada pelo browser com sessão de
-- usuário comum, só pela rota Node via createAdminClient(). REVOKE ALL FROM
-- PUBLIC nas duas funções.
--
-- IDEMPOTENTE (a migration em si): CREATE TABLE/FUNCTION IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION / GRANT-REVOKE são idempotentes por natureza.
-- =============================================================================

-- PARTE 1 — Registro de idempotência
CREATE TABLE IF NOT EXISTS public.import_batches (
  id              SERIAL      PRIMARY KEY,
  company_id      INT         NOT NULL REFERENCES public.companies(id),
  idempotency_key TEXT        NOT NULL,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_import_batches_company_key UNIQUE (company_id, idempotency_key)
);

-- PARTE 2 — Resolução de sku_variation único, serializada por SKU-base
CREATE OR REPLACE FUNCTION public._resolve_unique_sku_variation(p_base_sku TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_candidate TEXT;
  i           INT;
BEGIN
  IF p_base_sku IS NULL OR length(p_base_sku) = 0 THEN
    RAISE EXCEPTION 'sku_base vazio — não é possível resolver sku_variation.';
  END IF;

  -- Serializa a alocação por SKU-base: duas transações concorrentes
  -- tentando resolver o MESMO p_base_sku esperam uma pela outra aqui, em
  -- vez de ambas verem "livre" e colidirem só no INSERT final (o que
  -- abortaria uma das duas transações inteiras por unique_violation).
  -- pg_advisory_xact_lock libera sozinho no fim da transação — nunca
  -- precisa de unlock manual, mesmo em exceção. hashtextextended pode
  -- colidir entre bases diferentes (mesmo hash pra strings diferentes) —
  -- isso só causa serialização desnecessária entre bases não relacionadas
  -- (custo de performance, nunca um problema de correção). A constraint
  -- UNIQUE em product_variations.sku_variation continua como proteção
  -- obrigatória — o lock é otimização, nunca a substitui.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_base_sku, 0));

  IF NOT EXISTS (SELECT 1 FROM public.product_variations WHERE sku_variation = p_base_sku) THEN
    RETURN p_base_sku;
  END IF;

  FOR i IN 2..99 LOOP
    v_candidate := p_base_sku || lpad(i::text, 2, '0');
    IF NOT EXISTS (SELECT 1 FROM public.product_variations WHERE sku_variation = v_candidate) THEN
      RETURN v_candidate;
    END IF;
  END LOOP;

  RAISE EXCEPTION
    'Não foi possível alocar sku_variation único para a base "%": todos os sufixos 02-99 estão em uso.',
    p_base_sku;
END;
$$;

-- PARTE 3 — Persistência transacional do lote de importação
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
  v_variant          JSONB;
  v_product_id       INT;
  v_variation_id     INT;
  v_variant_sku      TEXT;
  v_products_out     JSONB := '[]'::jsonb;
  v_variants_out     JSONB;
  v_duplicate_count  INT;
  v_seen_product_idx INT[] := ARRAY[]::INT[];
  v_seen_variant_idx INT[];
  v_product_idx      INT;
  v_variant_idx      INT;
BEGIN
  -- 0. Autorização — SECURITY DEFINER não pode confiar apenas em
  -- requireRole('gerente') feito pela rota Node antes de chamar esta
  -- função. Valida aqui, dentro da transação, antes de qualquer outra
  -- coisa (inclusive antes de reservar idempotency_key).
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

  -- 1. Idempotência: reserva a chave antes de processar qualquer coisa. Se
  -- já existir resultado gravado, devolve ele sem reinserir nada. Se a
  -- chave existir mas ainda sem resultado, rejeita — nunca processa o
  -- mesmo lote duas vezes em paralelo. Sob READ COMMITTED (padrão do
  -- Postgres), duas transações concorrentes tentando inserir a MESMA
  -- (company_id, idempotency_key) serializam automaticamente no índice
  -- único: uma bloqueia até a outra commitar ou abortar. Se a primeira
  -- commitar, a segunda vê unique_violation e o result JÁ estará
  -- preenchido (a mesma transação que reserva também grava o resultado
  -- antes de terminar) — nunca cria dois lotes. Se a primeira abortar
  -- (falhou), sua reserva também é desfeita (mesma transação) — a segunda
  -- processa como se fosse a primeira tentativa real. O branch
  -- "encontrado mas sem resultado" é uma proteção defensiva para o caso
  -- extremo de leitura fora de READ COMMITTED — na prática, inalcançável
  -- sob o isolamento padrão, mas nunca trata isso como sucesso silencioso.
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

  -- 2. Validação estrutural mínima do payload
  IF p_products IS NULL OR jsonb_typeof(p_products) <> 'array' OR jsonb_array_length(p_products) = 0 THEN
    RAISE EXCEPTION 'Nenhum produto informado para importação.';
  END IF;

  -- 3. Validação de coerência do payload inteiro — nenhuma escrita ainda.
  -- Nunca confia que a rota Node sempre envia payload válido.
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

    IF v_product->'variants' IS NOT NULL AND jsonb_typeof(v_product->'variants') <> 'array' THEN
      RAISE EXCEPTION 'variants deve ser um array (produto client_index=%).', v_product_idx;
    END IF;

    IF (v_product->>'sku_scheme') NOT IN ('legacy', 'dynamic') THEN
      RAISE EXCEPTION 'sku_scheme inválido ''%'' (produto client_index=%) — só aceita legacy ou dynamic.',
        v_product->>'sku_scheme', v_product_idx;
    END IF;

    IF (v_product->>'sku_scheme') = 'dynamic'
       AND ((v_product->>'modelo_variation_type_id') IS NULL) <> ((v_product->>'modelo_value_id') IS NULL) THEN
      RAISE EXCEPTION
        'modelo_variation_type_id e modelo_value_id devem estar ambos presentes ou ambos ausentes (produto client_index=%).',
        v_product_idx;
    END IF;

    IF (v_product->>'sku_scheme') = 'dynamic' AND (v_product->>'modelo_value_id') IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.variation_values
        WHERE id = (v_product->>'modelo_value_id')::int
          AND variation_type_id = (v_product->>'modelo_variation_type_id')::int
      ) THEN
        RAISE EXCEPTION
          'modelo_value_id % não pertence ao modelo_variation_type_id % (produto client_index=%).',
          v_product->>'modelo_value_id', v_product->>'modelo_variation_type_id', v_product_idx;
      END IF;
    END IF;

    IF COALESCE((v_product->>'base_cost')::numeric, 0) < 0 THEN
      RAISE EXCEPTION 'base_cost negativo (produto client_index=%).', v_product_idx;
    END IF;
    IF COALESCE((v_product->>'base_price')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'base_price deve ser maior que zero (produto client_index=%).', v_product_idx;
    END IF;

    v_seen_variant_idx := ARRAY[]::INT[];
    FOR v_variant IN SELECT * FROM jsonb_array_elements(COALESCE(v_product->'variants', '[]'::jsonb))
    LOOP
      IF v_variant->>'client_index' IS NULL THEN
        RAISE EXCEPTION 'client_index de variante ausente (produto client_index=%).', v_product_idx;
      END IF;
      v_variant_idx := (v_variant->>'client_index')::int;

      IF v_variant_idx = ANY(v_seen_variant_idx) THEN
        RAISE EXCEPTION 'client_index de variante duplicado (produto client_index=%, variante client_index=%).',
          v_product_idx, v_variant_idx;
      END IF;
      v_seen_variant_idx := array_append(v_seen_variant_idx, v_variant_idx);

      IF COALESCE((v_variant->>'initial_stock')::int, 0) < 0 THEN
        RAISE EXCEPTION 'initial_stock negativo (produto client_index=%, variante client_index=%).',
          v_product_idx, v_variant_idx;
      END IF;

      IF (v_variant->>'cost_override') IS NOT NULL AND (v_variant->>'cost_override')::numeric < 0 THEN
        RAISE EXCEPTION 'cost_override negativo (produto client_index=%, variante client_index=%).',
          v_product_idx, v_variant_idx;
      END IF;
      IF (v_variant->>'price_override') IS NOT NULL AND (v_variant->>'price_override')::numeric <= 0 THEN
        RAISE EXCEPTION 'price_override deve ser maior que zero (produto client_index=%, variante client_index=%).',
          v_product_idx, v_variant_idx;
      END IF;

      IF (v_variant->>'color_value_id') IS NOT NULL THEN
        IF (v_variant->>'color_variation_type_id') IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.variation_values
          WHERE id = (v_variant->>'color_value_id')::int
            AND variation_type_id = (v_variant->>'color_variation_type_id')::int
        ) THEN
          RAISE EXCEPTION
            'color_value_id % não pertence ao variation_type_id % (produto client_index=%, variante client_index=%).',
            v_variant->>'color_value_id', v_variant->>'color_variation_type_id', v_product_idx, v_variant_idx;
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
            v_variant->>'size_value_id', v_variant->>'size_variation_type_id', v_product_idx, v_variant_idx;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- 4. Conflito de SKU (parent) — dentro do próprio lote
  SELECT count(*) INTO v_duplicate_count
  FROM (
    SELECT p->>'sku' AS sku, count(*) AS c
    FROM jsonb_array_elements(p_products) AS p
    GROUP BY p->>'sku'
    HAVING count(*) > 1
  ) dups;

  IF v_duplicate_count > 0 THEN
    RAISE EXCEPTION 'Conflito de SKU: dois ou mais produtos do próprio lote compartilham o mesmo SKU.';
  END IF;

  -- 4b. Conflito de SKU (parent) — contra produtos já existentes no banco
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_products) AS p
    JOIN public.products existing ON existing.sku = (p->>'sku')
  ) THEN
    RAISE EXCEPTION 'Conflito de SKU: um ou mais produtos do lote já existem no banco com o mesmo SKU.';
  END IF;

  -- 5. Processa cada produto do lote
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_products)
  LOOP
    -- 5a. Escopo de empresa — nunca confia cegamente em IDs do payload.
    -- categories.company_id é nullable (categorias legadas compartilhadas);
    -- suppliers/brands são sempre escopados.
    IF NOT EXISTS (
      SELECT 1 FROM public.categories
      WHERE id = (v_product->>'category_id')::int
        AND (company_id = p_company_id OR company_id IS NULL)
    ) THEN
      RAISE EXCEPTION 'Categoria % não existe ou não pertence à empresa %.', v_product->>'category_id', p_company_id;
    END IF;

    IF (v_product->>'supplier_id') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.suppliers WHERE id = (v_product->>'supplier_id')::int AND company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'Fornecedor % não existe ou não pertence à empresa %.', v_product->>'supplier_id', p_company_id;
    END IF;

    IF (v_product->>'brand_id') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.brands WHERE id = (v_product->>'brand_id')::int AND company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'Marca % não existe ou não pertence à empresa %.', v_product->>'brand_id', p_company_id;
    END IF;

    -- 5b. Insere o produto-pai
    INSERT INTO public.products (
      name, tipo, modelo, ano, category_id, supplier_id, brand_id, origin,
      base_cost, base_price, active, sku, sku_scheme,
      subcategory_id, collection_id, company_id
    ) VALUES (
      v_product->>'name',
      v_product->>'tipo',
      v_product->>'modelo',
      v_product->>'ano',
      (v_product->>'category_id')::int,
      (v_product->>'supplier_id')::int,
      (v_product->>'brand_id')::int,
      (v_product->>'origin')::product_origin,
      (v_product->>'base_cost')::numeric,
      (v_product->>'base_price')::numeric,
      COALESCE((v_product->>'active')::boolean, true),
      v_product->>'sku',
      v_product->>'sku_scheme',
      NULL,
      NULL,
      p_company_id
    )
    RETURNING id INTO v_product_id;

    -- 5c. Atributo Modelo do produto-pai — só caminho dinâmico com Modelo
    -- efetivamente escolhido (já validado na PARTE 3 acima: ambos
    -- presentes e coerentes, ou ambos ausentes).
    IF (v_product->>'sku_scheme') = 'dynamic' AND (v_product->>'modelo_value_id') IS NOT NULL THEN
      INSERT INTO public.product_attribute_values (product_id, variation_type_id, variation_value_id)
      VALUES (
        v_product_id,
        (v_product->>'modelo_variation_type_id')::int,
        (v_product->>'modelo_value_id')::int
      );
    END IF;

    -- 5d. Variantes
    v_variants_out := '[]'::jsonb;
    FOR v_variant IN SELECT * FROM jsonb_array_elements(COALESCE(v_product->'variants', '[]'::jsonb))
    LOOP
      v_variant_sku := public._resolve_unique_sku_variation(v_variant->>'sku_base');

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
        VALUES (
          v_variation_id,
          (v_variant->>'color_variation_type_id')::int,
          (v_variant->>'color_value_id')::int
        );
      END IF;

      IF (v_variant->>'size_value_id') IS NOT NULL THEN
        INSERT INTO public.product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
        VALUES (
          v_variation_id,
          (v_variant->>'size_variation_type_id')::int,
          (v_variant->>'size_value_id')::int
        );
      END IF;

      -- Inicialização de estoque — reaproveita rpc_stock_initialize (mesma
      -- transação: chamada de função PL/pgSQL não abre transação nova nem
      -- comita — confirmado no corpo dela, só INSERT simples). Ver ACHADO
      -- DE AUDITORIA no cabeçalho: rpc_stock_initialize não valida
      -- p_system_user_id — seguro aqui porque já autorizamos o chamador
      -- no bloco 0 desta função.
      IF COALESCE((v_variant->>'initial_stock')::int, 0) > 0 THEN
        PERFORM public.rpc_stock_initialize(
          v_variation_id,
          (v_variant->>'initial_stock')::int,
          COALESCE((v_variant->>'cost_override')::numeric, (v_product->>'base_cost')::numeric),
          p_system_user_id
        );
      END IF;

      v_variants_out := v_variants_out || jsonb_build_object(
        'client_index',   (v_variant->>'client_index')::int,
        'id',             v_variation_id,
        'sku_variation',  v_variant_sku
      );
    END LOOP;

    v_products_out := v_products_out || jsonb_build_object(
      'client_index', (v_product->>'client_index')::int,
      'id',           v_product_id,
      'sku',          v_product->>'sku',
      'variants',     v_variants_out
    );
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

-- PARTE 4 — Restringe quem pode executar as funções
-- PUBLIC aqui é a palavra-chave especial do GRANT/REVOKE (nunca um nome de
-- role literal) — nunca deve ser escrita entre aspas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION
      'Role "service_role" não existe neste banco — confirme que este é um projeto Supabase padrão antes de aplicar esta migration.';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.rpc_import_products_batch(INT, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_import_products_batch(INT, UUID, JSONB, TEXT) TO service_role;

-- _resolve_unique_sku_variation só é chamada internamente por
-- rpc_import_products_batch (SECURITY DEFINER) — a checagem de EXECUTE do
-- Postgres é avaliada para o chamador direto; como a chamada interna
-- acontece com o privilégio do OWNER da função (efeito de SECURITY
-- DEFINER), nenhum GRANT adicional é necessário pra esse uso. Revoga de
-- PUBLIC pra impedir qualquer chamada externa direta.
REVOKE ALL ON FUNCTION public._resolve_unique_sku_variation(TEXT) FROM PUBLIC;

-- =============================================================================
-- Smoke tests (estruturais — não chamam a função com dados reais, que
-- exigiria company_id/category_id/usuário válidos deste banco; ver script
-- de testes funcionais em supabase/tests/rpc_import_products_batch.test.sql)
-- =============================================================================

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'import_batches';
-- Esperado: 1 linha

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('rpc_import_products_batch', '_resolve_unique_sku_variation');
-- Esperado: 2 linhas

SELECT conname FROM pg_constraint WHERE conname = 'uq_import_batches_company_key';
-- Esperado: 1 linha

-- Confirma que PUBLIC não tem EXECUTE em nenhuma das duas funções.
-- has_function_privilege() NÃO serve aqui: seu primeiro argumento espera
-- um role de verdade (nome ou oid) para resolver via pg_authid — PUBLIC é
-- um pseudo-role especial que não existe como linha em pg_authid/pg_roles,
-- então passar a string 'PUBLIC' (citada ou não) sempre falha com "role
-- ... does not exist" (foi exatamente esse o erro reportado ao aplicar
-- esta migration). A forma correta de inspecionar privilégio de PUBLIC é
-- via aclexplode(), onde grantee = 0 representa PUBLIC (documentado em
-- "Access Privilege Inquiry Functions" da documentação do Postgres).
SELECT p.proname,
       NOT EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_sem_execute
FROM pg_proc p
WHERE p.proname IN ('rpc_import_products_batch', '_resolve_unique_sku_variation');
-- Esperado: 2 linhas, public_sem_execute = true nas duas

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
