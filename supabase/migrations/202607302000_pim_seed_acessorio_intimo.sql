-- =============================================================================
-- 202607302000_pim_seed_acessorio_intimo.sql
--
-- Amplia o PIM dinâmico com o Tipo "Acessório Íntimo", seguindo exatamente
-- a mesma arquitetura já usada para Calcinha/Sex Shop/Meia-calça/Cinta:
-- product_types + type_attributes + variation_values + type_attribute_values.
-- Nenhuma lógica nova em backend/frontend — resolveDynamicModeloContext,
-- /api/produtos/modelo-options e o formulário já são genéricos por slug e
-- passam a reconhecer este Tipo automaticamente assim que esta migration
-- for aplicada.
--
-- CONTEXTO: "Acessório Íntimo" já foi mencionado em sessões anteriores
-- (comentários em 202607301400/202607301500, sobre a categoria "Sutiã
-- Adesivo") mas seu Tipo nunca chegou a ser persistido como migration real
-- neste repositório — por isso esta migration é auto-suficiente (não
-- assume que a linha em product_types já existe).
--
-- O QUE FAZ:
--   1. Valida que sku_code='18' não pertence a outro Tipo da empresa;
--      interrompe com mensagem clara se pertencer. Garante que
--      product_types 'acessorio_intimo' existe: cria com sku_code='18' se
--      a linha não existir; se já existir sem sku_code (decisão antiga de
--      deixar nulo), atribui '18' agora; se já existir com sku_code já
--      definido, não sobrescreve.
--   2. Vincula Acessório Íntimo ao atributo Modelo em type_attributes,
--      required=true, active=true. Não altera
--      variation_types.value_governance (permanece 'type_restricted',
--      setado globalmente desde 202607301600) — só confirma via smoke
--      test.
--   3. Cria (ou reaproveita, se idêntico) os 2 valores de Modelo: "Fita
--      para Seios" (sku_code=26) e "Protetor de Mamilo" (sku_code=27) —
--      cada um validado individualmente ANTES do insert: se o slug já
--      existir com um sku_code diferente do esperado, ou se o sku_code já
--      pertencer a outro slug, a migration para com RAISE EXCEPTION. Não
--      usa ON CONFLICT DO NOTHING para reconciliar silenciosamente — uma
--      inconsistência real precisa ser corrigida manualmente, nunca
--      escondida.
--   4. Vincula os 2 valores exclusivamente ao Tipo Acessório Íntimo em
--      type_attribute_values.
--
-- O QUE NÃO FAZ:
--   - Não cria nem altera nenhuma categoria ("Sutiã Adesivo" continua sem
--     decisão, fora de escopo aqui).
--   - Não altera nenhum produto existente.
--   - Não toca em nenhum outro Tipo, nem no fluxo legado (nenhum Tipo
--     legado tem "Fita para Seios"/"Protetor de Mamilo" no mapa estático
--     SKU_MODELO — não há nada para preservar ali).
--
-- IDEMPOTENTE: seguro pra rodar de novo — se tudo já estiver exatamente
-- como definido aqui, nenhuma parte desta migration produz efeito.
-- =============================================================================

-- PARTE 1 — product_types 'acessorio_intimo', sku_code='18' fixo, com
-- validação prévia de colisão com outro Tipo
DO $$
DECLARE
  conflicting_slug TEXT;
BEGIN
  SELECT slug INTO conflicting_slug
  FROM public.product_types
  WHERE company_id = 1 AND sku_code = '18' AND slug <> 'acessorio_intimo';

  IF conflicting_slug IS NOT NULL THEN
    RAISE EXCEPTION
      'sku_code ''18'' já está em uso pelo product_type ''%'' (company_id=1). Escolha outro código para Acessório Íntimo antes de aplicar esta migration.',
      conflicting_slug;
  END IF;

  INSERT INTO public.product_types (company_id, name, slug, sku_code, active)
  VALUES (1, 'Acessório Íntimo', 'acessorio_intimo', '18', true)
  ON CONFLICT (company_id, slug) DO NOTHING;

  -- Se a linha já existia sem sku_code (decisão antiga de deixar nulo),
  -- atribui agora. Nunca sobrescreve um sku_code já definido.
  UPDATE public.product_types
  SET sku_code = '18'
  WHERE company_id = 1 AND slug = 'acessorio_intimo' AND sku_code IS NULL;
END $$;

-- PARTE 2 — Vínculo Acessório Íntimo <-> Modelo (required=true, active=true)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'acessorio_intimo'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 3 — Valores de Modelo "Fita para Seios" (26) e "Protetor de
-- Mamilo" (27), validados individualmente antes de inserir: nenhuma
-- inconsistência de slug/sku_code é reconciliada silenciosamente.
DO $$
DECLARE
  modelo_type_id  INT;
  rec             RECORD;
  existing_sku    TEXT;
  existing_slug   TEXT;
BEGIN
  SELECT id INTO modelo_type_id FROM public.variation_types WHERE slug = 'modelo';

  IF modelo_type_id IS NULL THEN
    RAISE EXCEPTION 'variation_types com slug ''modelo'' não encontrado — rode 202607301300_pim_seed_modelo_calcinha.sql antes desta migration.';
  END IF;

  FOR rec IN
    SELECT * FROM (VALUES
      ('Fita para Seios',    'fita-para-seios',    'fita_para_seios',    '26'),
      ('Protetor de Mamilo', 'protetor-de-mamilo', 'protetor_de_mamilo', '27')
    ) AS v(value, slug, normalized_name, sku_code)
  LOOP
    -- Este slug já existe com um sku_code diferente do esperado?
    SELECT sku_code INTO existing_sku
    FROM public.variation_values
    WHERE variation_type_id = modelo_type_id AND slug = rec.slug;

    IF existing_sku IS NOT NULL AND existing_sku <> rec.sku_code THEN
      RAISE EXCEPTION
        'variation_value com slug ''%'' já existe com sku_code ''%'', diferente do esperado ''%''. Corrija manualmente (dado real diverge do solicitado) antes de aplicar esta migration.',
        rec.slug, existing_sku, rec.sku_code;
    END IF;

    -- Este sku_code já pertence a um slug diferente do esperado?
    SELECT slug INTO existing_slug
    FROM public.variation_values
    WHERE variation_type_id = modelo_type_id AND sku_code = rec.sku_code AND slug <> rec.slug;

    IF existing_slug IS NOT NULL THEN
      RAISE EXCEPTION
        'sku_code ''%'' do atributo Modelo já está em uso pelo valor de slug ''%'', diferente do esperado ''%''. Escolha outro código antes de aplicar esta migration.',
        rec.sku_code, existing_slug, rec.slug;
    END IF;

    -- Nenhuma inconsistência encontrada: cria só se ainda não existir
    -- (slug+sku_code já batendo exatamente = reaproveita, sem no-op extra)
    INSERT INTO public.variation_values (
      variation_type_id, value, slug, active, normalized_name, sku_code
    )
    SELECT modelo_type_id, rec.value, rec.slug, true, rec.normalized_name, rec.sku_code
    WHERE NOT EXISTS (
      SELECT 1 FROM public.variation_values
      WHERE variation_type_id = modelo_type_id AND slug = rec.slug
    );
  END LOOP;
END $$;

-- PARTE 4 — Governança de VALOR: os 2 valores acima ficam vinculados
-- exclusivamente ao Tipo Acessório Íntimo
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'acessorio_intimo'
  AND vv.slug IN ('fita-para-seios', 'protetor-de-mamilo')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- sku_code do Product Type é 18
SELECT slug, sku_code, active FROM public.product_types
WHERE company_id = 1 AND slug = 'acessorio_intimo';
-- Esperado: 1 linha, sku_code = '18'

SELECT sku_code, count(*) FROM public.product_types
WHERE company_id = 1
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas (nenhum sku_code de Tipo duplicado)

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
JOIN public.variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'acessorio_intimo' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=true, active=true

SELECT value_governance FROM public.variation_types WHERE slug = 'modelo';
-- Esperado: 'type_restricted' (não alterado por esta migration)

-- Acessório Íntimo possui exatamente 2 Modelos vinculados
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'acessorio_intimo';
-- Esperado: 2

-- Fita para Seios possui sku_code 26 / Protetor de Mamilo possui sku_code 27
SELECT vv.value, vv.slug, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'acessorio_intimo'
ORDER BY vv.sku_code;
-- Esperado: 2 linhas — ('Fita para Seios','fita-para-seios','26'),
-- ('Protetor de Mamilo','protetor-de-mamilo','27')

-- Os 2 valores pertencem EXCLUSIVAMENTE ao Tipo Acessório Íntimo (nenhum
-- outro Tipo tem vínculo com eles em type_attribute_values)
SELECT vv.slug, count(DISTINCT tav.product_type_id) AS tipos_vinculados
FROM public.variation_values vv
JOIN public.type_attribute_values tav ON tav.variation_value_id = vv.id
WHERE vv.slug IN ('fita-para-seios', 'protetor-de-mamilo')
GROUP BY vv.slug;
-- Esperado: 2 linhas, tipos_vinculados = 1 em ambas

-- Confirma que nenhum sku_code de Modelo colide entre Tipos (Calcinha +
-- Sex Shop + Cinta + Meia-calça + Acessório Íntimo juntos)
SELECT sku_code, count(*)
FROM public.variation_values vv
JOIN public.variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- Fluxo legado intocado: nenhum Tipo legado (incluindo short_doll) ganhou
-- vínculo dinâmico por esta migration
SELECT count(*) FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
WHERE pt.slug = 'short_doll';
-- Esperado: 0

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
