-- =============================================================================
-- 202607302100_pim_extend_modelo_sex_shop.sql
--
-- Amplia os Modelos do Tipo "Sex Shop" já existente, seguindo exatamente a
-- mesma arquitetura usada em Calcinha/Sex Shop/Cinta/Meia-calça/Acessório
-- Íntimo: product_types + variation_values + type_attribute_values. Não
-- cria nenhum Product Type novo, não altera nenhum arquivo TypeScript —
-- resolveDynamicModeloContext, /api/produtos/modelo-options e o formulário
-- já são genéricos e continuam funcionando sem nenhuma mudança de código.
--
-- O QUE FAZ:
--   1. Confirma que o Tipo 'sex_shop' já existe (interrompe com erro claro
--      se não existir — esta migration nunca cria um Product Type novo).
--   2. Cria 7 novos valores de Modelo sob o atributo global "Modelo":
--      Sugador, Vibrador, Estimulador, Anel Peniano, Bola Massageadora,
--      Lubrificante, Plug Anal — sku_code 28-34, continuando a sequência
--      global já usada (Calcinha 01-05, Sex Shop 06-14, Cinta 15-19,
--      Meia-calça 20-22/24-25, Acessório Íntimo 26-27). Cada valor é
--      validado individualmente ANTES do insert (mesmo padrão de
--      202607302000): se o slug já existir com um sku_code diferente do
--      esperado, ou se o sku_code já pertencer a outro slug, a migration
--      para com RAISE EXCEPTION — nenhum ON CONFLICT DO NOTHING escondendo
--      inconsistência.
--   3. Vincula os 7 valores novos exclusivamente ao Tipo Sex Shop em
--      type_attribute_values.
--   4. Corrige a categorização de "Ponto G": remove (desativa) o vínculo
--      Sex Shop <-> Ponto G em type_attribute_values — o valor correto
--      para esse produto passa a ser "Vibrador". Se nenhum outro Tipo
--      usar "Ponto G" ativamente após essa remoção, desativa também a
--      linha em variation_values (nunca DELETE — mesmo padrão de soft-
--      delete usado em todo o projeto). Se algum outro Tipo ainda usar
--      "Ponto G", o registro é preservado intocado.
--
-- O QUE NÃO FAZ:
--   - Não cria nenhum Product Type novo.
--   - Não altera nenhum produto existente nem product_attribute_values —
--     se algum produto já usa "Ponto G", essa referência histórica não é
--     tocada (imutabilidade de dado já gravado).
--   - Não faz DELETE físico em nenhuma tabela — só active=false.
--   - Não modifica nenhum arquivo .ts/.tsx.
--
-- IDEMPOTENTE: seguro pra rodar de novo — se tudo já estiver exatamente
-- como definido aqui (incluindo Ponto G já desvinculado), nenhuma parte
-- desta migration produz efeito adicional.
-- =============================================================================

-- PARTE 1 — Confirma que o Tipo Sex Shop já existe (nunca cria um novo)
DO $$
DECLARE
  sex_shop_id INT;
BEGIN
  SELECT id INTO sex_shop_id
  FROM public.product_types
  WHERE company_id = 1 AND slug = 'sex_shop';

  IF sex_shop_id IS NULL THEN
    RAISE EXCEPTION
      'product_type ''sex_shop'' não encontrado para company_id=1. Rode 202607301400_pim_seed_modelo_sex_shop.sql antes desta migration — esta migration nunca cria um Product Type novo.';
  END IF;
END $$;

-- PARTE 2 — Valores de Modelo novos de Sex Shop (Sugador..Plug Anal),
-- validados individualmente antes de inserir: nenhuma inconsistência de
-- slug/sku_code é reconciliada silenciosamente.
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
      ('Sugador',            'sugador',             'sugador',             '28'),
      ('Vibrador',           'vibrador',             'vibrador',            '29'),
      ('Estimulador',        'estimulador',          'estimulador',         '30'),
      ('Anel Peniano',       'anel-peniano',         'anel_peniano',        '31'),
      ('Bola Massageadora',  'bola-massageadora',    'bola_massageadora',   '32'),
      ('Lubrificante',       'lubrificante',         'lubrificante',        '33'),
      ('Plug Anal',          'plug-anal',            'plug_anal',           '34')
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

