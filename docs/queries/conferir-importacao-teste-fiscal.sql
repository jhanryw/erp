-- SOMENTE LEITURA — confere o CSV de teste "docs/testes/importacao-teste-fiscal.csv" importado pelo ERP.
-- Rode cada bloco separadamente no SQL Editor (mostra só o resultado da última instrução).

-- ===== 1) Comparação esperado (CSV) × real (banco). Esperado: situacao = OK em TODAS as linhas =====
WITH esperado(nome, ncm, origem, cst, atacado, preco, custo, origin, variacoes) AS (VALUES
  ('ZZ TESTE Fiscal A (apagar)', '61082100', 0::smallint, '000',      14.90::numeric, 19.90::numeric, 8.00::numeric, 'third_party', 2),
  ('ZZ TESTE Fiscal B (apagar)', '61082200', 2::smallint, NULL::text, 17.90::numeric, 24.90::numeric, 9.50::numeric, 'own_brand',   2)
)
SELECT e.nome,
       p.id, p.ncm AS ncm_real, e.ncm AS ncm_esperado,
       p.origem AS origem_real, e.origem AS origem_esperada,
       p.cst AS cst_real, e.cst AS cst_esperado,
       p.wholesale_price AS atacado_real, e.atacado AS atacado_esperado,
       p.origin::text AS origem_comercial_real,
       (SELECT count(*) FROM public.product_variations pv WHERE pv.product_id = p.id) AS variacoes_reais,
       CASE WHEN p.id IS NULL                                   THEN 'PRODUTO NÃO CRIADO'
            WHEN p.ncm IS DISTINCT FROM e.ncm                   THEN 'NCM NÃO GRAVADO / DIFERENTE'
            WHEN p.origem IS DISTINCT FROM e.origem             THEN 'ORIGEM FISCAL NÃO GRAVADA / DIFERENTE'
            WHEN p.cst IS DISTINCT FROM e.cst                   THEN 'CST DIFERENTE'
            WHEN p.wholesale_price IS DISTINCT FROM e.atacado   THEN 'PREÇO DE ATACADO NÃO GRAVADO'
            WHEN p.base_price <> e.preco OR p.base_cost <> e.custo THEN 'PREÇO/CUSTO DIFERENTE'
            WHEN p.origin::text <> e.origin                     THEN 'ORIGEM COMERCIAL DIFERENTE (confundida com fiscal?)'
            WHEN (SELECT count(*) FROM public.product_variations pv WHERE pv.product_id = p.id) <> e.variacoes THEN 'VARIAÇÕES DIFERENTES'
            ELSE 'OK' END AS situacao
FROM esperado e
LEFT JOIN public.products p ON p.company_id = 1 AND p.name = e.nome
ORDER BY e.nome;

-- ===== 2) Prova de que foi gravado PELA IMPORTAÇÃO, sem UPDATE/backfill depois =====
-- O trigger set_updated_at muda updated_at em qualquer UPDATE. Se updated_at = created_at, a linha nunca foi alterada
-- depois do INSERT feito pela importação. Esperado: gravado_direto_pela_importacao = true nas 2 linhas.
SELECT p.id, p.name, p.created_at, p.updated_at,
       (p.updated_at = p.created_at) AS gravado_direto_pela_importacao,
       (p.created_at > now() - interval '1 day') AS criado_nas_ultimas_24h
FROM public.products p
WHERE p.company_id = 1 AND p.name LIKE 'ZZ TESTE Fiscal%'
ORDER BY p.name;

-- ===== 3) Sanidade: sem duplicatas, sem estoque, inativos (não publicam em loja/marketplace) =====
SELECT p.name, p.active,
       count(DISTINCT p.id)                                   AS produtos_com_esse_nome,
       count(pv.id)                                           AS variacoes,
       COALESCE(sum(s.quantity), 0)                           AS estoque_total
FROM public.products p
LEFT JOIN public.product_variations pv ON pv.product_id = p.id
LEFT JOIN public.stock s ON s.product_variation_id = pv.id
WHERE p.company_id = 1 AND p.name LIKE 'ZZ TESTE Fiscal%'
GROUP BY p.name, p.active
ORDER BY p.name;

-- ===== 4) A função de produção ainda é a versão fiscal? Esperado: md5 = 05c98334601616ccbe1d274d421c8811 e tem_ncm = true =====
SELECT md5(pg_get_functiondef('public._persist_single_product(int,uuid,jsonb)'::regprocedure)) AS md5_funcao,
       pg_get_functiondef('public._persist_single_product(int,uuid,jsonb)'::regprocedure) ~ 'p_product->>''ncm''' AS tem_ncm;
