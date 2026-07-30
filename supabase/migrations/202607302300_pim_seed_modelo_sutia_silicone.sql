-- =============================================================================
-- 202607302300_pim_seed_modelo_sutia_silicone.sql
--
-- Adiciona o Modelo "Silicone" ao Tipo Sutiã (já existente), seguindo
-- exatamente a mesma arquitetura já usada em Calcinha/Sex Shop/Cinta/Meia-
-- calça/Acessório Íntimo: product_types + type_attributes + variation_values
-- + type_attribute_values. Não cria Product Type novo, não altera nenhum
-- arquivo TypeScript — resolveDynamicModeloContext, /api/produtos/
-- modelo-options e o formulário já são genéricos por slug e passam a
-- reconhecer Sutiã automaticamente assim que esta migration for aplicada.
--
-- DECISÃO CONFIRMADA COM O USUÁRIO: vincular Sutiã ao atributo Modelo (via
-- type_attributes) é necessário para "Silicone" funcionar de verdade —
-- sem esse vínculo, resolveDynamicModeloContext nunca ativa o caminho
-- dinâmico para Sutiã. Mas esse vínculo é um interruptor por Tipo, não por
-- valor: assim que existir, o formulário abandona o mapa estático legado
-- inteiro (SKU_MODELO['01']: Básico com Bojo, Básico sem Bojo, Renda, Top,
-- Com Aro, Sem Aro) para esse Tipo. Por isso os 6 modelos legados de Sutiã
-- são migrados para variation_values nesta mesma migration, junto com
-- Silicone — nenhum modelo de Sutiã deixa de poder ser escolhido em
-- produtos novos (mesma decisão já tomada para Cinta em
-- 202607301900_pim_seed_modelo_cinta_short.sql).
--
-- O QUE FAZ:
--   1. Confirma que o Tipo 'sutia' já existe (interrompe com erro claro se
--      não existir — esta migration nunca cria um Product Type novo).
--   2. Vincula Sutiã ao atributo Modelo em type_attributes, required=true
--      (Modelo já era obrigatório para Sutiã no caminho legado). Não
--      altera variation_types.value_governance — permanece
--      'type_restricted' (smoke test confirma, não é alterado aqui).
--   3. Cria 7 valores de Modelo sob o atributo global "Modelo": os 6
--      legados de Sutiã + Silicone (novo). sku_code 35-41, próximo bloco
--      disponível na sequência global já usada (Calcinha 01-05, Sex Shop
--      06-14+28-34, Cinta 15-19, Meia-calça 20-22/24-25, Acessório Íntimo
--      26-27) — escolhido de forma determinística (não computado via
--      MAX(sku_code)+1 em runtime, conforme já corrigido antes), e cada
--      valor é validado individualmente ANTES do insert: se o slug já
--      existir com um sku_code diferente do esperado, ou se o sku_code já
--      pertencer a outro slug, a migration para com RAISE EXCEPTION. Não
--      usa ON CONFLICT DO NOTHING para reconciliar silenciosamente.
--   4. Vincula os 7 valores ao Tipo Sutiã em type_attribute_values.
--
-- O QUE NÃO FAZ:
--   - Não cria nenhum Product Type novo.
--   - Não altera nenhum produto existente de Sutiã — sku_scheme desses
--     produtos continua 'legacy', SKU já emitido nunca é recalculado.
--   - Não faz DELETE físico em nenhuma tabela.
--   - Não modifica nenhum arquivo .ts/.tsx.
--
-- IDEMPOTENTE: seguro pra rodar de novo — se tudo já estiver exatamente
-- como definido aqui, nenhuma parte desta migration produz efeito.
-- =============================================================================

-- PARTE 1 — Confirma que o Tipo Sutiã já existe (nunca cria um novo)
DO $$
DECLARE
  sutia_id INT;
BEGIN
  SELECT id INTO sutia_id
  FROM public.product_types
  WHERE company_id = 1 AND slug = 'sutia';

  IF sutia_id IS NULL THEN
    RAISE EXCEPTION
      'product_type ''sutia'' não encontrado para company_id=1. Rode 202607301700_pim_seed_legacy_product_types.sql antes desta migration — esta migration nunca cria um Product Type novo.';
  END IF;
