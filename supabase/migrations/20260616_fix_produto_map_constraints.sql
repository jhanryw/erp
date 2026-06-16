-- Corrige a tabela produto_map para permitir múltiplas variações por produto.
--
-- Problema: uq_produto_map (produto_id, source) impedia INSERT de linhas de variação
-- quando já existia linha de produto, causando falha silenciosa em mapVariantToNuvemshop.
--
-- Solução: duas constraints parciais separadas — uma para linha de produto, outra por variação.

-- 1. Limpar mapeamentos inválidos (todos sem external_variant_id — nenhum dado útil)
DELETE FROM produto_map WHERE source = 'nuvemshop';

-- 2. Remover constraint global que bloqueava múltiplas linhas por produto
ALTER TABLE public.produto_map DROP CONSTRAINT IF EXISTS uq_produto_map;

-- 3. Linha de nível de produto: 1 por produto por source
--    Usada por getMappedNuvemshopProduct para idempotência antes de criar na NS
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_map_produto_only
  ON public.produto_map (source, produto_id)
  WHERE product_variation_id IS NULL;

-- 4. Linha de variação: 1 por variação interna por source
--    Usada pelo stock sync para encontrar external_variant_id dado product_variation_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_map_variation_internal
  ON public.produto_map (source, product_variation_id)
  WHERE product_variation_id IS NOT NULL;
