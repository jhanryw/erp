-- Desativar "XG" como duplicata/alias histórico de "XGG" (tamanho canônico).
--
-- Auditoria (2026-07-07):
-- - "XG" é resquício de nomenclatura de uma fase anterior do produto, antes
--   da especialização em lingerie/moda íntima (ver histórico de
--   src/lib/sku/sku-map.ts). O mapa estático já trata 'xg' como alias de
--   'xgg', mesmo código '06'.
-- - "XGG" é o valor canônico: foi o nome oficialmente instituído para este
--   tamanho quando o catálogo se especializou em lingerie (migration
--   015_variation_values_pp_bege_preto.sql), e é o que a própria tela de
--   cadastro usa como exemplo de referência.
-- - "XG" nunca foi usado em nenhuma product_variations existente
--   (confirmado por auditoria: zero variações com este atributo).
-- - Tentativa de dar sku_code = '06' para "XG" (igual a "XGG") falha com
--   violação da constraint uq_vv_type_sku_code (variation_type_id,
--   sku_code) — o modelo dinâmico não permite dois valores do mesmo tipo
--   compartilhando código, diferente do mapa estático (que permitia alias
--   livremente). Por isso a correção correta não é atribuir código, é
--   desativar o registro duplicado, mantendo XGG como único valor ativo
--   e canônico para este tamanho.
--
-- Escopo: apenas dado (UPDATE em variation_values, active = false). Não
-- deleta, não atribui sku_code, não recalcula nenhum sku_variation
-- existente, não toca em estoque, vendas ou Nuvemshop.

UPDATE public.variation_values vv
SET active = false
FROM public.variation_types vt
WHERE vv.variation_type_id = vt.id
  AND vt.slug = 'tamanho'
  AND vv.normalized_name = 'xg'
  AND vv.active = true;
