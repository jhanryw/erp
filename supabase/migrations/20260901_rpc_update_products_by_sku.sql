-- =============================================================================
-- 20260901_rpc_update_products_by_sku.sql
--
-- Importador CSV — UPDATE de produto/variação existente por SKU (conclusão
-- da fundação varejo/atacado, Fase 1). Continuação de
-- 202608311203_import_products_wholesale_fiscal_fields.sql, que já tinha
-- deixado isto deliberadamente fora de escopo.
--
-- ─── Identificador: por que product_variations.sku_variation ────────────
-- Auditoria confirmada nesta sessão (repete achado da Fase 1): products.sku
-- NUNCA teve UNIQUE real (é o "SKU-mãe", compartilhado por cor/tamanho —
-- ver 202607302600_pim_product_sku_identity.sql:12-17). O único
-- identificador que funciona como "código de catálogo" no sentido que o
-- CSV precisa (uma linha = um registro específico) é
-- product_variations.sku_variation — já é o valor gerado/consumido em
-- todo o resto do sistema (busca de produto, PDV, importação atual). Por
-- isso o "SKU" do CSV de update é sempre sku_variation — nenhuma
-- identificação paralela nova.
--
-- ─── Granularidade dos campos ────────────────────────────────────────────
-- Como o identificador é sempre uma VARIAÇÃO, os campos de preço do update
-- SEMPRE tocam a variação (price_override/wholesale_price_override) —
-- NUNCA products.base_price/wholesale_price do produto-pai. Isso evita
-- "transformar preço de variação em preço global do produto" (explicitamente
-- vetado). NCM/origem/CST não têm equivalente por variação no schema (só
-- existem em products) — esses SEMPRE tocam o produto-pai da variação.
--
-- ─── Semântica de célula vazia ────────────────────────────────────────────
-- p_patch (JSONB) só contém uma CHAVE para um campo se o CSV tinha valor
-- não-vazio naquela célula (decisão tomada na camada Node/parser — ver
-- src/lib/utils/import-parser.ts). `_update_single_product_by_sku` usa
-- `p_patch ? 'chave'` (existência da chave, não IS NOT NULL) para decidir
-- se toca a coluna — célula vazia nunca chega como chave presente com
-- valor NULL, então nunca apaga nada. Nenhuma sintaxe de "apagar campo"
-- nesta fase (decisão explícita do dono).
--
-- ─── Atomicidade por linha + parcial-sucesso do lote ─────────────────────
-- `_update_single_product_by_sku` valida TODOS os campos do patch (formato/
-- faixa) ANTES de qualquer UPDATE — nenhuma escrita parcial mesmo sem o
-- savepoint do chamador. `rpc_update_products_by_sku_batch` envolve cada
-- item do lote num bloco BEGIN...EXCEPTION (savepoint implícito do
-- PL/pgSQL) — ao contrário de rpc_import_products_batch (CREATE, que
-- continua all-or-nothing por decisão de 20260812_open_import_products_to_
-- usuario.sql, não alterada aqui), o lote de UPDATE tolera erro por linha e
-- reporta created/updated/errors no final — é o comportamento que o
-- resultado "35 criados, 412 atualizados, 4 erros" pedido nesta fase
-- exige. DELIBERADAMENTE uma função NOVA e SEPARADA de
-- rpc_import_products_batch — não altera o comportamento já testado e
-- recentemente revisado (20260812) do caminho de criação.
--
-- ─── Autorização ──────────────────────────────────────────────────────────
-- Mesma política vigente HOJE pra importação de produtos — confirmada
-- lendo 20260812_open_import_products_to_usuario.sql (a definição REAL
-- mais recente de rpc_import_products_batch, não a de
-- 202607302600/202607302700, que já estavam desatualizadas): role IN
-- ('admin','gerente','usuario') — "usuario = admin" pra Produtos, que não
-- está nos módulos bloqueados.
--
-- ─── Multi-tenancy ─────────────────────────────────────────────────────────
-- Todo lookup de SKU é escopado por company_id (via JOIN products ON
-- product_variations.product_id = products.id AND products.company_id =
-- p_company_id) — nunca WHERE sku_variation = X sozinho. Se 2+ linhas
-- combinarem (não deveria acontecer, mas o código não confia nisso), a
-- linha falha com erro explícito de ambiguidade — nunca escolhe
-- arbitrariamente.
-- =============================================================================

