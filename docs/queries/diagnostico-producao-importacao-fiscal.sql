-- =============================================================================
-- DIAGNÓSTICO (SOMENTE LEITURA) — importação de NCM / origem fiscal / CST
-- Rodar no SQL Editor do Supabase de PRODUÇÃO. Só SELECT: nada é criado, alterado ou apagado.
-- O editor mostra só o resultado da ÚLTIMA instrução: rode UMA consulta por vez (A, B, C, D, E).
-- Origem fiscal 0 é valor válido: ausência = IS NULL, nunca "= 0" nem "falsy".
-- Permissões: pg_proc / information_schema / pg_constraint / pg_trigger funcionam no papel padrão
-- do SQL Editor (postgres). A consulta E (histórico) pode falhar por permissão: é opcional.
-- =============================================================================


-- ============================ A) FUNÇÕES E ESTRUTURA ============================
-- Cada linha = uma verificação. Envie a tabela inteira de volta.
WITH fn AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_functiondef(p.oid)                 AS def,
         md5(pg_get_functiondef(p.oid))            AS md5_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('_persist_single_product','rpc_import_products_batch','rpc_update_products_by_sku_batch',
                      '_update_single_product_by_sku','_resolve_product_sku_identity','_build_variant_sku')
),
cols AS (
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'products' AND column_name IN ('ncm','origem','cst','wholesale_price','origin','company_id','sku','sku_identity_id','sku_scheme','brand_id'))
      OR (table_name = 'product_variations' AND column_name IN ('sku_variation','wholesale_price_override','price_override','cost_override')))
)
SELECT '1 função' AS secao, 'existe ' || e.nome AS verificacao,
       COALESCE((SELECT count(*)::text FROM fn WHERE fn.proname = e.nome), '0') || ' definição(ões)' AS valor,
       CASE WHEN (SELECT count(*) FROM fn WHERE fn.proname = e.nome) = 1 THEN 'OK'
            WHEN (SELECT count(*) FROM fn WHERE fn.proname = e.nome) = 0 THEN 'AUSENTE'
            ELSE 'OVERLOAD (verificar assinaturas)' END AS status
FROM (VALUES ('_persist_single_product'),('rpc_import_products_batch'),('rpc_update_products_by_sku_batch'),
             ('_update_single_product_by_sku'),('_resolve_product_sku_identity'),('_build_variant_sku')) AS e(nome)
UNION ALL
SELECT '2 assinatura', fn.proname, fn.args, 'informativo' FROM fn
UNION ALL
SELECT '3 _persist grava fiscal', m.marcador,
       CASE WHEN d.def IS NULL THEN '(função ausente)' WHEN position(m.trecho IN d.def) > 0 THEN 'presente' ELSE 'ausente' END,
       CASE WHEN d.def IS NULL THEN 'AUSENTE'
            WHEN position(m.trecho IN d.def) > 0 THEN 'OK' ELSE 'MIGRATION FISCAL AUSENTE / FUNÇÃO DESATUALIZADA' END
FROM (VALUES
  ('lê p_product->>ncm',               'p_product->>''ncm'''),
  ('lê p_product->>origem',            'p_product->>''origem'''),
  ('lê p_product->>cst',               'p_product->>''cst'''),
  ('lê p_product->>wholesale_price',   'p_product->>''wholesale_price'''),
  ('lê variante wholesale_price_override', 'wholesale_price_override'),
  ('INSERT inclui coluna ncm',         'wholesale_price, ncm, origem, cst')
) AS m(marcador, trecho)
LEFT JOIN (SELECT def FROM fn WHERE proname = '_persist_single_product' LIMIT 1) d ON true
UNION ALL
SELECT '4 md5 definição (comparar c/ repositório)', fn.proname || '(' || fn.args || ')', fn.md5_def, 'informativo' FROM fn
UNION ALL
SELECT '5 update por SKU', m.marcador,
       CASE WHEN d.def IS NULL THEN '(função ausente)' WHEN position(m.trecho IN d.def) > 0 THEN 'presente' ELSE 'ausente' END,
       CASE WHEN d.def IS NULL THEN 'AUSENTE'
            WHEN position(m.trecho IN d.def) > 0 THEN 'OK' ELSE 'DESATUALIZADA vs 20260901' END
FROM (VALUES
  ('trata chave ncm no patch',    'p_patch ? ''ncm'''),
  ('trata chave origem no patch', 'p_patch ? ''origem'''),
  ('trata chave cst no patch',    'p_patch ? ''cst''')
) AS m(marcador, trecho)
LEFT JOIN (SELECT def FROM fn WHERE proname = '_update_single_product_by_sku' LIMIT 1) d ON true
UNION ALL
SELECT '5 update por SKU', 'rpc_update_products_by_sku_batch chama _update_single_product_by_sku',
       CASE WHEN d.def IS NULL THEN '(ausente)' WHEN position('_update_single_product_by_sku' IN d.def) > 0 THEN 'sim' ELSE 'não' END, 'informativo'
FROM (SELECT (SELECT def FROM fn WHERE proname = 'rpc_update_products_by_sku_batch' LIMIT 1) AS def) d
UNION ALL
SELECT '6 coluna', c.table_name || '.' || c.column_name, c.data_type || ' / nullable=' || c.is_nullable, 'informativo' FROM cols c
UNION ALL
SELECT '6 coluna esperada', x.t || '.' || x.c,
       CASE WHEN EXISTS (SELECT 1 FROM cols WHERE table_name = x.t AND column_name = x.c) THEN 'existe' ELSE 'FALTA' END,
       CASE WHEN EXISTS (SELECT 1 FROM cols WHERE table_name = x.t AND column_name = x.c) THEN 'OK' ELSE 'PROBLEMA NA ESTRUTURA' END
