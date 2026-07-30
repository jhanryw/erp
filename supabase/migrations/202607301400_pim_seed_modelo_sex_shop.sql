-- =============================================================================
-- 202607301400_pim_seed_modelo_sex_shop.sql
--
-- Estende o atributo Modelo (já existente, criado para Calcinha em
-- 202607301300_pim_seed_modelo_calcinha.sql) para o Tipo Sex Shop. Reaproveita
-- a mesma variation_types "Modelo" — não cria um atributo novo por Tipo.
--
-- O QUE FAZ:
--   0. Garante que product_types 'sex_shop' existe — a migration que criava
--      esse Tipo (20260731_pim_seed_sex_shop_acessorio_intimo) foi só
--      apresentada em chat nesta sessão, nunca confirmada como aplicada nem
--      persistida como arquivo (ficou bloqueada por uma decisão pendente
--      sobre a categoria "Sutiã Adesivo" de Acessório Íntimo). Por isso este
--      arquivo garante a linha por conta própria, via UPSERT — funciona
--      igual se o Tipo já existir ou não.
--   1. Localiza product_types (slug 'sex_shop') e variation_types (slug
--      'modelo').
--   2. Atribui product_types.sku_code='16' ao Sex Shop — CORREÇÃO
--      NECESSÁRIA: uma decisão anterior deixou esse código nulo de
--      propósito ("deixar nulo por enquanto"), mas o SKU dinâmico
--      (resolveDynamicModeloContext) exige um sku_code não-nulo pra
--      resolver o segmento TT — sem isso, Sex Shop cairia silenciosamente
--      no caminho legado, que quebra (sex_shop não existe no mapa estático
--      SKU_TIPO). Acessório Íntimo continua com sku_code nulo, de propósito
--      — não faz parte deste cadastro operacional.
--   3. Cria o vínculo em type_attributes: Sex Shop <-> Modelo,
--      required=FALSE (diferente de Calcinha) — nem todo produto de Sex
--      Shop tem Modelo comercial (lubrificante, óleo de massagem).
--   4. Cria os 9 valores de Modelo de Sex Shop, com sku_code sequencial
--      continuando de onde Calcinha parou (01-05), começando em 06 — nunca
--      colide com Fio/Tanga/Boxer/Caleçon/Cintura Alta.
--   5. Vincula cada um dos 9 valores ao Tipo Sex Shop em
--      type_attribute_values — corrige o gap de governança encontrado em
--      teste real (o endpoint enxergava também os 5 valores de Calcinha,
--      já que os dois Tipos compartilham o mesmo atributo Modelo). Depende
--      de 202607301600 já ter rodado (cria a tabela).
--
-- O QUE NÃO FAZ:
--   - Não cria Modelo pra nenhum outro Tipo além de Sex Shop e Calcinha.
--   - Não altera nenhuma API, formulário ou geração de SKU.
--   - Não altera nenhum produto existente.
--   - Não duplica valor: se "Golfinho"/"Bullet"/etc já existirem em
--     product_models (tabela antiga, Entrega 3b), isso é ignorado — o
--     fluxo novo usa exclusivamente variation_values ligados ao atributo
--     Modelo, nunca lê product_models.
--
-- IDEMPOTENTE: ON CONFLICT DO UPDATE em todas as inserções; UPDATE do
-- sku_code guardado por WHERE pra nunca sobrescrever um valor já corrigido
-- manualmente depois.
-- =============================================================================

-- PARTE -1 — Garante que o Tipo Sex Shop existe (auto-suficiente, não
-- depende de nenhuma migration anterior ter sido aplicada)
INSERT INTO public.product_types (company_id, name, slug, sku_code, active)
VALUES (1, 'Sex Shop', 'sex_shop', NULL, true)
ON CONFLICT (company_id, slug) DO NOTHING;

-- PARTE 0 — sku_code do Tipo Sex Shop (correção da decisão anterior)
UPDATE public.product_types
SET sku_code = '16'
WHERE company_id = 1 AND slug = 'sex_shop' AND sku_code IS NULL;

-- PARTE 1 — Vínculo Sex Shop <-> Modelo (required=false)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, false, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'sex_shop'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 2 — Valores de Modelo de Sex Shop (sku_code 06-14, continuando de
-- Calcinha sem colidir: Fio=01, Tanga=02, Boxer=03, Caleçon=04, Cintura Alta=05)
WITH modelo_type AS (
  SELECT id FROM public.variation_types WHERE slug = 'modelo'
)
INSERT INTO public.variation_values (
  variation_type_id, value, slug, active, normalized_name, sku_code
)
SELECT modelo_type.id, v.value, v.slug, true, v.normalized_name, v.sku_code
FROM modelo_type, (VALUES
  ('Golfinho',             'golfinho',             'golfinho',             '06'),
  ('Bullet',               'bullet',               'bullet',               '07'),
  ('Rabbit',               'rabbit',               'rabbit',               '08'),
  ('Ponto G',              'ponto-g',              'ponto_g',              '09'),
  ('FunnyEggs',            'funnyeggs',            'funnyeggs',            '10'),
  ('Algema',               'algema',               'algema',               '11'),
  ('Chicote',              'chicote',              'chicote',              '12'),
  ('Chibata',              'chibata',              'chibata',              '13'),
  ('Baralho Kama Sutra',   'baralho-kama-sutra',   'baralho_kama_sutra',   '14')
) AS v(value, slug, normalized_name, sku_code)
ON CONFLICT (variation_type_id, slug) DO UPDATE
  SET value           = EXCLUDED.value,
      normalized_name = EXCLUDED.normalized_name,
      sku_code        = EXCLUDED.sku_code,
      active          = true;

-- PARTE 3 — Governança de VALOR: só estes 9 valores ficam visíveis pro
-- Tipo Sex Shop (corrige o vazamento cross-Tipo encontrado em teste real)
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'sex_shop'
  AND vv.slug IN ('golfinho', 'bullet', 'rabbit', 'ponto-g', 'funnyeggs', 'algema', 'chicote', 'chibata', 'baralho-kama-sutra')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT slug, sku_code FROM product_types WHERE company_id = 1 AND slug = 'sex_shop';
-- Esperado: 1 linha, sku_code = '16'

SELECT vv.value, vv.sku_code
FROM type_attribute_values tav
JOIN product_types pt ON pt.id = tav.product_type_id
JOIN variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'sex_shop'
ORDER BY vv.sku_code;
-- Esperado: 9 linhas (Golfinho...Baralho Kama Sutra) — só depois que
-- 202607301600 já tiver criado a tabela

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM type_attributes ta
JOIN product_types pt ON pt.id = ta.product_type_id
JOIN variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'sex_shop' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=false, active=true

SELECT vv.value, vv.slug, vv.sku_code
FROM variation_values vv
JOIN variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo' AND vv.sku_code >= '06'
ORDER BY vv.sku_code;
-- Esperado: 9 linhas, sku_code 06-14

-- Confirma que nenhum sku_code colide dentro do atributo Modelo inteiro
-- (Calcinha + Sex Shop juntos)
SELECT sku_code, count(*)
FROM variation_values vv
JOIN variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
