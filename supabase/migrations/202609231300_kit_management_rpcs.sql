-- =============================================================================
-- 202609231300_kit_management_rpcs.sql
--
-- KITS — criação de kit e edição de composição (Fase C/D).
--
-- Tudo transacional e multi-tenant pelo banco:
--   - company_id NUNCA vem do payload: é derivado de users.company_id do
--     usuário da sessão (mesmo padrão de rpc_create_sale/rpc_stock_*).
--   - Todo id recebido (kit, componente, categoria, marca, atributo) é
--     reconferido contra essa empresa. Id de outra empresa responde igual a
--     "não encontrado" (não confirma existência em outro tenant).
--   - Componentes duplicados no payload são CONSOLIDADOS de forma
--     determinística (soma das quantidades por variação) antes de gravar.
--   - Kit dentro de kit, kit contendo ele mesmo, quantidade <= 0 e kit sem
--     componentes são rejeitados aqui (mensagem amigável) E pelos triggers
--     da fundação (defesa em profundidade).
-- =============================================================================


-- ─── Normalização/validação de componentes ──────────────────────────────────
CREATE OR REPLACE FUNCTION public._kit_normalize_components(
  p_company_id   int,
  p_kit_pvid     int,
  p_components   jsonb
)
RETURNS TABLE (component_product_variation_id int, quantity int)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_el    jsonb;
  v_pvid  int;
  v_qty   int;
  v_kind  text;
  v_comp  int;
BEGIN
  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array' OR jsonb_array_length(p_components) = 0 THEN
    RAISE EXCEPTION 'O kit precisa ter pelo menos um componente.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_el IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    v_pvid := NULLIF(v_el->>'component_product_variation_id', '')::int;
    v_qty  := NULLIF(v_el->>'quantity', '')::int;

    IF v_pvid IS NULL THEN
      RAISE EXCEPTION 'Componente sem variação informada.' USING ERRCODE = 'P0001';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'Quantidade do componente #% precisa ser maior que zero.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    IF p_kit_pvid IS NOT NULL AND v_pvid = p_kit_pvid THEN
      RAISE EXCEPTION 'Um kit não pode conter ele mesmo.' USING ERRCODE = 'P0001';
    END IF;

    SELECT p.product_kind, p.company_id INTO v_kind, v_comp
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_comp IS NULL OR v_comp IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'Componente #% não encontrado.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    IF v_kind = 'kit' THEN
      RAISE EXCEPTION 'Kit dentro de kit não é permitido (variação #% é um kit).', v_pvid USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT (value->>'component_product_variation_id')::int AS cpvid,
         SUM((value->>'quantity')::int)::int              AS qty
  FROM jsonb_array_elements(p_components)
  GROUP BY 1
  ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION public._kit_normalize_components(int, int, jsonb) FROM PUBLIC, anon, authenticated;


