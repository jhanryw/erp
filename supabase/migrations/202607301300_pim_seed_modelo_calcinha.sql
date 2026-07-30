-- =============================================================================
-- 202607301300_pim_seed_modelo_calcinha.sql
--
-- Fase E mínima da especificação v2.2 — cria o atributo "Modelo" (só o
-- necessário para Calcinha nesta etapa acelerada) e vincula ao Tipo
-- Calcinha via type_attributes.
--
-- ATUALIZADO (202607301600): adiciona PARTE 4, vinculando os 5 valores de
-- Modelo ao Tipo Calcinha em type_attribute_values — corrige o gap de
-- governança encontrado em teste real (o endpoint enxergava também os
-- valores de Sex Shop, já que os dois Tipos compartilham o mesmo atributo
-- Modelo). Depende de 202607301600 já ter rodado (cria a tabela). Se este
-- arquivo já tinha sido aplicado antes desta atualização, rode de novo —
-- é idempotente, as PARTEs 1-3 não fazem nada novo, só a PARTE 4 é nova.
--
-- O QUE FAZ:
--   1. Cria variation_types "Modelo" (slug 'modelo'): kind=descriptive,
--      include_in_sku=true, data_type=select, cardinality=single.
--      value_governance é gravado como 'unrestricted' aqui só pra não
--      sobrescrever um valor diferente se este INSERT nunca tiver rodado
--      antes — 202607301600 é quem efetivamente ativa 'type_restricted'.
--   2. Cria os 5 valores de Modelo necessários pra Calcinha (Fio, Tanga,
--      Boxer, Caleçon, Cintura Alta), cada um com sku_code de 2 dígitos
--      exclusivo dentro do atributo Modelo (01-05) — mesmo padrão que
--      variation_values já usa pra cor/tamanho.
--   3. Vincula Calcinha <-> Modelo em type_attributes (required=true,
--      active=true).
--   4. Vincula cada um dos 5 valores ao Tipo Calcinha em
--      type_attribute_values — é isso que restringe o select de Modelo,
--      pro Tipo Calcinha, a mostrar só esses 5 valores.
--
-- O QUE NÃO FAZ:
--   - Não cria Modelo de nenhum outro Tipo (Sutiã, Sex Shop, etc.).
--   - Não cria category_attribute_values.
--   - Não altera nenhuma API, formulário ou geração de SKU.
--   - Não altera nenhum produto existente.
--
-- IDEMPOTENTE: ON CONFLICT DO UPDATE em todas as inserções — seguro pra
-- reexecutar.
-- =============================================================================

-- PARTE 1 — Atributo Modelo
INSERT INTO public.variation_types (
  name, slug, active, kind, include_in_sku, data_type, cardinality, value_governance
) VALUES (
  'Modelo', 'modelo', true, 'descriptive', true, 'select', 'single', 'unrestricted'
)
ON CONFLICT (slug) DO UPDATE
  SET name             = EXCLUDED.name,
      active           = EXCLUDED.active,
      kind             = EXCLUDED.kind,
      include_in_sku   = EXCLUDED.include_in_sku,
      data_type        = EXCLUDED.data_type,
      cardinality      = EXCLUDED.cardinality,
      value_governance = EXCLUDED.value_governance;

-- PARTE 2 — Valores de Modelo necessários pra Calcinha
WITH modelo_type AS (
  SELECT id FROM public.variation_types WHERE slug = 'modelo'
)
INSERT INTO public.variation_values (
  variation_type_id, value, slug, active, normalized_name, sku_code
)
SELECT modelo_type.id, v.value, v.slug, true, v.normalized_name, v.sku_code
FROM modelo_type, (VALUES
  ('Fio',          'fio',          'fio',          '01'),
  ('Tanga',        'tanga',        'tanga',        '02'),
  ('Boxer',        'boxer',        'boxer',        '03'),
  ('Caleçon',      'calecon',      'calecon',      '04'),
  ('Cintura Alta', 'cintura-alta', 'cintura_alta', '05')
) AS v(value, slug, normalized_name, sku_code)
ON CONFLICT (variation_type_id, slug) DO UPDATE
  SET value           = EXCLUDED.value,
      normalized_name = EXCLUDED.normalized_name,
      sku_code        = EXCLUDED.sku_code,
      active          = true;

-- PARTE 3 — Vínculo Calcinha <-> Modelo (governança do atributo)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'calcinha'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 4 — Governança de VALOR: só estes 5 valores ficam visíveis pro
-- Tipo Calcinha (corrige o vazamento cross-Tipo encontrado em teste real)
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'calcinha'
  AND vv.slug IN ('fio', 'tanga', 'boxer', 'calecon', 'cintura-alta')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT slug, kind, include_in_sku, data_type, cardinality, value_governance
FROM variation_types WHERE slug = 'modelo';
-- Esperado: 1 linha, kind=descriptive, include_in_sku=true, data_type=select,
-- cardinality=single, value_governance='type_restricted' (só depois que
-- 202607301600 rodar — antes disso, 'unrestricted')

SELECT vv.value, vv.sku_code
FROM type_attribute_values tav
JOIN product_types pt ON pt.id = tav.product_type_id
JOIN variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'calcinha'
ORDER BY vv.sku_code;
-- Esperado: 5 linhas (Fio, Tanga, Boxer, Caleçon, Cintura Alta) — só depois
-- que 202607301600 já tiver criado a tabela

SELECT vv.value, vv.slug, vv.normalized_name, vv.sku_code
FROM variation_values vv
JOIN variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
ORDER BY vv.sku_code;
-- Esperado: 5 linhas (Fio/01, Tanga/02, Boxer/03, Caleçon/04, Cintura Alta/05)

SELECT count(*) FROM variation_values vv
JOIN variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY vv.sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas (nenhum sku_code duplicado dentro do atributo Modelo)

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM type_attributes ta
JOIN product_types pt ON pt.id = ta.product_type_id
JOIN variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'calcinha' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=true, active=true

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