-- PARTE 1 — atualiza uma única variação/produto por SKU. Lança exceção pra
-- qualquer problema (SKU vazio, não encontrado, ambíguo, valor inválido) —
-- nunca falha silenciosamente nem escreve parcialmente.
CREATE OR REPLACE FUNCTION public._update_single_product_by_sku(
  p_company_id     INT,
  p_variation_sku  TEXT,
  p_patch          JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_match_count  INT;
  v_variation_id INT;
  v_product_id   INT;
  v_origem_val   SMALLINT;
BEGIN
  IF p_variation_sku IS NULL OR length(trim(p_variation_sku)) = 0 THEN
    RAISE EXCEPTION 'SKU vazio — não é possível localizar produto para atualização.';
  END IF;

  SELECT COUNT(*) INTO v_match_count
  FROM public.product_variations pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.sku_variation = p_variation_sku
    AND p.company_id = p_company_id;

  IF v_match_count = 0 THEN
    RAISE EXCEPTION
      'SKU "%" não encontrado nesta empresa — verifique o código ou deixe a coluna sku em branco para criar um novo produto.',
      p_variation_sku;
  END IF;
  IF v_match_count > 1 THEN
    RAISE EXCEPTION
      'SKU "%" é ambíguo — % registros encontrados nesta empresa. Corrija o cadastro antes de importar.',
      p_variation_sku, v_match_count;
  END IF;

  SELECT pv.id, pv.product_id INTO v_variation_id, v_product_id
  FROM public.product_variations pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.sku_variation = p_variation_sku
    AND p.company_id = p_company_id;

  -- ── Validação COMPLETA antes de qualquer escrita (atomicidade por linha) ──
  IF p_patch ? 'price_override' THEN
    IF (p_patch->>'price_override')::numeric <= 0 THEN
      RAISE EXCEPTION 'Preço de varejo inválido para SKU "%": deve ser maior que zero.', p_variation_sku;
    END IF;
  END IF;
  IF p_patch ? 'wholesale_price_override' THEN
    IF (p_patch->>'wholesale_price_override')::numeric <= 0 THEN
      RAISE EXCEPTION 'Preço de atacado inválido para SKU "%": deve ser maior que zero.', p_variation_sku;
    END IF;
  END IF;
  IF p_patch ? 'ncm' THEN
    IF (p_patch->>'ncm') !~ '^\d{8}$' THEN
      RAISE EXCEPTION 'NCM inválido para SKU "%": esperado exatamente 8 dígitos, veio "%".', p_variation_sku, p_patch->>'ncm';
    END IF;
  END IF;
  IF p_patch ? 'origem' THEN
    v_origem_val := (p_patch->>'origem')::smallint;
    IF v_origem_val < 0 OR v_origem_val > 8 THEN
      RAISE EXCEPTION 'Origem fiscal inválida para SKU "%": esperado inteiro de 0 a 8, veio %.', p_variation_sku, v_origem_val;
    END IF;
  END IF;
  -- cst: sem validação de formato (mesma política da criação — texto livre
  -- reservado, ver comentário de products.cst na migration de schema).

  -- ── Escrita — só toca coluna cuja CHAVE está presente no patch ──────────
  IF p_patch ? 'price_override' THEN
    UPDATE public.product_variations
    SET price_override = (p_patch->>'price_override')::numeric
    WHERE id = v_variation_id;
  END IF;

  IF p_patch ? 'wholesale_price_override' THEN
    UPDATE public.product_variations
    SET wholesale_price_override = (p_patch->>'wholesale_price_override')::numeric
    WHERE id = v_variation_id;
  END IF;

  IF (p_patch ? 'ncm') OR (p_patch ? 'origem') OR (p_patch ? 'cst') THEN
    UPDATE public.products SET
      ncm    = CASE WHEN p_patch ? 'ncm'    THEN p_patch->>'ncm'             ELSE ncm    END,
      origem = CASE WHEN p_patch ? 'origem' THEN (p_patch->>'origem')::smallint ELSE origem END,
      cst    = CASE WHEN p_patch ? 'cst'    THEN p_patch->>'cst'             ELSE cst    END
    WHERE id = v_product_id;
  END IF;

  RETURN jsonb_build_object(
    'sku', p_variation_sku,
    'variation_id', v_variation_id,
    'product_id', v_product_id
  );
END;
$$;

-- PARTE 2 — lote: autoriza, detecta SKU duplicado dentro do próprio CSV,
-- processa cada item com savepoint (erro numa linha não afeta as outras),
-- devolve resumo (updated/errors) + idempotência (mesma tabela
-- import_batches já usada por rpc_import_products_batch).
CREATE OR REPLACE FUNCTION public.rpc_update_products_by_sku_batch(
  p_company_id      INT,
  p_system_user_id  UUID,
  p_updates         JSONB,
  p_idempotency_key TEXT DEFAULT NULL
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
  v_existing_result JSONB;
  v_result          JSONB;
  v_item            JSONB;
  v_row_result      JSONB;
  v_updated_out     JSONB := '[]'::jsonb;
  v_errors_out      JSONB := '[]'::jsonb;
  v_updated_count   INT := 0;
  v_seen_skus       TEXT[] := ARRAY[]::TEXT[];
  v_sku             TEXT;
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
  -- Mesma política vigente de rpc_import_products_batch (20260812) —
  -- Produtos não está nos módulos bloqueados, usuario = admin aqui.
  IF v_user_role NOT IN ('admin', 'gerente', 'usuario') THEN
    RAISE EXCEPTION 'Usuário % não tem role reconhecido para atualizar produtos (role=%).', p_system_user_id, v_user_role;
  END IF;

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
        'Atualização com idempotency_key "%" já está em andamento para esta empresa.',
        p_idempotency_key;
    END;
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' OR jsonb_array_length(p_updates) = 0 THEN
    RAISE EXCEPTION 'Nenhuma atualização informada.';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_updates)
  LOOP
    v_sku := v_item->>'sku';

    IF v_sku = ANY(v_seen_skus) THEN
      v_errors_out := v_errors_out || jsonb_build_object(
        'client_index', v_item->>'client_index',
        'sku', v_sku,
        'message', format('SKU "%s" duplicado dentro do próprio arquivo — cada linha de atualização precisa de um SKU único no lote.', v_sku)
      );
      CONTINUE;
    END IF;
    v_seen_skus := array_append(v_seen_skus, v_sku);

    -- Bloco BEGIN...EXCEPTION = savepoint implícito do PL/pgSQL: erro
    -- nesta linha desfaz só o que ela tentou escrever e continua pro
    -- próximo item — nunca aborta o lote inteiro (diferente de
    -- rpc_import_products_batch, de propósito, ver cabeçalho do arquivo).
    BEGIN
      v_row_result := public._update_single_product_by_sku(p_company_id, v_sku, v_item);
      v_updated_count := v_updated_count + 1;
      v_updated_out := v_updated_out || (v_row_result || jsonb_build_object('client_index', v_item->>'client_index'));
    EXCEPTION WHEN OTHERS THEN
      v_errors_out := v_errors_out || jsonb_build_object(
        'client_index', v_item->>'client_index',
        'sku', v_sku,
        'message', SQLERRM
      );
    END;
  END LOOP;

  v_result := jsonb_build_object(
    'updated', v_updated_count,
    'errors', v_errors_out,
    'products', v_updated_out
  );

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.import_batches
    SET result = v_result
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public._update_single_product_by_sku(INT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_update_products_by_sku_batch(INT, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_products_by_sku_batch(INT, UUID, JSONB, TEXT) TO service_role;
