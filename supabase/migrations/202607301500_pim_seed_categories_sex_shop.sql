-- =============================================================================
-- 202607301500_pim_seed_categories_sex_shop.sql
--
-- Garante que as 10 categorias de Sex Shop existem e estão ligadas ao
-- product_type_id correto — idempotente e seguro independente de a
-- migration original (20260731_pim_seed_sex_shop_acessorio_intimo, nunca
-- confirmada como aplicada nesta sessão) já ter rodado ou não: se as
-- categorias não existirem, cria; se existirem com product_type_id nulo ou
-- errado, corrige. Backfill escopado SOMENTE a estas 10 categorias — não
-- toca em nenhuma outra linha de categories (não é backfill geral do
-- catálogo).
--
-- O QUE NÃO FAZ:
--   - Não mexe em "Sutiã Adesivo" (categoria de Acessório Íntimo, ainda
--     pendente de decisão sobre colisão de nome — fora de escopo aqui).
--   - Não altera nenhuma outra categoria existente (Calcinha, Sutiã com
--     Bojo, Cinta, etc.).
--
-- IDEMPOTENTE: ON CONFLICT DO UPDATE.
-- =============================================================================

INSERT INTO public.categories (name, slug, company_id, product_type_id, active)
SELECT v.name, v.slug, 1, pt.id, true
FROM public.product_types pt, (VALUES
  ('Lubrificantes',   'lubrificantes'),
  ('Vibradores',      'vibradores'),
  ('Sugadores',       'sugadores'),
  ('Estimuladores',   'estimuladores'),
  ('Plugs',           'plugs'),
  ('Anéis Penianos',  'aneis-penianos'),
  ('Masturbadores',   'masturbadores'),
  ('BDSM',            'bdsm'),
  ('Jogos',           'jogos'),
  ('Massagem',        'massagem')
) AS v(name, slug)
WHERE pt.company_id = 1 AND pt.slug = 'sex_shop'
ON CONFLICT (company_id, product_type_id, slug) DO UPDATE
  SET name    = EXCLUDED.name,
      active  = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT c.name, c.slug, c.product_type_id
FROM public.categories c
JOIN public.product_types pt ON pt.id = c.product_type_id
WHERE pt.slug = 'sex_shop'
ORDER BY c.name;
-- Esperado: 10 linhas, todas com product_type_id preenchido

SELECT count(*) FROM public.categories c
JOIN public.product_types pt ON pt.id = c.product_type_id
WHERE pt.slug = 'sex_shop';
-- Esperado: 10

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
