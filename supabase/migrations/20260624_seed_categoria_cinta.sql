-- Migration: 20260624_seed_categoria_cinta.sql
-- Hierarquia:
--   Cinta  (pai, parent_id = NULL)
--   ├── Cinta Liga
--   ├── Cinta Modeladora
--   ├── Body Modelador
--   └── Regata Modeladora

-- Passo 1: criar categoria pai
INSERT INTO public.categories (name, slug, parent_id, company_id, active)
VALUES ('Cinta', 'cinta', NULL, 1, true)
ON CONFLICT (slug) DO NOTHING;

-- Passo 2: criar subcategorias apontando para o pai
INSERT INTO public.categories (name, slug, parent_id, company_id, active)
SELECT 'Cinta Liga',        'cinta-liga',        c.id, 1, true FROM public.categories c WHERE c.slug = 'cinta'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.categories (name, slug, parent_id, company_id, active)
SELECT 'Cinta Modeladora',  'cinta-modeladora',  c.id, 1, true FROM public.categories c WHERE c.slug = 'cinta'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.categories (name, slug, parent_id, company_id, active)
SELECT 'Body Modelador',    'body-modelador',    c.id, 1, true FROM public.categories c WHERE c.slug = 'cinta'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.categories (name, slug, parent_id, company_id, active)
SELECT 'Regata Modeladora', 'regata-modeladora', c.id, 1, true FROM public.categories c WHERE c.slug = 'cinta'
ON CONFLICT (slug) DO NOTHING;