-- PARTE 3 — Vincula os 7 valores novos exclusivamente ao Tipo Sex Shop
INSERT INTO public.type_attribute_values (product_type_id, variation_value_id, active)
SELECT pt.id, vv.id, true
FROM public.product_types pt
JOIN public.variation_types vt ON vt.slug = 'modelo'
JOIN public.variation_values vv ON vv.variation_type_id = vt.id
WHERE pt.company_id = 1 AND pt.slug = 'sex_shop'
  AND vv.slug IN (
    'sugador', 'vibrador', 'estimulador', 'anel-peniano',
    'bola-massageadora', 'lubrificante', 'plug-anal'
  )
ON CONFLICT (product_type_id, variation_value_id) DO UPDATE
  SET active = EXCLUDED.active;

-- PARTE 4 — Correção de categorização: remove o vínculo Sex Shop <->
-- Ponto G (o produto passa a usar "Vibrador"). Preserva o registro de
-- variation_values se outro Tipo ainda o usar ativamente; senão, desativa
-- também (nunca DELETE).
DO $$
DECLARE
  modelo_type_id INT;
  ponto_g_id     INT;
  sex_shop_id    INT;
  other_links    INT;
BEGIN
  SELECT id INTO modelo_type_id FROM public.variation_types WHERE slug = 'modelo';
  SELECT id INTO sex_shop_id FROM public.product_types WHERE company_id = 1 AND slug = 'sex_shop';
  SELECT id INTO ponto_g_id FROM public.variation_values
  WHERE variation_type_id = modelo_type_id AND slug = 'ponto-g';

  IF ponto_g_id IS NOT NULL AND sex_shop_id IS NOT NULL THEN
    UPDATE public.type_attribute_values
    SET active = false
    WHERE product_type_id = sex_shop_id AND variation_value_id = ponto_g_id;

    SELECT count(*) INTO other_links
    FROM public.type_attribute_values
    WHERE variation_value_id = ponto_g_id
      AND product_type_id <> sex_shop_id
      AND active = true;

    IF other_links = 0 THEN
      UPDATE public.variation_values SET active = false WHERE id = ponto_g_id;
    END IF;
  END IF;
END $$;

-- =============================================================================
-- Smoke tests
-- =============================================================================

-- Sex Shop possui todos os Modelos esperados (8 originais menos Ponto G +
-- 7 novos = 15 vínculos ativos)
SELECT vv.value, vv.slug, vv.sku_code
FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'sex_shop' AND tav.active = true
ORDER BY vv.sku_code;
-- Esperado: 15 linhas — Golfinho(06), Bullet(07), Rabbit(08),
-- FunnyEggs(10), Algema(11), Chicote(12), Chibata(13),
-- Baralho Kama Sutra(14), Sugador(28), Vibrador(29), Estimulador(30),
-- Anel Peniano(31), Bola Massageadora(32), Lubrificante(33), Plug Anal(34)
-- — sem Ponto G(09)

SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
WHERE pt.slug = 'sex_shop' AND tav.active = true;
-- Esperado: 15

-- Não existe vínculo ATIVO para "Ponto G" no Tipo Sex Shop
SELECT count(*) FROM public.type_attribute_values tav
JOIN public.product_types pt ON pt.id = tav.product_type_id
JOIN public.variation_values vv ON vv.id = tav.variation_value_id
WHERE pt.slug = 'sex_shop' AND vv.slug = 'ponto-g' AND tav.active = true;
-- Esperado: 0

-- Todos os 7 novos Modelos estão vinculados EXCLUSIVAMENTE ao Tipo Sex Shop
SELECT vv.slug, count(DISTINCT tav.product_type_id) AS tipos_vinculados
FROM public.variation_values vv
JOIN public.type_attribute_values tav ON tav.variation_value_id = vv.id AND tav.active = true
WHERE vv.slug IN (
  'sugador', 'vibrador', 'estimulador', 'anel-peniano',
  'bola-massageadora', 'lubrificante', 'plug-anal'
)
GROUP BY vv.slug;
-- Esperado: 7 linhas, tipos_vinculados = 1 em todas

-- Confirma que nenhum sku_code de Modelo colide entre Tipos (todos juntos)
SELECT sku_code, count(*)
FROM public.variation_values vv
JOIN public.variation_types vt ON vt.id = vv.variation_type_id
WHERE vt.slug = 'modelo'
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas

-- Fluxo legado intocado: nenhum Tipo legado ganhou vínculo dinâmico por
-- esta migration
SELECT count(*) FROM public.type_attributes ta
JOIN public.product_types pt ON pt.id = ta.product_type_id
WHERE pt.slug = 'short_doll';
-- Esperado: 0

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
