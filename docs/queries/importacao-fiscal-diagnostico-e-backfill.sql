-- Diagnóstico e correção dos produtos importados do CSV "MB e ClickC out_26" sem NCM/origem fiscal.
-- Rodar no SQL Editor do Supabase de PRODUÇÃO, passo a passo. Os passos 1-2 só leem; o 3 só preenche
-- colunas NULL (nunca altera valor já cadastrado) e roda em transação com conferência antes do COMMIT.

-- 1) A migration fiscal está aplicada? Esperado: tem_ncm = true. Se false, aplique
--    supabase/migrations/202608311203_import_products_wholesale_fiscal_fields.sql (CREATE OR REPLACE, seguro).
SELECT pg_get_functiondef('public._persist_single_product(int,uuid,jsonb)'::regprocedure) ~ 'ncm' AS tem_ncm;

-- 2) Produtos desse arquivo sem NCM/origem fiscal
SELECT id, name, ncm, origem, origin, created_at
FROM public.products
WHERE (ncm IS NULL OR origem IS NULL)
  AND created_at > now() - interval '30 days'
ORDER BY created_at DESC;

-- 3) Preencher SOMENTE o que está NULL (company_id da Santtorini: ajuste se necessário)
BEGIN;
WITH fonte(nome, ncm, origem) AS (VALUES
    ('Conjunto Cropped SX Preto', '62121000', 0),
    ('Conjunto Cropped SX Branco', '62121000', 0),
    ('Conjunto Cropped SX Vermelho', '62121000', 0),
    ('Calcinha Avulsa de Renda Verde Água', '61082200', 0),
    ('Calcinha Avulsa de Renda Vermelho', '61082200', 0),
    ('Calcinha Avulsa de Renda Preto', '61082200', 0),
    ('Calcinha Avulsa de Renda Amarelo', '61082200', 0),
    ('Calcinha Cotton Preto', '61082100', 0),
    ('Calcinha Cotton Azul Marinho', '61082100', 0),
    ('Calcinha Cotton Branco', '61082100', 0),
    ('Calcinha Cotton Rosê', '61082100', 0),
    ('Conjunto Tule Bordado Marrom', '62121000', 0),
    ('Sutiã Tule Bordado Preto', '62121000', 0)
)
UPDATE public.products p
SET ncm    = COALESCE(p.ncm, f.ncm),
    origem = COALESCE(p.origem, f.origem::smallint)
FROM fonte f
WHERE p.company_id = 1
  AND p.created_at > '2026-10-26'
  AND lower(trim(p.name)) = lower(trim(f.nome))
  AND (p.ncm IS NULL OR p.origem IS NULL)
RETURNING p.id, p.name, p.ncm, p.origem;
-- Confira as linhas acima; se estiver certo: COMMIT;  senão: ROLLBACK;
