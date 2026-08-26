-- Preenchimento inicial de preço de atacado — 30% de desconto sobre o
-- preço de varejo (wholesale = varejo × 0.70), só para produtos/variações
-- que AINDA NÃO têm preço de atacado cadastrado. Estes são valores
-- INICIAIS matemáticos (nunca "psicológicos") — serão editados depois
-- manualmente (tela de produto) ou via CSV para os valores comerciais
-- reais, reaproveitando exatamente os mesmos campos.
--
-- Auditoria real (assistida, banco de homologação, 2026-09-04) antes desta
-- migration:
--   563 produtos ativos, todos com base_price válido (nenhum NULL/0/negativo)
--   0 produtos já tinham wholesale_price preenchido
--   1251 variações totais, 6 com price_override válido (>0), 0 já tinham
--   wholesale_price_override preenchido
--   ~442 produtos ficarão disponíveis pro site de atacado após este fill
--   (ativo + variação ativa + estoque > 0 em local ativo)
-- products.base_price / wholesale_price e product_variations.price_override
-- / wholesale_price_override são todos NUMERIC(10,2) — ROUND(x, 2) é exato,
-- sem surpresa de ponto flutuante.
--
-- NÃO altera: base_price, base_cost, estoque, products.active,
-- product_variations.active. NÃO cria produto/variação/tabela. NÃO exclui
-- nada. Idempotente por construção: a cláusula WHERE ... IS NULL garante
-- que rodar esta migration de novo (ou já ter algum valor preenchido
-- manualmente antes de aplicar) nunca sobrescreve um preço de atacado já
-- cadastrado — só toca o que hoje é NULL.

-- ── Produtos ────────────────────────────────────────────────────────────────
-- wholesale_price = base_price × 0.70, só quando ainda não há wholesale_price
-- e o base_price é válido (NOT NULL e > 0). CHECK
-- products_wholesale_price_positive (wholesale_price > 0 quando não nulo) é
-- satisfeito automaticamente: base_price > 0 implica ROUND(base_price*0.7,2) > 0.
UPDATE public.products
SET wholesale_price = ROUND(base_price * 0.70, 2)
WHERE wholesale_price IS NULL
  AND base_price IS NOT NULL
  AND base_price > 0;

-- ── Variações ───────────────────────────────────────────────────────────────
-- wholesale_price_override = price_override × 0.70, só quando a variação
-- tem um preço de varejo ESPECÍFICO válido (price_override IS NOT NULL e
-- > 0) e ainda não tem override de atacado. Variação sem price_override
-- (a maioria — 1245 de 1251 na auditoria) NUNCA recebe
-- wholesale_price_override aqui: continua NULL e herda products.wholesale_price,
-- preservando exatamente a arquitetura de herança de resolveSalePrice.ts.
UPDATE public.product_variations
SET wholesale_price_override = ROUND(price_override * 0.70, 2)
WHERE wholesale_price_override IS NULL
  AND price_override IS NOT NULL
  AND price_override > 0;
