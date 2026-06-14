-- =============================================================================
-- 20260614_fix_stock_location_name_unique.sql
--
-- OBJETIVO:
--   Impedir dois locais de estoque com o mesmo nome na mesma empresa.
--   Já existe UNIQUE (company_id, slug) desde 20260610; esta migration adiciona
--   o mesmo para name.
--
-- GUARD:
--   Antes de criar a constraint, verifica se há nomes duplicados.
--   Se houver, levanta exceção com a lista dos duplicados e instrução para
--   corrigi-los. A migration NÃO é aplicada parcialmente.
--
-- ROLLBACK:
--   ALTER TABLE public.stock_locations
--     DROP CONSTRAINT IF EXISTS uq_stock_location_name_company;
-- =============================================================================

DO $$
DECLARE
  v_dup_count int;
  v_dup_info  text;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT company_id, name
    FROM public.stock_locations
    GROUP BY company_id, name
    HAVING COUNT(*) > 1
  ) dups;

  IF v_dup_count > 0 THEN
    SELECT string_agg(
      'name="' || name || '" company_id=' || company_id || ' (' || cnt || 'x)',
      ' | '
    )
    INTO v_dup_info
    FROM (
      SELECT company_id, name, COUNT(*) AS cnt
      FROM public.stock_locations
      GROUP BY company_id, name
      HAVING COUNT(*) > 1
      ORDER BY company_id, name
    ) d;

    RAISE EXCEPTION
      'MIGRATION BLOQUEADA: % par(es) de nomes duplicados em stock_locations. '
      'Renomeie os locais duplicados antes de aplicar esta migration. '
      'Duplicados: [%]. '
      'Query para identificar: SELECT company_id, name, COUNT(*) FROM stock_locations GROUP BY company_id, name HAVING COUNT(*) > 1;',
      v_dup_count, v_dup_info
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE public.stock_locations
  ADD CONSTRAINT uq_stock_location_name_company UNIQUE (company_id, name);

COMMENT ON CONSTRAINT uq_stock_location_name_company ON public.stock_locations IS
  'Impede dois locais com o mesmo nome na mesma empresa. '
  'Complementa uq_stock_location_slug_company (adicionado em 20260610).';
