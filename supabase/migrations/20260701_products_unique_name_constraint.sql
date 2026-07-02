-- =============================================================================
-- 20260701_products_unique_name_constraint.sql
--
-- Objetivo:
--   Impedir a criação de produtos com o mesmo nome + tipo + modelo + ano
--   dentro da mesma empresa. Resolve a causa raiz de duplicação de produtos
--   identificada na auditoria de 2026-07-01.
--
-- Contexto:
--   products.sku (SKU mãe) foi tornada não-única em 014_products_sku_parent_not_unique
--   porque o mesmo SKU pai é compartilhado por produtos de mesma categoria/modelo/ano
--   mas nomes distintos. A proteção real contra duplicidade deve ser em
--   (company_id, name normalizado, tipo, modelo, ano).
--
-- Segurança:
--   Esta migration FALHA com RAISE EXCEPTION se existirem duplicados, protegendo
--   o banco de criar um índice inconsistente. Rode a query de diagnóstico antes:
--
--   SELECT company_id, lower(trim(name)), tipo, modelo, ano, COUNT(*), array_agg(id)
--   FROM public.products
--   GROUP BY 1, 2, 3, 4, 5
--   HAVING COUNT(*) > 1;
--
-- =============================================================================

DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  -- Verifica se existem duplicados antes de tentar criar o índice
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM public.products
    GROUP BY company_id, lower(trim(name)), tipo, modelo, ano
    HAVING COUNT(*) > 1
  ) sub;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Existem % grupo(s) de produtos duplicados. Resolva os duplicados antes de aplicar esta migration. '
      'Execute: SELECT company_id, lower(trim(name)), tipo, modelo, ano, COUNT(*), array_agg(id) '
      'FROM public.products GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1;',
      dup_count;
  END IF;
END;
$$;

-- Cria o índice único apenas se não há duplicados
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_company_name_tipo_modelo_ano
  ON public.products (company_id, lower(trim(name)), tipo, modelo, ano);

COMMENT ON INDEX public.uq_products_company_name_tipo_modelo_ano IS
  'Impede produtos com mesmo nome (case-insensitive, sem espaços extras), tipo, modelo e ano '
  'dentro da mesma empresa. Criado em 20260701 como proteção contra duplicação.';