-- ─── Grava (substitui) a composição de uma variação de kit ─────────────────
CREATE OR REPLACE FUNCTION public._kit_write_components(
  p_company_id  int,
  p_kit_pvid    int,
  p_components  jsonb,
  p_user_id     uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM product_kit_components
  WHERE kit_product_variation_id = p_kit_pvid
    AND company_id = p_company_id;

  INSERT INTO product_kit_components (
    company_id, kit_product_variation_id, component_product_variation_id, quantity, created_by
  )
  SELECT p_company_id, p_kit_pvid, n.component_product_variation_id, n.quantity, p_user_id
  FROM public._kit_normalize_components(p_company_id, p_kit_pvid, p_components) n;
END;
$$;

REVOKE ALL ON FUNCTION public._kit_write_components(int, int, jsonb, uuid) FROM PUBLIC, anon, authenticated;


-- ─── Cria UMA variação de kit (com atributos opcionais e composição) ──────
CREATE OR REPLACE FUNCTION public._kit_create_variation(
  p_company_id  int,
  p_product_id  int,
  p_variation   jsonb,
  p_user_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_sku        text;
  v_pvid       int;
  v_value_id   int;
  v_type_id    int;
  v_key        text;
BEGIN
  v_sku := btrim(COALESCE(p_variation->>'sku_variation', ''));
  IF length(v_sku) < 2 THEN
    RAISE EXCEPTION 'SKU da variação do kit é obrigatório.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_sku) > 60 THEN
    RAISE EXCEPTION 'SKU "%" excede 60 caracteres.', v_sku USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM product_variations WHERE sku_variation = v_sku) THEN
    RAISE EXCEPTION 'SKU "%" já está em uso.', v_sku USING ERRCODE = 'P0001';
  END IF;

  IF NULLIF(p_variation->>'price_override', '')::numeric IS NOT NULL
     AND (p_variation->>'price_override')::numeric <= 0 THEN
    RAISE EXCEPTION 'Preço da variação % precisa ser maior que zero.', v_sku USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO product_variations (
    product_id, sku_variation, cost_override, price_override, wholesale_price_override, active
  )
  VALUES (
    p_product_id,
    v_sku,
    NULL,
    NULLIF(p_variation->>'price_override', '')::numeric,
    NULLIF(p_variation->>'wholesale_price_override', '')::numeric,
    COALESCE((p_variation->>'active')::boolean, true)
  )
  RETURNING id INTO v_pvid;

  -- Atributos opcionais (cor/tamanho) — mesmo modelo das variações standard.
  FOREACH v_key IN ARRAY ARRAY['color_value_id', 'size_value_id'] LOOP
    v_value_id := NULLIF(p_variation->>v_key, '')::int;
    IF v_value_id IS NOT NULL THEN
      SELECT variation_type_id INTO v_type_id FROM variation_values WHERE id = v_value_id;
      IF v_type_id IS NULL THEN
        RAISE EXCEPTION 'Valor de atributo #% não encontrado.', v_value_id USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO product_variation_attributes (product_variation_id, variation_type_id, variation_value_id)
      VALUES (v_pvid, v_type_id, v_value_id)
      ON CONFLICT (product_variation_id, variation_type_id) DO UPDATE
        SET variation_value_id = EXCLUDED.variation_value_id;
    END IF;
  END LOOP;

  PERFORM public._kit_write_components(p_company_id, v_pvid, p_variation->'components', p_user_id);

  RETURN jsonb_build_object('id', v_pvid, 'sku_variation', v_sku);
END;
$$;

REVOKE ALL ON FUNCTION public._kit_create_variation(int, int, jsonb, uuid) FROM PUBLIC, anon, authenticated;


-- ─── rpc_create_kit_product ─────────────────────────────────────────────────
-- Produto kit + variações + composições numa única transação.
CREATE OR REPLACE FUNCTION public.rpc_create_kit_product(
  p_user_id     uuid,
  p_product     jsonb,
  p_variations  jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company     int;
  v_name        text;
  v_sku         text;
  v_category    int;
  v_brand       int;
  v_price       numeric;
  v_wholesale   numeric;
  v_ano         text;
  v_product_id  int;
  v_var         jsonb;
  v_created     jsonb := '[]'::jsonb;
BEGIN
  SELECT company_id INTO v_company FROM users WHERE id = p_user_id;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  v_name      := btrim(COALESCE(p_product->>'name', ''));
  v_sku       := btrim(COALESCE(p_product->>'sku', ''));
  v_category  := NULLIF(p_product->>'category_id', '')::int;
  v_brand     := NULLIF(p_product->>'brand_id', '')::int;
  v_price     := NULLIF(p_product->>'base_price', '')::numeric;
  v_wholesale := NULLIF(p_product->>'wholesale_price', '')::numeric;
  v_ano       := COALESCE(NULLIF(btrim(p_product->>'ano'), ''), to_char(NOW() AT TIME ZONE 'America/Sao_Paulo', 'YYYY'));

  IF length(v_name) < 2 THEN
    RAISE EXCEPTION 'Nome do kit é obrigatório.' USING ERRCODE = 'P0001';
  END IF;
  IF length(v_sku) < 2 THEN
    RAISE EXCEPTION 'SKU do kit é obrigatório.' USING ERRCODE = 'P0001';
  END IF;
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'Preço do kit precisa ser maior que zero.' USING ERRCODE = 'P0001';
  END IF;
  IF v_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM categories WHERE id = v_category AND (company_id = v_company OR company_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'Categoria inválida.' USING ERRCODE = 'P0001';
  END IF;
  IF v_brand IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM brands WHERE id = v_brand AND company_id = v_company
  ) THEN
    RAISE EXCEPTION 'Marca inválida.' USING ERRCODE = 'P0001';
  END IF;
  IF p_variations IS NULL OR jsonb_typeof(p_variations) <> 'array' OR jsonb_array_length(p_variations) = 0 THEN
    RAISE EXCEPTION 'O kit precisa ter pelo menos uma variação vendável.' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT COUNT(DISTINCT btrim(value->>'sku_variation')) FROM jsonb_array_elements(p_variations))
     <> jsonb_array_length(p_variations) THEN
    RAISE EXCEPTION 'SKUs de variação repetidos no mesmo kit.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM products
    WHERE company_id = v_company AND lower(btrim(name)) = lower(v_name)
      AND tipo = 'kit' AND modelo = 'kit' AND ano = v_ano
  ) THEN
    RAISE EXCEPTION 'Já existe um kit chamado "%".', v_name USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO products (
    name, sku, category_id, brand_id, origin, base_cost, base_price, wholesale_price,
    company_id, active, tipo, modelo, ano, sku_scheme, product_kind,
    ncm, cest, origem, unidade_med
  )
  VALUES (
    v_name, v_sku, v_category, v_brand,
    COALESCE(NULLIF(p_product->>'origin', ''), 'third_party')::product_origin,
    0, v_price, v_wholesale,
    v_company, COALESCE((p_product->>'active')::boolean, true),
    'kit', 'kit', v_ano, 'legacy', 'kit',
    NULLIF(p_product->>'ncm', ''), NULLIF(p_product->>'cest', ''),
    NULLIF(p_product->>'origem', '')::smallint,
    COALESCE(NULLIF(p_product->>'unidade_med', ''), 'UN')
  )
  RETURNING id INTO v_product_id;

  FOR v_var IN SELECT value FROM jsonb_array_elements(p_variations) LOOP
    v_created := v_created || public._kit_create_variation(v_company, v_product_id, v_var, p_user_id);
  END LOOP;

  RETURN jsonb_build_object('product_id', v_product_id, 'variations', v_created);
