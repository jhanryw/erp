-- =============================================================================
-- 202607301900_pim_seed_modelo_cinta_short.sql
--
-- Cadastro do produto "Short Cinta": não cria Tipo novo nem reaproveita
-- short_doll — usa Tipo=Cinta (já existente, sku_code legado '15') com um
-- novo Modelo "Short" governado via type_attribute_values, mesmo padrão de
-- Calcinha/Sex Shop/Meia-calça.
--
-- DECISÃO CONFIRMADA COM O USUÁRIO: vincular Cinta ao atributo Modelo troca
-- o select de Modelo de Cinta, no formulário, do mapa estático legado
-- (SKU_MODELO['15']: Liga, Modeladora, Body Modelador, Regata Modeladora)
-- para a lista dinâmica em type_attribute_values — não é possível os dois
-- caminhos coexistirem para o mesmo Tipo (resolveDynamicModeloContext é um
-- interruptor por Tipo, não por valor). Por isso os 4 modelos legados de
-- Cinta são migrados para variation_values nesta mesma migration, junto
-- com Short — nenhum modelo de Cinta deixa de poder ser escolhido em
-- produtos novos.
--
-- DECISÃO CONFIRMADA COM O USUÁRIO sobre "Modeladora": Meia-calça
-- (202607301800) também usa um valor "Modeladora". Como variation_values é
-- compartilhado por todo o atributo Modelo (um mesmo slug só pode ter um
-- sku_code), Meia-calça REAPROVEITA esta mesma linha (sku_code='16'), em
-- vez de criar um valor novo com código 23. O INSERT abaixo define
-- "Modeladora" com a mesma forma exata usada em 202607301800 —
-- idempotente e correto rodando em qualquer ordem em relação a essa
-- migration.
--
-- O QUE FAZ:
--   0. Garante que product_types 'cinta' existe (self-sufficient, mesmo
--      padrão do PARTE -1 de 202607301400 para Sex Shop) — não depende de
--      202607301700 (backfill dos Tipos legados) já ter rodado. sku_code
--      '15' é o mesmo já usado no mapa estático SKU_TIPO — nunca muda.
--   1. Vincula Cinta ao atributo Modelo em type_attributes, required=true
--      (Modelo já era obrigatório para Cinta no caminho legado).
--   2. Cria 5 valores de Modelo sob o atributo global "Modelo": os 4
--      legados de Cinta (Liga, Modeladora, Body Modelador, Regata
--      Modeladora) + Short (novo). sku_code sequencial 15-19, continuando
--      do topo já usado por Sex Shop (14) — nunca colide com Calcinha
--      (01-05) nem Sex Shop (06-14).
--   3. Vincula os 5 valores ao Tipo Cinta em type_attribute_values.
--
-- O QUE NÃO FAZ:
--   - Não altera nenhum produto existente de Cinta — sku_scheme desses
--     produtos continua 'legacy', SKU já emitido nunca é recalculado.
--   - Não cria Tipo short_doll novo nem toca em type_attributes/
--     variation_values dele — Short Doll continua 100% pelo caminho legado
--     (SKU_TIPO/SKU_MODELO), sem nenhum vínculo em type_attributes (smoke
--     test confirma 0 linhas).
--   - Não altera categories nem cria categoria nova.
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING/DO UPDATE em toda inserção.
-- =============================================================================

-- PARTE -1 — Garante que o Tipo Cinta existe (auto-suficiente)
INSERT INTO public.product_types (company_id, name, slug, sku_code, active)
VALUES (1, 'Cinta', 'cinta', '15', true)
ON CONFLICT (company_id, slug) DO NOTHING;

-- PARTE 1 — Vínculo Cinta <-> Modelo (required=true, mesma obrigatoriedade
-- que já existia no caminho legado)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'cinta'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 2 — Valores de Modelo de Cinta (4 legados + Short), sku_code 15-19.
-- "Modeladora" (16) é definida com a mesma forma exata usada em
-- 202607301800 (Meia-calça reaproveita esta linha) — idempotente em
-- qualquer ordem de aplicação entre as duas migrations.
WITH modelo_type AS (
  SELECT id FROM public.variation_types WHERE slug = 'modelo'
)
INSERT INTO public.variation_values (
  variation_type_id, value, slug, active, normalized_name, sku_code
)
SELECT modelo_type.id, v.value, v.slug, true, v.normalized_name, v.sku_code
FROM modelo_type, (VALUES
  ('Liga',              'liga',              'liga',              '15'),
  ('Modeladora',        'modeladora',        'modeladora',        '16'),
  ('Body Modelador',    'body-modelador',    'body_modelador',    '17'),
  ('Regata Modeladora', 'regata-modeladora', 'regata_modeladora', '18'),
  ('Short',             'short',             'short',             '19')
) AS v(value, slug, normalized_name, sku_code)
ON CONFLICT (variation_type_id, slug) DO UPDATE
  SET value           = EXCLUDED.value,
      normalized_name = EXCLUDED.normalized_name,
      sku_code        = EXCLUDED.sku_code,
      active          = true;

-- PARTE 3 — Governança de VALOR: os 5 valores acima ficam vinculados ao
-- Tipo Cinta (nenhum outro Tipo enxerga esses valores, exceto
-- "Modeladora", que Meia-calça também enxerga por vínculo próprio em
-- 202607301800 — o mesmo valor, dois Tipos, cada um com seu próprio
-- vínculo em type_attribute_values)
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'cinta'
  AND vv.slug IN ('liga', 'modeladora', 'body-modelador', 'regata-modeladora', 'short')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Cinta continua usando product_type.sku_code 15
SELECT slug, sku_code FROM public.product_types WHERE company_id = 1 AND slug = 'cinta';
-- Esperado: 1 linha, sku_code = '15' (inalterado em relação ao mapa legado)

-- Cinta tem exatamente 5 modelos vinculados
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'cinta';
-- Esperado: 5

SELECT vv.value, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'cinta'
ORDER BY vv.sku_code;
-- Esperado: 5 linhas (Liga=15, Modeladora=16, Body Modelador=17, Regata
-- Modeladora=18, Short=19)

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
JOIN public.variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'cinta' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=true, active=true

-- Meia-calça usa product_type.sku_code 17 (confirmação cruzada,
-- independente da ordem de aplicação com 202607301800)
SELECT slug, sku_code FROM public.product_types WHERE company_id = 1 AND slug = 'meia_calca';
-- Esperado: 0 ou 1 linha (1 linha com sku_code='17' se 202607301800 já
-- tiver rodado; 0 linhas se ainda não)

-- Meia-calça tem exatamente 6 modelos vinculados (idem, cruzada)
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'meia_calca';
-- Esperado: 6 (0 se 202607301800 ainda não tiver rodado)

-- short_doll continua sem vínculo dinâmico (fluxo legado intocado)
SELECT count(*) FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
WHERE pt.slug = 'short_doll';
-- Esperado: 0

-- Confirma que nenhum sku_code de Modelo colide entre Tipos (Calcinha +
-- Sex Shop + Cinta + Meia-calça juntos)
SELECT sku_code, count(*)
FROM public.variation_values vv
JOIN public.variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
