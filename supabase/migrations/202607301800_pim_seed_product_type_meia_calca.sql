-- =============================================================================
-- 202607301800_pim_seed_product_type_meia_calca.sql
--
-- Amplia o PIM dinâmico (Fase G/H) com um novo Tipo: Meia-calça. Segue o
-- mesmo padrão já usado para Calcinha (202607301300) e Sex Shop
-- (202607301400): Tipo próprio + vínculo ao atributo global Modelo via
-- type_attributes, governado por value_governance='type_restricted' em
-- variation_types (já setado globalmente desde 202607301600 — não é
-- alterado aqui, só confirmado no smoke test).
--
-- CORREÇÃO EM RELAÇÃO À VERSÃO ANTERIOR: sku_code deixou de ser calculado
-- em runtime (MAX(sku_code)+1) — migrations precisam ser determinísticas
-- entre ambientes. sku_code='17' é explícito, com validação prévia que
-- interrompe a migration (RAISE EXCEPTION) se esse código já pertencer a
-- outro Tipo da mesma empresa.
--
-- DECISÃO CONFIRMADA COM O USUÁRIO sobre o valor "Modeladora": Cinta
-- (202607301900) já cadastra "Modeladora" com sku_code='16'. Como
-- variation_values é compartilhado por todo o atributo Modelo (um mesmo
-- slug só pode ter um sku_code — UNIQUE(variation_type_id, slug)), Meia-
-- calça REAPROVEITA a mesma linha "Modeladora" (sku_code='16'), em vez de
-- criar um valor novo com código 23. Por isso o INSERT de variation_values
-- abaixo repete a definição exata de "Modeladora" já usada em 202607301900
-- (mesmo slug/sku_code) — idempotente e correto rodando em qualquer ordem
-- em relação à migration de Cinta. O código '23' fica intencionalmente sem
-- uso (não é reatribuído a nenhum outro valor).
--
-- O QUE FAZ:
--   1. Valida que sku_code='17' não pertence a outro Tipo da empresa;
--      interrompe com mensagem clara se pertencer. Insere product_types
--      'meia_calca' com sku_code='17' fixo.
--   2. Vincula Meia-calça ao atributo Modelo em type_attributes,
--      required=true, active=true.
--   3. Cria os 6 valores de Modelo de Meia-calça (5 novos + reaproveita
--      "Modeladora" já usado por Cinta) e vincula todos exclusivamente a
--      Meia-calça em type_attribute_values.
--
-- O QUE NÃO FAZ:
--   - Não altera variation_types.value_governance — já é 'type_restricted'
--     desde 202607301600; esta migration só confirma isso via smoke test.
--   - Não altera nenhum produto existente, nenhuma categoria, nenhum outro
--     Tipo.
--   - Não reatribui sku_code='16' de "Modeladora" — reaproveita como está.
--
-- IDEMPOTENTE: ON CONFLICT DO NOTHING/DO UPDATE em toda inserção.
-- =============================================================================

-- PARTE 1 — product_types 'meia_calca', sku_code='17' fixo, com validação
-- prévia de colisão com outro Tipo
DO $$
DECLARE
  conflicting_slug TEXT;
BEGIN
  SELECT slug INTO conflicting_slug
  FROM public.product_types
  WHERE company_id = 1 AND sku_code = '17' AND slug <> 'meia_calca';

  IF conflicting_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'sku_code ''17'' já está em uso pelo product_type ''%'' (company_id=1). Escolha outro código para Meia-calça antes de aplicar esta migration.',
      conflicting_slug;
  END IF;

  INSERT INTO public.product_types (company_id, name, slug, sku_code, active)
  VALUES (1, 'Meia-calça', 'meia_calca', '17', true)
  ON CONFLICT (company_id, slug) DO NOTHING;
END $$;

-- PARTE 2 — Vínculo Meia-calça <-> Modelo (required=true)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'meia_calca'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 3 — Valores de Modelo de Meia-calça: 5 novos (20,21,22,24,25) +
-- reaproveita "Modeladora" (16, já existente/definido também em
-- 202607301900) — mesma definição exata nas duas migrations, idempotente
-- em qualquer ordem de aplicação.
WITH modelo_type AS (
  SELECT id FROM public.variation_types WHERE slug = 'modelo'
)
INSERT INTO public.variation_values (
  variation_type_id, value, slug, active, normalized_name, sku_code
)
SELECT modelo_type.id, v.value, v.slug, true, v.normalized_name, v.sku_code
FROM modelo_type, (VALUES
  ('Fina',        'fina',        'fina',        '20'),
  ('Arrastão',    'arrastao',    'arrastao',    '21'),
  ('Térmica',     'termica',     'termica',     '22'),
  ('Modeladora',  'modeladora',  'modeladora',  '16'), -- reaproveitado de Cinta, não é '23'
  ('Compressão',  'compressao',  'compressao',  '24'),
  ('Sem Pé',      'sem-pe',      'sem_pe',      '25')
) AS v(value, slug, normalized_name, sku_code)
ON CONFLICT (variation_type_id, slug) DO UPDATE
  SET value           = EXCLUDED.value,
      normalized_name = EXCLUDED.normalized_name,
      sku_code        = EXCLUDED.sku_code,
      active          = true;

-- PARTE 4 — Governança de VALOR: os 6 valores acima ficam vinculados ao
-- Tipo Meia-calça (nenhum outro Tipo enxerga esses valores, exceto
-- "Modeladora", que Cinta também enxerga por vínculo próprio em
-- 202607301900 — o mesmo valor, dois Tipos, cada um com seu próprio
-- vínculo em type_attribute_values)
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'meia_calca'
  AND vv.slug IN ('fina', 'arrastao', 'termica', 'modeladora', 'compressao', 'sem-pe')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Meia-calça usa product_type.sku_code 17
SELECT slug, sku_code, active FROM public.product_types
WHERE company_id = 1 AND slug = 'meia_calca';
-- Esperado: 1 linha, sku_code = '17'

SELECT sku_code, count(*) FROM public.product_types
WHERE company_id = 1
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas (nenhum sku_code de Tipo duplicado)

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
JOIN public.variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'meia_calca' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=true, active=true

SELECT value_governance FROM public.variation_types WHERE slug = 'modelo';
-- Esperado: 'type_restricted'

-- Meia-calça tem exatamente 6 modelos vinculados
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'meia_calca';
-- Esperado: 6

SELECT vv.value, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'meia_calca'
ORDER BY vv.sku_code;
-- Esperado: 6 linhas (Modeladora=16, Fina=20, Arrastão=21, Térmica=22,
-- Compressão=24, Sem Pé=25)

-- Cinta tem exatamente 5 modelos vinculados (confirmação cruzada,
-- independente da ordem de aplicação com 202607301900)
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'cinta';
-- Esperado: 5 (0 se esta migration rodar antes de 202607301900 — nesse
-- caso, rode 202607301900 em seguida e confira de novo)

-- Cinta continua usando product_type.sku_code 15
SELECT slug, sku_code FROM public.product_types WHERE company_id = 1 AND slug = 'cinta';
-- Esperado: 0 ou 1 linha (1 linha com sku_code='15' se 202607301900 já
-- tiver rodado; 0 linhas se ainda não — nunca sku_code diferente de '15')

-- short_doll continua sem vínculo dinâmico (fluxo legado intocado)
SELECT count(*) FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
WHERE pt.slug = 'short_doll';
-- Esperado: 0

-- Confirma que nenhum sku_code de Modelo colide entre Tipos
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
