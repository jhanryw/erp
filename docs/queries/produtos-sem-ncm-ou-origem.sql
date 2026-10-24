-- SOMENTE LEITURA — identifica produtos sem NCM válido e/ou sem origem fiscal.
-- Isolamento: sempre filtrado por company_id (substitua :company_id; não use sem filtro).
-- Não altera nada e não sugere valores: a correção deve vir da planilha original
-- (reimportação por SKU) ou de revisão manual com o contador.
--   psql -v company_id=1 -f docs/queries/produtos-sem-ncm-ou-origem.sql
SELECT
  p.id,
  p.sku,
  p.name,
  p.active,
  p.created_at,
  p.ncm,
  p.origem,
  CASE
    WHEN p.ncm IS NULL OR btrim(p.ncm) = ''  THEN 'ncm_ausente'
    WHEN p.ncm !~ '^\d{8}$'                  THEN 'ncm_formato_invalido'
  END AS problema_ncm,
  (p.origem IS NULL) AS origem_ausente,           -- origem = 0 é VÁLIDA, não aparece aqui
  (SELECT count(*) FROM public.product_variations pv WHERE pv.product_id = p.id) AS variacoes
FROM public.products p
WHERE p.company_id = :company_id
  AND (
        p.ncm IS NULL OR btrim(p.ncm) = '' OR p.ncm !~ '^\d{8}$'
     OR p.origem IS NULL
  )
ORDER BY p.created_at DESC, p.id;
