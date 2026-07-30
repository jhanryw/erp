-- =============================================================================
-- 202607302200_pim_seed_categorias_todos_tipos.sql
--
-- Revisão da taxonomia: garante que os Product Types do segmento (lingerie,
-- sleepwear, sex shop) tenham Categorias comerciais reais vinculadas via
-- product_type_id — corrige o select de Categoria vazio para Tipos novos
-- (ex.: Meia-calça) sem nenhuma mudança de backend/frontend (a listagem já
-- é genérica por product_type_id).
--
-- LEVANTAMENTO (Product Types hoje rastreados nas migrations deste
-- repositório — 18 no total): sutia, calcinha, body, pijama, camisola,
-- baby_doll, robe, top, short_doll, pijama_vestido, pijama_americano,
-- camisola_americana, pijama_rendado, conjunto_calcinha_sutia, cinta
-- (202607301700), sex_shop (202607301400/1500), meia_calca (202607301800),
-- acessorio_intimo (202607302000).
--
-- VERIFICAÇÃO ANTES DE CRIAR (feita em SQL, no momento da aplicação, não
-- assumida por este agente — o ambiente é self-hosted, sem acesso de
-- leitura direto): para cada Tipo do catálogo abaixo, só insere categorias
-- SE esse Tipo ainda não tiver NENHUMA categoria ativa vinculada
-- (product_type_id = pt.id AND active = true). Se já tiver, a inserção
-- inteira daquele Tipo é pulada — reaproveita o que já existe, nunca
-- duplica. Confirmado por leitura de arquivo: Sex Shop já tem 10
-- categorias reais (202607301500_pim_seed_categories_sex_shop.sql) — por
-- isso NÃO está no catálogo abaixo (seria sempre pulado mesmo se
-- estivesse; foi omitido para manter a migration focada nos Tipos que
-- realmente precisam).
--
-- GAP CONHECIDO — 4 Tipos SEM lista de categorias definida pelo usuário:
-- pijama_vestido, pijama_americano, camisola_americana, pijama_rendado.
-- Não foram incluídos neste catálogo — criar categorias "genéricas" para
-- eles violaria a regra de não inventar divisões comerciais fictícias.
-- Ficam para uma migration futura, quando a lista real for confirmada.
--
-- Categorias representam famílias comerciais (nunca Modelo/atributo) —
-- cada linha abaixo é uma decisão de catálogo, não uma inferência deste
-- agente a partir de dado de produção.
--
-- IDEMPOTENTE: a checagem "só insere se o Tipo ainda não tiver nenhuma
-- categoria ativa" torna a migration seguramente re-executável — se rodar
-- de novo depois que o Tipo já tiver ganhado categorias (por esta ou por
-- qualquer outra via), nada é reinserido. ON CONFLICT (company_id,
-- product_type_id, slug) DO NOTHING como segunda camada de proteção contra
-- duplicidade de slug dentro do mesmo Tipo.
-- =============================================================================

