-- =============================================================================
-- 202607302500_pim_seed_modelo_conjunto_e_short.sql
--
-- Corrige dois gaps de configuração do PIM encontrados via importação CSV
-- real: "Conjunto" (product_types.id=14, slug 'conjunto_calcinha_sutia') e
-- "Short Doll" (product_types.id=9, slug 'short_doll') existem no PIM mas
-- nunca ganharam vínculo ativo com o atributo Modelo (variation_types.id=5,
-- slug 'modelo') — por isso o importador (corretamente) rejeitava qualquer
-- CSV desses dois Tipos com "Modelo não está vinculado ao Tipo no PIM".
--
-- Fonte dos valores de Modelo: confirmado com o usuário que o formulário
-- /produtos/novo é a base usada pra preencher os CSVs — pra Tipos ainda não
-- governados (como eram Conjunto e Short até esta migration), esse
-- formulário usa o mapa estático legado SKU_MODELO (src/lib/sku/sku-map.ts).
-- Os valores abaixo são exatamente SKU_MODELO['09'] (Short Doll) e
-- SKU_MODELO['14'] (Conjunto Calcinha + Sutiã) — nenhum valor inventado.
--
-- DECISÃO CONFIRMADA COM O USUÁRIO (reaproveitamento): "Básico com Bojo",
-- "Básico sem Bojo" (Conjunto) e "Renda" (Short) já existem como
-- variation_values de Sutiã (202607302300_pim_seed_modelo_sutia_silicone.sql,
-- sku_code 35/36/37) — mesmo texto, mesmo conceito. Em vez de duplicar,
-- estes 3 são REAPROVEITADOS (mesma linha, mesmo sku_code, só um novo
-- vínculo em type_attribute_values) — mesma decisão já tomada para
-- "Modeladora" entre Cinta e Meia-calça nesta sessão. Os outros 5 valores
-- (Renda Sem Bojo, Renda Com Bojo, Bustiê Cropped Renda, Conjunto com
-- Calcinha Fio Dental, e o "Básico" avulso de Short — distinto de "Básico
-- com/sem Bojo", texto diferente) são novos, sku_code 42-46.
--
-- NÃO MEXE em "Ponto G" (variation_value_id=110): confirmado com o usuário
-- que a desativação em 202607302100_pim_extend_modelo_sex_shop.sql foi
-- deliberada (Vibrador é a categoria correta) e deve permanecer — o ponto
-- 3 do relatório do usuário é só contexto confirmando que o importador
-- rejeita esse caso corretamente, não um pedido de reativação. Smoke test
-- no final confirma que nada mudou nele.
--
-- O QUE FAZ:
--   1. Valida (RAISE EXCEPTION se não bater) que product_types
--      'conjunto_calcinha_sutia'=14, 'short_doll'=9 e variation_types
--      'modelo'=5 realmente existem com os IDs relatados — nunca assume
--      cegamente.
--   2. Cria type_attributes: Conjunto<->Modelo e Short<->Modelo, ambos
--      required=true (Modelo sempre foi obrigatório pra esses Tipos no
--      caminho legado — mesma regra herdada, não uma decisão nova) e
--      active=true.
--   3. Cria os 5 valores de Modelo novos (validados individualmente antes
--      do insert — nenhuma inconsistência de slug/sku_code é reconciliada
--      silenciosamente, mesmo padrão de 202607302000/202607302100).
--   4. Vincula os 6 modelos de Conjunto e os 2 de Short em
--      type_attribute_values (3 desses 8 vínculos apontam pra linhas
--      reaproveitadas de Sutiã).
--
-- O QUE NÃO FAZ:
--   - Não cria nenhum Product Type novo.
--   - Não toca em Ponto G nem em nenhum outro Tipo/valor já configurado.
--   - Não altera nenhum produto existente.
--   - Não faz DELETE em lugar nenhum.
--   - Não flexibiliza nem remove nenhuma validação do importador — só
--     preenche a configuração que faltava pra ele aceitar Conjunto/Short.
--
-- IDEMPOTENTE: seguro pra rodar de novo — se tudo já estiver exatamente
-- como definido aqui, nenhuma parte desta migration produz efeito.
-- =============================================================================

-- PARTE 0 — Confirma os IDs relatados antes de qualquer alteração
DO $$
DECLARE
  v_conjunto_id INT;
  v_short_id    INT;
  v_modelo_id   INT;
BEGIN
  SELECT id INTO v_conjunto_id FROM public.product_types WHERE slug = 'conjunto_calcinha_sutia';
  IF v_conjunto_id IS NULL THEN
    RAISE EXCEPTION 'product_type ''conjunto_calcinha_sutia'' não encontrado.';
  END IF;
  IF v_conjunto_id <> 14 THEN
    RAISE EXCEPTION
      'product_type ''conjunto_calcinha_sutia'' tem id=%, mas o relatado era 14. Confirme antes de aplicar esta migration.',
      v_conjunto_id;
  END IF;

  SELECT id INTO v_short_id FROM public.product_types WHERE slug = 'short_doll';
  IF v_short_id IS NULL THEN
    RAISE EXCEPTION 'product_type ''short_doll'' não encontrado.';
  END IF;
  IF v_short_id <> 9 THEN
    RAISE EXCEPTION
      'product_type ''short_doll'' tem id=%, mas o relatado era 9. Confirme antes de aplicar esta migration.',
      v_short_id;
  END IF;

  SELECT id INTO v_modelo_id FROM public.variation_types WHERE slug = 'modelo';
  IF v_modelo_id IS NULL THEN
    RAISE EXCEPTION 'variation_type ''modelo'' não encontrado.';
  END IF;
  IF v_modelo_id <> 5 THEN
    RAISE EXCEPTION
      'variation_type ''modelo'' tem id=%, mas o relatado era 5. Confirme antes de aplicar esta migration.',
      v_modelo_id;
  END IF;
END $$;

-- PARTE 1 — Vínculo Conjunto <-> Modelo e Short <-> Modelo (required=true,
-- herdado do caminho legado onde Modelo sempre foi obrigatório)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.slug = 'conjunto_calcinha_sutia' AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.slug = 'short_doll' AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 2 — Valores de Modelo novos (5), validados individualmente antes
-- de inserir: nenhuma inconsistência de slug/sku_code é reconciliada
-- silenciosamente. "Básico com Bojo", "Básico sem Bojo" e "Renda" NÃO
-- aparecem aqui — já existem (Sutiã) e são só vinculados na PARTE 3.
DO $$
DECLARE
  modelo_type_id  INT;
  rec             RECORD;
  existing_sku    TEXT;
  existing_slug   TEXT;
BEGIN
  SELECT id INTO modelo_type_id FROM public.variation_types WHERE slug = 'modelo';

  FOR rec IN
    SELECT * FROM (VALUES
      ('Renda Sem Bojo',                   'renda-sem-bojo',                   'renda_sem_bojo',                   '42'),
      ('Renda Com Bojo',                   'renda-com-bojo',                   'renda_com_bojo',                   '43'),
      ('Bustiê Cropped Renda',             'bustie-cropped-renda',             'bustie_cropped_renda',             '44'),
      ('Conjunto com Calcinha Fio Dental', 'conjunto-com-calcinha-fio-dental', 'conjunto_com_calcinha_fio_dental', '45'),
      ('Básico',                           'basico',                           'basico',                           '46')
    ) AS v(value, slug, normalized_name, sku_code)
  LOOP
    SELECT sku_code INTO existing_sku
    FROM public.variation_values
    WHERE variation_type_id = modelo_type_id AND slug = rec.slug;

    IF existing_sku IS NOT NULL AND existing_sku <> rec.sku_code THEN
      RAISE EXCEPTION
        'variation_value com slug ''%'' já existe com sku_code ''%'', diferente do esperado ''%''. Corrija manualmente antes de aplicar esta migration.',
        rec.slug, existing_sku, rec.sku_code;
    END IF;

    SELECT slug INTO existing_slug
    FROM public.variation_values
    WHERE variation_type_id = modelo_type_id AND sku_code = rec.sku_code AND slug <> rec.slug;

    IF existing_slug IS NOT NULL THEN
      RAISE EXCEPTION
        'sku_code ''%'' do atributo Modelo já está em uso pelo valor de slug ''%'', diferente do esperado ''%''. Escolha outro código antes de aplicar esta migration.',
        rec.sku_code, existing_slug, rec.slug;
    END IF;

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

-- PARTE 3 — Governança de VALOR: Conjunto (6 modelos: 2 reaproveitados de
-- Sutiã + 4 novos) e Short (2 modelos: 1 reaproveitado de Sutiã + 1 novo)
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.slug = 'conjunto_calcinha_sutia'
  AND vv.slug IN (
    'basico-com-bojo', 'basico-sem-bojo',
    'renda-sem-bojo', 'renda-com-bojo',
    'bustie-cropped-renda', 'conjunto-com-calcinha-fio-dental'
  )
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.slug = 'short_doll'
  AND vv.slug IN ('basico', 'renda')
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Conjunto tem exatamente 6 modelos vinculados
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'conjunto_calcinha_sutia' AND tav.active = true;
-- Esperado: 6

SELECT vv.value, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'conjunto_calcinha_sutia' AND tav.active = true
ORDER BY vv.sku_code;
-- Esperado: 6 linhas — Básico com Bojo(35), Básico sem Bojo(36),
-- Renda Sem Bojo(42), Renda Com Bojo(43), Bustiê Cropped Renda(44),
-- Conjunto com Calcinha Fio Dental(45)

-- Short tem exatamente 2 modelos vinculados
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'short_doll' AND tav.active = true;
-- Esperado: 2

SELECT vv.value, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'short_doll' AND tav.active = true
ORDER BY vv.sku_code;
-- Esperado: 2 linhas — Básico(46), Renda(37)

-- Valores reaproveitados de Sutiã agora aparecem em mais de um Tipo
SELECT vv.slug, count(DISTINCT tav.product_type_id) AS tipos_vinculados
FROM public.variation_values vv
JOIN public.type_attribute_values tav ON tav.variation_value_id = vv.id AND tav.active = true
WHERE vv.slug IN ('basico-com-bojo', 'basico-sem-bojo', 'renda')
GROUP BY vv.slug;
-- Esperado: 3 linhas, tipos_vinculados = 2 em todas (Sutiã + Conjunto, ou Sutiã + Short)

SELECT pt.slug AS tipo, ta.required, ta.active
FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
JOIN public.variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug IN ('conjunto_calcinha_sutia', 'short_doll') AND vt.slug = 'modelo'
ORDER BY pt.slug;
-- Esperado: 2 linhas, required=true e active=true nas duas

-- Confirma que nenhum sku_code de Modelo colide entre Tipos
SELECT sku_code, count(*)
FROM public.variation_values vv
JOIN public.variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- Confirma que Ponto G NÃO foi tocado por esta migration (continua
-- desativado, decisão anterior preservada)
SELECT vv.active AS valor_ativo, tav.active AS vinculo_ativo
FROM public.variation_values vv
LEFT JOIN public.type_attribute_values tav ON tav.variation_value_id = vv.id
WHERE vv.id = 110;
-- Esperado: 1 linha (ou mais, se houver múltiplos vínculos), valor_ativo=false,
-- vinculo_ativo=false em todas

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