END;
$$;


-- ─── rpc_add_kit_variations ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_add_kit_variations(
  p_user_id     uuid,
  p_product_id  int,
  p_variations  jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company  int;
  v_kind     text;
  v_var      jsonb;
  v_created  jsonb := '[]'::jsonb;
BEGIN
  SELECT company_id INTO v_company FROM users WHERE id = p_user_id;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT product_kind INTO v_kind
  FROM products WHERE id = p_product_id AND company_id = v_company
  FOR UPDATE;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'Kit não encontrado.' USING ERRCODE = 'P0001';
  END IF;
  IF v_kind <> 'kit' THEN
    RAISE EXCEPTION 'Produto #% não é um kit.', p_product_id USING ERRCODE = 'P0001';
  END IF;
  IF p_variations IS NULL OR jsonb_typeof(p_variations) <> 'array' OR jsonb_array_length(p_variations) = 0 THEN
    RAISE EXCEPTION 'Nenhuma variação informada.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_var IN SELECT value FROM jsonb_array_elements(p_variations) LOOP
    v_created := v_created || public._kit_create_variation(v_company, p_product_id, v_var, p_user_id);
  END LOOP;

  RETURN jsonb_build_object('product_id', p_product_id, 'variations', v_created);
END;
$$;


-- ─── rpc_set_kit_components ─────────────────────────────────────────────────
-- Substitui a composição inteira de uma variação de kit. Vendas antigas não
-- mudam (usam sale_item_components). Lock na variação serializa edições.
CREATE OR REPLACE FUNCTION public.rpc_set_kit_components(
  p_user_id          uuid,
  p_kit_variation_id int,
  p_components       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company  int;
  v_kind     text;
  v_owner    int;
BEGIN
  SELECT company_id INTO v_company FROM users WHERE id = p_user_id;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.product_kind, p.company_id INTO v_kind, v_owner
  FROM product_variations pv JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_kit_variation_id
  FOR UPDATE OF pv;

  IF v_owner IS NULL OR v_owner IS DISTINCT FROM v_company THEN
    RAISE EXCEPTION 'Kit não encontrado.' USING ERRCODE = 'P0001';
  END IF;
  IF v_kind <> 'kit' THEN
    RAISE EXCEPTION 'Variação #% não pertence a um kit.', p_kit_variation_id USING ERRCODE = 'P0001';
  END IF;

  PERFORM public._kit_write_components(v_company, p_kit_variation_id, p_components, p_user_id);

  RETURN (
    SELECT jsonb_agg(jsonb_build_object(
      'component_product_variation_id', component_product_variation_id,
      'quantity', quantity
    ) ORDER BY component_product_variation_id)
    FROM product_kit_components
    WHERE kit_product_variation_id = p_kit_variation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_kit_product(uuid, jsonb, jsonb)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_add_kit_variations(uuid, int, jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_set_kit_components(uuid, int, jsonb)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_kit_product(uuid, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_add_kit_variations(uuid, int, jsonb)   TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_kit_components(uuid, int, jsonb)   TO service_role;