END $$;

-- PARTE 2 — Vínculo Sutiã <-> Modelo (required=true, mesma
-- obrigatoriedade que já existia no caminho legado)
INSERT INTO public.type_attributes (product_type_id, variation_type_id, required, active)
SELECT pt.id, vt.id, true, true
FROM public.product_types pt, public.variation_types vt
WHERE pt.company_id = 1 AND pt.slug = 'sutia'
  AND vt.slug = 'modelo'
ON CONFLICT (product_type_id, variation_type_id) DO UPDATE
  SET required = EXCLUDED.required,
      active   = EXCLUDED.active;

-- PARTE 3 — Valores de Modelo de Sutiã (6 legados + Silicone), sku_code
-- 35-41, validados individualmente antes de inserir: nenhuma
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
      ('Básico com Bojo', 'basico-com-bojo', 'basico_com_bojo', '35'),
      ('Básico sem Bojo', 'basico-sem-bojo', 'basico_sem_bojo', '36'),
      ('Renda',           'renda',           'renda',           '37'),
      ('Top',             'top',             'top',             '38'),
      ('Com Aro',         'com-aro',         'com_aro',         '39'),
      ('Sem Aro',         'sem-aro',         'sem_aro',         '40'),
      ('Silicone',        'silicone',        'silicone',        '41')
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
    -- (slug+sku_code já batendo exatamente = reaproveita, sem efeito extra)
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

-- PARTE 4 — Governança de VALOR: os 7 valores acima ficam vinculados
-- exclusivamente ao Tipo Sutiã
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'sutia'
  AND vv.slug IN (
    'basico-com-bojo', 'basico-sem-bojo', 'renda', 'top',
    'com-aro', 'sem-aro', 'silicone'
  )
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Sutiã possui o Modelo "Silicone"
SELECT vv.value, vv.slug, vv.sku_code, vv.active AS valor_ativo, tav.active AS vinculo_ativo
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'sutia' AND vv.slug = 'silicone';
-- Esperado: 1 linha, valor_ativo=true, vinculo_ativo=true

-- O Modelo "Silicone" está ativo
SELECT active FROM public.variation_values
WHERE slug = 'silicone'
  AND variation_type_id = (SELECT id FROM public.variation_types WHERE slug = 'modelo');
-- Esperado: 1 linha, active=true

-- O Modelo "Silicone" está vinculado EXCLUSIVAMENTE ao Tipo Sutiã
SELECT vv.slug, count(DISTINCT tav.product_type_id) AS tipos_vinculados
FROM public.variation_values vv
JOIN public.type_attribute_values tav ON tav.variation_value_id = vv.id AND tav.active = true
WHERE vv.slug = 'silicone'
GROUP BY vv.slug;
-- Esperado: 1 linha, tipos_vinculados = 1

-- Sutiã possui todos os 7 Modelos esperados
SELECT vv.value, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'sutia' AND tav.active = true
ORDER BY vv.sku_code;
-- Esperado: 7 linhas — Básico com Bojo(35), Básico sem Bojo(36),
-- Renda(37), Top(38), Com Aro(39), Sem Aro(40), Silicone(41)

SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'sutia' AND tav.active = true;
-- Esperado: 7

SELECT pt.slug AS tipo, vt.slug AS atributo, ta.required, ta.active
FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
JOIN public.variation_types vt ON vt.id = ta.variation_type_id
WHERE pt.slug = 'sutia' AND vt.slug = 'modelo';
-- Esperado: 1 linha, required=true, active=true

SELECT value_governance FROM public.variation_types WHERE slug = 'modelo';
-- Esperado: 'type_restricted' (não alterado por esta migration)

-- Confirma que nenhum sku_code de Modelo colide entre Tipos (todos juntos)
SELECT sku_code, count(*)
FROM public.variation_values vv
JOIN public.variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- Fluxo legado intocado: nenhum outro Tipo legado ganhou vínculo dinâmico
-- por esta migration
SELECT count(*) FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
WHERE pt.slug = 'short_doll';
-- Esperado: 0

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
