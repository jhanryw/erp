-- =============================================================================
-- 202608311203_import_products_wholesale_fiscal_fields.sql
--
-- _persist_single_product ganha leitura de 4 chaves NOVAS e OPCIONAIS do
-- JSONB de produto (todas ausentes = NULL, comportamento idêntico ao de
-- hoje para todo payload que já existe): wholesale_price, ncm, origem,
-- cst — e 1 chave nova opcional por variante: wholesale_price_override.
-- Nenhuma outra validação/lógica muda.
--
-- Escopo confirmado pela auditoria (docs/varejo-atacado-audit-report.md,
-- seção I): o importador CSV hoje é CREATE-ONLY (produto já existente no
-- ERP é bloqueado no preflight de /api/produtos/import) — permitir
-- ATUALIZAR produto/SKU existente via CSV é um recurso genuinamente novo
-- (match por SKU, política de o que sobrescreve vs. preserva, semântica de
-- estoque numa atualização) e fica DELIBERADAMENTE FORA desta migration —
-- não é seguro decidir de passagem dentro da fundação de varejo/atacado.
-- Ver relatório de entrega para o detalhe desta decisão.
--
-- CST é gravado quando enviado, mas — mesma ressalva de
-- 202608311200_wholesale_retail_schema_foundation.sql — não é lido por
-- nenhuma regra fiscal ainda (motor hoje deriva CSOSN só do CRT da
-- empresa, nunca de produto).
--
-- Assinatura de _persist_single_product é INALTERADA (INT, UUID, JSONB) —
-- CREATE OR REPLACE é seguro, sem risco de overload (mesma identidade de
-- função, só corpo muda).
-- =============================================================================

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
  -- Fundação varejo/atacado — mesma regra de base_price, quando informado.
  IF (p_product->>'wholesale_price') IS NOT NULL AND (p_product->>'wholesale_price')::numeric <= 0 THEN
    RAISE EXCEPTION 'wholesale_price deve ser maior que zero quando informado (produto client_index=%).', p_product->>'client_index';
  END IF;

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

  SELECT * INTO v_identity
  FROM public._resolve_product_sku_identity(p_product->>'sku_base', p_company_id);

  INSERT INTO public.products (
    name, tipo, modelo, ano, category_id, supplier_id, brand_id, origin,
    base_cost, base_price, active, sku, sku_scheme, sku_identity_id,
    subcategory_id, collection_id, company_id,
    wholesale_price, ncm, origem, cst
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
    p_company_id,
    (p_product->>'wholesale_price')::numeric,
    NULLIF(p_product->>'ncm', ''),
    (p_product->>'origem')::smallint,
    NULLIF(p_product->>'cst', '')
  )
  RETURNING id INTO v_product_id;

  UPDATE public.product_sku_identities
  SET product_id = v_product_id
  WHERE id = v_identity.identity_id;

  IF (p_product->>'sku_scheme') = 'dynamic' AND (p_product->>'modelo_value_id') IS NOT NULL THEN
    INSERT INTO public.product_attribute_values (product_id, variation_type_id, variation_value_id)
    VALUES (
      v_product_id,
      (p_product->>'modelo_variation_type_id')::int,
      (p_product->>'modelo_value_id')::int
    );
  END IF;

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
    IF (v_variant->>'wholesale_price_override') IS NOT NULL AND (v_variant->>'wholesale_price_override')::numeric <= 0 THEN
      RAISE EXCEPTION 'wholesale_price_override deve ser maior que zero quando informado (produto client_index=%, variante client_index=%).',
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

    IF EXISTS (SELECT 1 FROM public.product_variations WHERE sku_variation = v_variant_sku) THEN
      RAISE EXCEPTION
        'sku_variation ''%'' já existe — provável cor/tamanho duplicado dentro do mesmo produto (produto client_index=%, variante client_index=%).',
        v_variant_sku, p_product->>'client_index', v_variant_idx;
    END IF;

    INSERT INTO public.product_variations (
      product_id, sku_variation, cost_override, price_override, active, wholesale_price_override
    )
    VALUES (
      v_product_id,
      v_variant_sku,
      (v_variant->>'cost_override')::numeric,
      (v_variant->>'price_override')::numeric,
      true,
      (v_variant->>'wholesale_price_override')::numeric
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

-- Assinatura inalterada (INT, UUID, JSONB) — nenhum REVOKE/GRANT necessário,
-- CREATE OR REPLACE preserva as permissões já concedidas em
-- 202607302600_pim_product_sku_identity.sql.
