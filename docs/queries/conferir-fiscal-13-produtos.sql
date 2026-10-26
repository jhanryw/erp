-- SOMENTE LEITURA — confirma que os produtos 850..862 (company_id = 1) estão com NCM e origem corretos.
-- Esperado: coluna "situacao" = OK nas 13 linhas.
WITH esperado(id, ncm, origem) AS (VALUES
  (850,'62121000',0),(851,'62121000',0),(852,'62121000',0),(853,'61082200',0),(854,'61082200',0),
  (855,'61082200',0),(856,'61082200',0),(857,'61082100',0),(858,'61082100',0),(859,'61082100',0),
  (860,'61082100',0),(861,'62121000',0),(862,'62121000',0))
SELECT e.id, p.name, p.ncm, p.origem, p.updated_at,
       CASE WHEN p.id IS NULL THEN 'PRODUTO NÃO ENCONTRADO'
            WHEN p.ncm IS NULL OR p.origem IS NULL THEN 'AINDA SEM FISCAL'
            WHEN p.ncm = e.ncm AND p.origem = e.origem THEN 'OK'
            ELSE 'DIVERGENTE DO CSV' END AS situacao
FROM esperado e LEFT JOIN public.products p ON p.id = e.id AND p.company_id = 1
ORDER BY e.id;
