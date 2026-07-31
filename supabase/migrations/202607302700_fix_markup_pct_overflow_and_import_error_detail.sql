-- =============================================================================
-- 202607302700_fix_markup_pct_overflow_and_import_error_detail.sql
--
-- CAUSA RAIZ CONFIRMADA (auditoria de sessão anterior + reproduzida com CSV
-- real de 167 linhas, preço 9.99–129.99, custo 3.33–24.16, ano 2026):
--
--   products.markup_pct é GENERATED ALWAYS AS STORED, calculada
--   automaticamente pelo Postgres em todo INSERT em products:
--
--     markup_pct = ROUND(((base_price - base_cost) / base_cost) * 100, 2)
--
--   Definida como NUMERIC(5,2) (limite ±999,99) em dois arquivos de
--   baseline (DATABASE_SCHEMA.sql:236-248, src/lib/db/migrations/
--   000_schema_completo.sql:500-514) — nenhuma migration incremental cria
--   essas colunas, mesmo padrão de coluna retroativa já visto neste projeto.
--
--   Com custo baixo e preço normal de varejo (ex.: custo=3.33, preço=99.90),
--   markup = ((99.90-3.33)/3.33)*100 = 2900.30% — já estoura NUMERIC(5,2).
--   Isso NÃO é dado inválido do CSV: é a fórmula de markup sendo
--   matematicamente ilimitada por cima (cresce sem limite conforme o custo
--   se aproxima de zero relativo ao preço), presa numa coluna com só 3
--   dígitos inteiros de folga.
--
--   products.margin_pct (a outra coluna NUMERIC(5,2)) NUNCA estoura para
--   custo < preço — é matematicamente limitada a [0,100] nesse caso — não é
--   tocada por esta migration.
--
--   ano (products.ano) é TEXT NOT NULL (000_schema_completo.sql:524), nunca
--   convertido para número em nenhum ponto da importação — descartado como
--   causa por evidência direta de código, não suposição.
--
-- O QUE FAZ:
--   1. Alarga products.markup_pct de NUMERIC(5,2) para NUMERIC(9,2) —
--      ALTER COLUMN TYPE em coluna GERADA funciona diretamente (não precisa
--      dropar/recriar; a expressão e o STORED são preservados automaticamente
--      pelo Postgres). Só essa coluna — margin_pct e as NUMERIC(10,2)/
--      NUMERIC(10,4) de custo/preço/estoque não são alteradas.
--   2. Revisa rpc_import_products_batch para capturar QUALQUER erro na
--      persistência de um produto do lote e relançar com contexto
--      (client_index + nome do produto), preservando o SQLSTATE/DETAIL/HINT
--      originais do Postgres (não os esconde, só adiciona "qual produto do
--      lote falhou" na frente da mensagem original).
--
-- O QUE NÃO FAZ:
--   - Não altera margin_pct, base_cost, base_price, cost_override,
--     price_override, avg_cost, ano, ou qualquer outra coluna.
--   - Não altera _persist_single_product nem _resolve_product_sku_identity
--     internamente — só o loop de rpc_import_products_batch que já os chama.
--   - Não recalcula nem reescreve nenhuma linha existente além do que o
--     ALTER COLUMN TYPE faz nativamente (recomputa o valor armazenado da
--     coluna gerada sob o novo tipo, para as linhas já existentes — nenhuma
--     linha existente tinha markup fora do limite antigo, então nenhum
--     valor muda de fato, só a constraint de precisão relaxa).
--
-- IDEMPOTENTE: ALTER COLUMN TYPE roda de novo sem erro se já estiver em
-- NUMERIC(9,2) (Postgres trata como no-op quando o tipo já bate). CREATE OR
-- REPLACE FUNCTION é idempotente por natureza.
-- =============================================================================

-- PARTE 1 — Alarga markup_pct (única coluna comprovadamente subdimensionada)
ALTER TABLE public.products
  ALTER COLUMN markup_pct TYPE NUMERIC(9,2);

-- PARTE 2 — rpc_import_products_batch: captura erro por produto do lote e
-- relança com contexto (client_index + nome), preservando SQLSTATE/DETAIL/
-- HINT originais do Postgres.
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
  v_err_detail       TEXT;
  v_err_hint         TEXT;
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
  -- esperado e resolvido pelo discriminador. Qualquer erro (overflow
  -- numérico, violação de constraint, etc.) é capturado aqui só para
  -- anexar QUAL produto do lote falhou — SQLSTATE/DETAIL/HINT originais
  -- do Postgres são preservados via USING, nunca escondidos ou
  -- substituídos por uma mensagem genérica. O erro relançado ainda
  -- aborta a transação inteira (RAISE EXCEPTION propaga normalmente) —
  -- nenhum produto do lote fica parcialmente salvo.
  FOR v_product IN SELECT * FROM jsonb_array_elements(p_products)
  LOOP
    BEGIN
      v_products_out := v_products_out || public._persist_single_product(p_company_id, p_system_user_id, v_product);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS
        v_err_detail = PG_EXCEPTION_DETAIL,
        v_err_hint   = PG_EXCEPTION_HINT;
      RAISE EXCEPTION
        'Falha ao importar produto "%" (client_index=%): %',
        v_product->>'name', v_product->>'client_index', SQLERRM
        USING ERRCODE = SQLSTATE, DETAIL = v_err_detail, HINT = v_err_hint;
    END;
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

-- =============================================================================
-- Smoke tests (estruturais)
-- =============================================================================

SELECT column_name, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'products' AND column_name IN ('margin_pct', 'markup_pct')
ORDER BY column_name;
-- Esperado: margin_pct precision=5 scale=2 (inalterado) / markup_pct precision=9 scale=2 (alargado)

SELECT pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_import_products_batch';
-- Esperado: 1 linha, assinatura inalterada (integer, uuid, jsonb, text)

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
