-- =============================================================================
-- AUDITORIA SOMENTE LEITURA — PUT /api/produtos/[id] (novas variações)
-- Rode cada bloco SEPARADAMENTE no SQL Editor do Supabase (self-hosted) e cole
-- o resultado (a única célula JSON) de volta. Só SELECT — nada é alterado.
-- =============================================================================

-- ─── BLOCO 0 — migrations/estruturas presentes ───────────────────────────────
SELECT json_build_object(
  'has_sku_scheme',          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='sku_scheme'),
  'has_sku_identity_id',     EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='sku_identity_id'),
  'has_product_sku_identities', to_regclass('public.product_sku_identities') IS NOT NULL,
  'has_product_attribute_values', to_regclass('public.product_attribute_values') IS NOT NULL,
  'has_type_attribute_values',   to_regclass('public.type_attribute_values') IS NOT NULL,
  'products_total',          (SELECT count(*) FROM public.products),
  'variations_total',        (SELECT count(*) FROM public.product_variations),
  'sku_scheme_counts',       (SELECT json_object_agg(coalesce(sku_scheme,'NULL'), n) FROM (SELECT sku_scheme, count(*) n FROM public.products GROUP BY 1) s),
  'variation_indexes',       (SELECT json_agg(indexdef) FROM pg_indexes WHERE schemaname='public' AND tablename='product_variations'),
  'products_sku_indexes',    (SELECT json_agg(indexdef) FROM pg_indexes WHERE schemaname='public' AND tablename='products' AND indexdef ILIKE '%sku%')
) AS bloco0;

-- ─── BLOCO 1 — PIM: tipos, atributo Modelo e valores governados ──────────────
SELECT json_build_object(
  'product_types', (SELECT json_agg(json_build_object('id',id,'company_id',company_id,'slug',slug,'name',name,'sku_code',sku_code,'active',active)) FROM public.product_types),
  'modelo_type',   (SELECT json_agg(json_build_object('id',id,'slug',slug,'value_governance',value_governance)) FROM public.variation_types WHERE slug='modelo'),
  'type_attributes_modelo', (SELECT json_agg(json_build_object('product_type_id',ta.product_type_id,'required',ta.required,'active',ta.active))
        FROM public.type_attributes ta JOIN public.variation_types vt ON vt.id=ta.variation_type_id WHERE vt.slug='modelo'),
  'type_attribute_values', (SELECT json_agg(json_build_object('product_type_id',tav.product_type_id,'active',tav.active,
        'vv_id',vv.id,'value',vv.value,'slug',vv.slug,'sku_code',vv.sku_code,'vv_active',vv.active))
        FROM public.type_attribute_values tav JOIN public.variation_values vv ON vv.id=tav.variation_value_id)
) AS bloco1;

-- ─── BLOCO 2 — todos os produtos (matriz base) ───────────────────────────────
SELECT json_agg(json_build_object(
  'id', p.id, 'company_id', p.company_id, 'tipo', p.tipo, 'modelo', p.modelo, 'ano', p.ano,
  'sku', p.sku, 'sku_scheme', p.sku_scheme, 'kind', p.product_kind, 'category_id', p.category_id,
  'created_at', p.created_at,
  'discriminator', psi.discriminator,
  'pav_modelo', (SELECT json_build_object('vv_id',vv.id,'value',vv.value,'sku_code',vv.sku_code)
                 FROM public.product_attribute_values pav
                 JOIN public.variation_types vt ON vt.id=pav.variation_type_id AND vt.slug='modelo'
                 JOIN public.variation_values vv ON vv.id=pav.variation_value_id
                 WHERE pav.product_id=p.id LIMIT 1),
  'n_variations', (SELECT count(*) FROM public.product_variations v WHERE v.product_id=p.id),
  'variation_skus', (SELECT json_agg(v.sku_variation ORDER BY v.id) FROM (SELECT * FROM public.product_variations v0 WHERE v0.product_id=p.id ORDER BY v0.id LIMIT 4) v),
  'colors_sizes_null_code', (SELECT count(*) FROM public.product_variation_attributes pva
        JOIN public.variation_values vv ON vv.id=pva.variation_value_id
        JOIN public.product_variations v ON v.id=pva.product_variation_id
        WHERE v.product_id=p.id AND vv.sku_code IS NULL)
)) AS bloco2
FROM public.products p
LEFT JOIN public.product_sku_identities psi ON psi.id = p.sku_identity_id;

-- ─── BLOCO 3 — cor/tamanho: códigos ausentes ou duplicados ───────────────────
SELECT json_build_object(
  'values', (SELECT json_agg(json_build_object('id',vv.id,'type',vt.slug,'value',vv.value,'slug',vv.slug,'sku_code',vv.sku_code,'active',vv.active))
             FROM public.variation_values vv JOIN public.variation_types vt ON vt.id=vv.variation_type_id
             WHERE vt.slug IN ('cor','tamanho')),
  'dup_codes', (SELECT json_agg(json_build_object('type',type,'sku_code',sku_code,'n',n)) FROM (
             SELECT vt.slug type, vv.sku_code, count(*) n FROM public.variation_values vv JOIN public.variation_types vt ON vt.id=vv.variation_type_id
             WHERE vt.slug IN ('cor','tamanho') AND vv.sku_code IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) d)
) AS bloco3;

-- ─── BLOCO 4 — variantes cujo SKU não segue 10 dígitos + sufixo ──────────────
SELECT json_build_object(
  'len_distribution', (SELECT json_object_agg(l, n) FROM (SELECT length(sku_variation) l, count(*) n FROM public.product_variations GROUP BY 1) x),
  'non_numeric', (SELECT count(*) FROM public.product_variations WHERE sku_variation !~ '^[0-9]+$')
) AS bloco4;

-- ─── BLOCO 5 — contagens exatas por cenário (somente leitura) ────────────────