FROM (VALUES ('products','ncm'),('products','origem'),('products','cst'),('products','wholesale_price'),('products','company_id'),
             ('product_variations','sku_variation'),('product_variations','wholesale_price_override')) AS x(t,c)
UNION ALL
SELECT '6 tipo esperado', 'products.ncm = text / origem = smallint / cst = text',
       (SELECT string_agg(column_name || '=' || data_type, ', ' ORDER BY column_name) FROM cols WHERE table_name = 'products' AND column_name IN ('ncm','origem','cst')),
       CASE WHEN (SELECT count(*) FROM cols WHERE table_name = 'products' AND ((column_name = 'ncm' AND data_type = 'text') OR (column_name = 'origem' AND data_type = 'smallint') OR (column_name = 'cst' AND data_type = 'text'))) = 3
            THEN 'OK' ELSE 'PROBLEMA NA ESTRUTURA' END
ORDER BY 1, 2;


-- ===================== B) CONSTRAINTS E TRIGGERS EM products =====================
-- Algo aqui pode alterar/zerar ncm ou origem depois do INSERT (problema de persistência fora da função).
SELECT 'constraint' AS tipo, conname AS nome, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint WHERE conrelid = 'public.products'::regclass
  AND (pg_get_constraintdef(oid) ILIKE '%ncm%' OR pg_get_constraintdef(oid) ILIKE '%origem%' OR pg_get_constraintdef(oid) ILIKE '%cst%')
UNION ALL
SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t WHERE t.tgrelid = 'public.products'::regclass AND NOT t.tgisinternal
ORDER BY 1, 2;


-- ============ C) CONTAGENS POR EMPRESA (multi-tenant) — identifique a Santtorini ============
-- Uma linha por company_id. "sem_ncm" = IS NULL ou vazio; "sem_origem" = IS NULL (0 é válido).
SELECT p.company_id,
       count(*)                                                                         AS produtos,
       count(*) FILTER (WHERE p.ncm IS NULL OR btrim(p.ncm) = '')                       AS sem_ncm,
       count(*) FILTER (WHERE p.origem IS NULL)                                         AS sem_origem,
       count(*) FILTER (WHERE (p.ncm IS NULL OR btrim(p.ncm) = '') AND p.origem IS NULL) AS sem_ambos,
       count(*) FILTER (WHERE (p.ncm IS NULL OR btrim(p.ncm) = '') <> (p.origem IS NULL)) AS so_um_preenchido,
       count(*) FILTER (WHERE p.ncm IS NOT NULL AND p.ncm !~ '^\d{8}$')                 AS ncm_formato_invalido,
       count(*) FILTER (WHERE p.origem = 0)                                             AS origem_zero_valida,
       count(*) FILTER (WHERE p.created_at > now() - interval '3 days')                 AS criados_ultimos_3_dias,
       count(*) FILTER (WHERE p.created_at > now() - interval '3 days'
                          AND ((p.ncm IS NULL OR btrim(p.ncm) = '') OR p.origem IS NULL)) AS recentes_sem_fiscal,
       min(p.created_at) AS primeiro_cadastro, max(p.created_at) AS ultimo_cadastro
FROM public.products p
GROUP BY p.company_id
ORDER BY produtos DESC;


-- ===================== D) AMOSTRA DE PRODUTOS AFETADOS =====================
-- Troque o valor de alvo.company_id pelo da Santtorini (linha da consulta C). Por padrão usa a empresa com mais produtos.
WITH alvo AS (
  SELECT (SELECT company_id FROM public.products GROUP BY company_id ORDER BY count(*) DESC LIMIT 1) AS company_id
)
SELECT p.company_id, p.id, p.name, p.sku AS sku_produto,
       (SELECT min(pv.sku_variation) FROM public.product_variations pv WHERE pv.product_id = p.id) AS sku_variacao_exemplo,
       (SELECT count(*) FROM public.product_variations pv WHERE pv.product_id = p.id)             AS variacoes,
       p.ncm, p.origem, p.cst, p.origin, p.created_at,
       CASE WHEN (p.ncm IS NULL OR btrim(p.ncm) = '') AND p.origem IS NULL THEN 'sem NCM e sem origem'
            WHEN (p.ncm IS NULL OR btrim(p.ncm) = '')                    THEN 'sem NCM (origem ' || p.origem || ')'
            WHEN p.origem IS NULL                                        THEN 'sem origem (NCM ' || p.ncm || ')'
            ELSE 'NCM fora do formato' END AS problema
FROM public.products p JOIN alvo a ON a.company_id = p.company_id
WHERE (p.ncm IS NULL OR btrim(p.ncm) = '') OR p.origem IS NULL OR p.ncm !~ '^\d{8}$'
ORDER BY p.created_at DESC
LIMIT 60;


-- ================= E) HISTÓRICO DE MIGRATIONS (OPCIONAL, só informativo) =================
-- NÃO prova que a migration está efetiva (a consulta A prova). Pode falhar por permissão ou ter outro nome de tabela.
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version ILIKE ANY (ARRAY['%202608311203%','%202607302600%','%20260901%','%202608311200%','%20260615%'])
ORDER BY version;