WITH categoria_catalogo (tipo_slug, name, slug) AS (
  VALUES
    -- Sutiã
    ('sutia', 'Básico',           'basico'),
    ('sutia', 'Push Up',          'push-up'),
    ('sutia', 'Sem Bojo',         'sem-bojo'),
    ('sutia', 'Com Bojo',         'com-bojo'),
    ('sutia', 'Amamentação',      'amamentacao'),
    ('sutia', 'Tomara que Caia',  'tomara-que-caia'),
    ('sutia', 'Nadador',          'nadador'),
    ('sutia', 'Esportivo',        'esportivo'),

    -- Calcinha
    ('calcinha', 'Básica',        'basica'),
    ('calcinha', 'Rendada',       'rendada'),
    ('calcinha', 'Sem Costura',   'sem-costura'),
    ('calcinha', 'Modeladora',    'modeladora'),
    ('calcinha', 'Gestante',      'gestante'),

    -- Body
    ('body', 'Básico',            'basico'),
    ('body', 'Renda',             'renda'),
    ('body', 'Modelador',         'modelador'),
    ('body', 'Sensual',           'sensual'),

    -- Pijama
    ('pijama', 'Curto',           'curto'),
    ('pijama', 'Longo',           'longo'),
    ('pijama', 'Inverno',         'inverno'),
    ('pijama', 'Verão',           'verao'),

    -- Camisola
    ('camisola', 'Curta',         'curta'),
    ('camisola', 'Longa',         'longa'),
    ('camisola', 'Rendada',       'rendada'),
    ('camisola', 'Amamentação',   'amamentacao'),

    -- Baby Doll
    ('baby_doll', 'Curto',        'curto'),
    ('baby_doll', 'Renda',        'renda'),
    ('baby_doll', 'Sensual',      'sensual'),

    -- Robe
    ('robe', 'Curto',             'curto'),
    ('robe', 'Longo',             'longo'),
    ('robe', 'Renda',             'renda'),
    ('robe', 'Cetim',             'cetim'),

    -- Top
    ('top', 'Fitness',            'fitness'),
    ('top', 'Casual',             'casual'),

    -- Short Doll
    ('short_doll', 'Básico',      'basico'),
    ('short_doll', 'Renda',       'renda'),
    ('short_doll', 'Microfibra',  'microfibra'),

    -- Conjunto (Calcinha e Sutiã)
    ('conjunto_calcinha_sutia', 'Básico',     'basico'),
    ('conjunto_calcinha_sutia', 'Renda',      'renda'),
    ('conjunto_calcinha_sutia', 'Microfibra', 'microfibra'),
    ('conjunto_calcinha_sutia', 'Sensual',    'sensual'),
    ('conjunto_calcinha_sutia', 'Noiva',      'noiva'),

    -- Cinta
    ('cinta', 'Modeladora',       'modeladora'),
    ('cinta', 'Pós-parto',        'pos-parto'),
    ('cinta', 'Alta Compressão',  'alta-compressao'),

    -- Meia-calça
    ('meia_calca', 'Lisa',        'lisa'),
    ('meia_calca', 'Arrastão',    'arrastao'),
    ('meia_calca', 'Térmica',     'termica'),
    ('meia_calca', 'Modeladora',  'modeladora'),
    ('meia_calca', 'Compressão',  'compressao'),

    -- Acessório Íntimo
    ('acessorio_intimo', 'Fitas',       'fitas'),
    ('acessorio_intimo', 'Protetores',  'protetores'),
    ('acessorio_intimo', 'Acessórios',  'acessorios')
)
INSERT INTO public.categories (name, slug, company_id, product_type_id, active)
SELECT cat.name, cat.slug, 1, pt.id, true
FROM categoria_catalogo cat
JOIN public.product_types pt ON pt.company_id = 1 AND pt.slug = cat.tipo_slug
WHERE NOT EXISTS (
  SELECT 1 FROM public.categories c2
  WHERE c2.product_type_id = pt.id AND c2.active = true
)
ON CONFLICT (company_id, product_type_id, slug) DO NOTHING;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Todos os Product Types e sua contagem de categorias ativas — a fonte de
-- verdade real, não uma suposição. Esperado após aplicar: todos com
-- contagem > 0, EXCETO os 4 Tipos do gap conhecido (pijama_vestido,
-- pijama_americano, camisola_americana, pijama_rendado), que aparecem com
-- 0 até uma migration futura definir a lista real.
SELECT pt.slug AS product_type, pt.name, count(c.id) AS categorias_ativas
FROM public.product_types pt
LEFT JOIN public.categories c ON c.product_type_id = pt.id AND c.active = true
WHERE pt.company_id = 1
GROUP BY pt.slug, pt.name
ORDER BY categorias_ativas ASC, pt.slug;

-- Contagem de Tipos SEM nenhuma categoria ativa (esperado: 4, os do gap
-- conhecido — se vier diferente de 4, investigar antes de seguir)
SELECT count(*) FROM public.product_types pt
WHERE pt.company_id = 1
  AND NOT EXISTS (
    SELECT 1 FROM public.categories c
    WHERE c.product_type_id = pt.id AND c.active = true
  );
-- Esperado: 4

-- Confirma que nenhuma categoria nova colide em slug dentro do mesmo Tipo
SELECT product_type_id, slug, count(*)
FROM public.categories
WHERE company_id = 1 AND product_type_id IS NOT NULL
GROUP BY product_type_id, slug
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- Confirma que Sex Shop continua com suas 10 categorias originais,
-- intocadas por esta migration
SELECT count(*) FROM public.categories c
JOIN public.product_types pt ON pt.id = c.product_type_id
WHERE pt.slug = 'sex_shop' AND c.active = true;
-- Esperado: 10

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
