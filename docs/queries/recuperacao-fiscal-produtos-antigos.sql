-- SOMENTE LEITURA. Gera a planilha-base para recuperar NCM/origem fiscal dos produtos antigos.
-- Uma linha por produto sem NCM ou sem origem, com um SKU de variação (chave do import "atualizar por SKU").
-- As colunas ncm_sugerido/origem_sugerida mostram o valor MAIS USADO pela própria empresa no mesmo tipo+modelo
-- (só referência: a decisão fiscal é sua/do contador). Origem 0 é valor válido.
-- Uso: rode, exporte o resultado em CSV, preencha ncm e origem_fiscal, apague as colunas de apoio (ou deixe: são ignoradas)
-- e importe em Produtos > Importar. Célula vazia nunca apaga o que já existe.
WITH base AS (
  SELECT p.id, p.name, p.tipo, p.modelo, p.ncm, p.origem, p.created_at
  FROM public.products p
  WHERE p.company_id = 1
    AND (p.ncm IS NULL OR btrim(p.ncm) = '' OR p.origem IS NULL)
),
moda AS (
  SELECT p.tipo, p.modelo,
         mode() WITHIN GROUP (ORDER BY p.ncm)    FILTER (WHERE p.ncm IS NOT NULL)    AS ncm_sugerido,
         mode() WITHIN GROUP (ORDER BY p.origem) FILTER (WHERE p.origem IS NOT NULL) AS origem_sugerida,
         count(*) FILTER (WHERE p.ncm IS NOT NULL) AS base_de_calculo
  FROM public.products p WHERE p.company_id = 1 GROUP BY p.tipo, p.modelo
)
SELECT (SELECT min(pv.sku_variation) FROM public.product_variations pv WHERE pv.product_id = b.id) AS sku,
       NULL::text AS ncm, NULL::text AS origem_fiscal,
       b.id AS produto_id, b.name AS produto, b.tipo, b.modelo,
       b.ncm AS ncm_atual, b.origem AS origem_atual,
       m.ncm_sugerido, m.origem_sugerida, m.base_de_calculo
FROM base b LEFT JOIN moda m ON m.tipo = b.tipo AND m.modelo = b.modelo
ORDER BY b.tipo, b.modelo, b.name;
