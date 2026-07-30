-- =============================================================================
-- 202607301700_pim_seed_legacy_product_types.sql
--
-- Corrige um bug encontrado em teste real: o select "Tipo" da tela
-- /produtos/novo é hardcoded no objeto SKU_TIPO (src/lib/sku/sku-map.ts) e
-- nunca consultou product_types — por isso Sex Shop (que só existe como
-- linha no banco) não aparecia, mesmo com sku_code='16' já corrigido.
--
-- A correção de fundo é trocar o select para ler de product_types (ver
-- /api/produtos/tipos e produtos/novo/page.tsx). Mas isso só funciona sem
-- quebrar os Tipos legados (Sutiã, Body, Pijama, etc.) se cada um deles
-- também existir como linha em product_types — hoje só Calcinha (usada nos
-- testes de Modelo dinâmico, Fase E/G) e Sex Shop têm linha própria; as
-- outras 14 nunca foram inseridas em nenhuma migration rastreada.
--
-- O QUE FAZ:
--   Insere as 15 linhas de product_types correspondentes 1:1 às chaves e
--   sku_code de SKU_TIPO (src/lib/sku/sku-map.ts) — mesmo slug (chave do
--   objeto), mesmo código de 2 dígitos. Nenhum valor é inventado.
--
-- O QUE NÃO FAZ:
--   - Não toca em nenhum produto existente (products.tipo/modelo continuam
--     como estão, não são alterados nem lidos aqui).
--   - Não cria type_attributes nem Modelo pra nenhum Tipo legado além de
--     Calcinha (já existente) — esses Tipos continuam 100% no caminho
--     legado de SKU (SKU_TIPO/SKU_MODELO), só passam a existir também como
--     linha em product_types para alimentar o select dinamicamente.
--   - Não altera sku_code de nenhuma linha já existente (Calcinha, Sex
--     Shop) — ON CONFLICT DO NOTHING, nunca sobrescreve.
--
-- IDEMPOTENTE: ON CONFLICT (company_id, slug) DO NOTHING — seguro pra
-- rodar de novo, e não conflita com Calcinha/Sex Shop já inseridos por
-- outras migrations.
-- =============================================================================

INSERT INTO public.product_types (company_id, name, slug, sku_code, active)
VALUES
  (1, 'Sutiã',                    'sutia',                    '01', true),
  (1, 'Calcinha',                 'calcinha',                 '02', true),
  (1, 'Body',                     'body',                     '03', true),
  (1, 'Pijama',                   'pijama',                   '04', true),
  (1, 'Camisola',                 'camisola',                 '05', true),
  (1, 'Baby Doll',                'baby_doll',                '06', true),
  (1, 'Robe',                     'robe',                     '07', true),
  (1, 'Top',                      'top',                      '08', true),
  (1, 'Short Doll',               'short_doll',               '09', true),
  (1, 'Pijama Vestido',           'pijama_vestido',           '10', true),
  (1, 'Pijama Americano',         'pijama_americano',         '11', true),
  (1, 'Camisola Americana',       'camisola_americana',       '12', true),
  (1, 'Pijama Rendado',           'pijama_rendado',            '13', true),
  (1, 'Conjunto Calcinha e Sutiã','conjunto_calcinha_sutia',  '14', true),
  (1, 'Cinta',                    'cinta',                    '15', true)
ON CONFLICT (company_id, slug) DO NOTHING;

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT slug, sku_code FROM public.product_types
WHERE company_id = 1
ORDER BY sku_code;
-- Esperado: 17 linhas (15 legados + calcinha e sex_shop já existentes,
-- calcinha aparece 1x só — sku_code '02' não duplica)

SELECT sku_code, count(*) FROM public.product_types
WHERE company_id = 1
GROUP BY sku_code
HAVING count(*) > 1;
-- Esperado: 0 linhas (nenhum sku_code duplicado)

-- =============================================================================
-- FIM DA MIGRATION
-- =============================================================================
