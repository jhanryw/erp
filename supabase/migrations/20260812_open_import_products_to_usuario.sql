-- =============================================================================
-- 20260812_open_import_products_to_usuario.sql
--
-- Ajuste final de política de acesso: `usuario` = `admin` dentro do próprio
-- tenant, exceto nos 9 módulos bloqueados. Produtos NÃO está nessa lista.
--
-- rpc_import_products_batch tinha checagem de role embutida na própria
-- função (v_user_role NOT IN ('admin','gerente')) — com
-- POST /api/produtos/import já rebaixado para 'usuario' na API route, o
-- check interno da RPC faria a importação passar pela API e falhar dentro
-- do banco. Único ajuste: aceitar também 'usuario'. Toda a lógica de
-- idempotência, validação de lote, captura/relance de erro por produto e
-- validação de empresa (v_user_company_id IS DISTINCT FROM p_company_id)
-- permanece idêntica.
--
-- Base: 202607302700_fix_markup_pct_overflow_and_import_error_detail.sql
-- =============================================================================

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
  -- Fase 2 (ajuste final): Produtos não está nos 9 módulos bloqueados —
  -- usuario = admin aqui. Antes: exigia 'admin'/'gerente'.
  IF v_user_role NOT IN ('admin', 'gerente', 'usuario') THEN
    RAISE EXCEPTION 'Usuário % não tem role reconhecido para importar produtos (role=%).', p_system_user_id, v_user_role;
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

-- GRANT permanece restrito a service_role (Fase 1: não concedido a
-- authenticated — import só é chamado server-side via createAdminClient()).

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Reaplicar 202607302700_fix_markup_pct_overflow_and_import_error_detail.sql
-- para restaurar a checagem de role original ('admin','gerente' apenas).
*/
-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
