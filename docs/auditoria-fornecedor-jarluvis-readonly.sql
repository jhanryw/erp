-- ============================================================================
-- AUDITORIA — ÚLTIMA MERCADORIA DO FORNECEDOR "JARLUVIS" — ERP SANTTORINI
-- ============================================================================
-- Gerado em: 2026-08-10
-- Regra absoluta: todas as consultas abaixo são SELECT / leitura pura.
-- NENHUMA delas faz INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE ou CREATE.
--
-- Este arquivo não foi executado contra o banco por mim (Claude) — não há
-- acesso direto ao Postgres/Supabase configurado nesta sessão (sem psql,
-- sem Supabase CLI linkado, sem MCP autorizado). Execute manualmente no
-- SQL Editor do Supabase (ou via `supabase db query` se tiver o CLI
-- linkado) e leia os resultados.
--
-- Arquitetura confirmada antes de escrever este SQL (ver explicação
-- completa na resposta do chat / commit desta auditoria):
--   - Mercadoria = public.products (produto) + public.product_variations
--     (SKU por combinação de cor/tamanho/modelo/tecido — colunas
--     denormalizadas, sem tabela de atributos genérica).
--   - Fornecedor = public.suppliers (id, name, document, ...).
--   - products.supplier_id -> suppliers.id  (fornecedor "do cadastro do
--     produto" — 1 fornecedor por produto, não por variação).
--   - Entrada física de mercadoria no estoque (compra) = public.stock_lots
--     (product_variation_id, supplier_id, entry_type IN ('purchase',
--     'own_production'), quantity_original, entry_date, created_at).
--     Este é o registro mais próximo de um "módulo de compras" que existe
--     hoje no sistema — não há tabela purchase_orders/compras dedicada.
--   - stock_lots.supplier_id é INDEPENDENTE de products.supplier_id: uma
--     mercadoria pode ter sido cadastrada com um fornecedor no produto e
--     recebida fisicamente de outro (ex.: troca de fornecedor ao longo do
--     tempo). Por isso as duas consultas abaixo são propositalmente
--     separadas — ver nota de "diferença conceitual" antes da Seção 3.
-- ============================================================================


-- ============================================================================
-- SEÇÃO 0 — LOCALIZAR O FORNECEDOR "JARLUVIS" (id e nome exato cadastrado)
-- ============================================================================
-- Usa ILIKE (case-insensitive, sem acento sensível) para não presumir a
-- grafia exata cadastrada (ex.: "Jarluvis", "JARLUVIS", "Jarluvis Ltda",
-- possível erro de digitação). Rode esta consulta primeiro e confirme
-- visualmente qual(is) id(s) correspondem à fornecedora antes de usar o(s)
-- id(s) nas seções seguintes.

SELECT
  id,
  name,
  document,
  phone,
  city,
  state,
  active,
  created_at
FROM public.suppliers
WHERE name ILIKE '%jarluvis%'
ORDER BY id;


-- ============================================================================
-- SEÇÃO 1 — CONCEITO A: "PRODUTO CADASTRADO" COM FORNECEDOR = JARLUVIS
-- ============================================================================
-- Baseado em products.supplier_id. Responde: "quando foi cadastrado no
-- sistema o produto/SKU mais recente atribuído à Jarluvis" — não implica
-- necessariamente que a mercadoria já chegou fisicamente no estoque.
--
-- Substitua o subselect de fornecedor por um id fixo se preferir, depois
-- de confirmar o id correto na Seção 0.

SELECT
  p.id                              AS produto_id,
  p.name                            AS produto,
  pv.id                             AS variacao_id,
  pv.sku_variation                  AS sku_variacao,
  s.name                            AS fornecedor,
  p.created_at                      AS data_cadastro_produto,
  pv.created_at                     AS data_cadastro_variacao,
  p.active                          AS produto_ativo,
  pv.active                         AS variacao_ativa
FROM public.products p
JOIN public.suppliers s          ON s.id = p.supplier_id
LEFT JOIN public.product_variations pv ON pv.product_id = p.id
WHERE s.name ILIKE '%jarluvis%'
ORDER BY p.created_at DESC, pv.created_at DESC NULLS LAST;


-- ============================================================================
-- SEÇÃO 2 — CONCEITO B: "MERCADORIA RECEBIDA / ENTRADA EM ESTOQUE" DA JARLUVIS
-- ============================================================================
-- Baseado em stock_lots.supplier_id + entry_type. Responde: "quando foi a
-- última entrada física de estoque (lote de compra) registrada com a
-- Jarluvis como fornecedor, e em que quantidade" — é o conceito mais
-- próximo de "mercadoria recebida" que o sistema hoje modela.
--
-- entry_type = 'purchase' isola compras de terceiros (exclui
-- 'own_production', que não se aplica a um fornecedor externo como a
-- Jarluvis, mas o filtro é redundante já que own_production normalmente
-- não tem supplier_id preenchido).

SELECT
  sl.id                             AS stock_lot_id,
  p.id                              AS produto_id,
  p.name                            AS produto,
  pv.id                             AS variacao_id,
  pv.sku_variation                  AS sku_variacao,
  s.name                            AS fornecedor,
  sl.entry_type                     AS tipo_entrada,
  sl.quantity_original               AS quantidade_entrada,
  sl.quantity_remaining              AS quantidade_restante,
  sl.unit_cost                      AS custo_unitario,
  sl.entry_date                     AS data_entrada_estoque,
  sl.created_at                     AS data_registro_lote,
  p.created_at                      AS data_cadastro_produto,
  pv.created_at                     AS data_cadastro_variacao
FROM public.stock_lots sl
JOIN public.product_variations pv ON pv.id = sl.product_variation_id
JOIN public.products p            ON p.id = pv.product_id
JOIN public.suppliers s           ON s.id = sl.supplier_id
WHERE s.name ILIKE '%jarluvis%'
  AND sl.entry_type = 'purchase'
ORDER BY sl.entry_date DESC, sl.created_at DESC;


-- ============================================================================
-- SEÇÃO 3 — VISÃO UNIFICADA (as duas colunas pedidas lado a lado)
-- ============================================================================
-- Uma linha por variação vinculada à Jarluvis via products.supplier_id,
-- com a MAIS RECENTE entrada de estoque daquela variação (se existir)
-- trazida via LEFT JOIN lateral. Cobre a lista de colunas pedida em um
-- único resultado, mas SEM perder a distinção conceitual: se
-- data_entrada_estoque vier NULL, significa que o produto/variação foi
-- cadastrado com a Jarluvis como fornecedor mas nunca teve uma entrada de
-- estoque (stock_lots) registrada com ela.
--
-- Ordenado pela data mais recente entre cadastro e entrada — é a consulta
-- que responde diretamente "qual foi a última mercadoria da Jarluvis e em
-- qual data", cobrindo os dois eventos possíveis.

SELECT
  p.id                               AS produto_id,
  p.name                             AS produto,
  pv.id                              AS variacao_id,
  pv.sku_variation                   AS sku_variacao,
  s.name                             AS fornecedor,
  p.created_at                       AS data_cadastro_produto,
  pv.created_at                      AS data_cadastro_variacao,
  ultimo_lote.entry_date             AS data_ultima_entrada_estoque,
  ultimo_lote.quantity_original      AS quantidade_ultima_entrada,
  GREATEST(
    p.created_at,
    pv.created_at,
    COALESCE(ultimo_lote.created_at, p.created_at)
  )                                  AS data_referencia_mais_recente
FROM public.products p
JOIN public.suppliers s ON s.id = p.supplier_id
LEFT JOIN public.product_variations pv ON pv.product_id = p.id
LEFT JOIN LATERAL (
  SELECT sl.entry_date, sl.quantity_original, sl.created_at
  FROM public.stock_lots sl
  WHERE sl.product_variation_id = pv.id
    AND sl.supplier_id = p.supplier_id
    AND sl.entry_type = 'purchase'
  ORDER BY sl.entry_date DESC, sl.created_at DESC
  LIMIT 1
) ultimo_lote ON true
WHERE s.name ILIKE '%jarluvis%'
ORDER BY data_referencia_mais_recente DESC;


-- ============================================================================
-- SEÇÃO 4 (bônus) — TODAS as entradas de estoque da Jarluvis, independente
-- de qual fornecedor está hoje cadastrado no produto
-- ============================================================================
-- Cobre o caso em que o produto teve supplier_id trocado depois de já ter
-- recebido mercadoria da Jarluvis (a Seção 3 usa p.supplier_id no JOIN
-- lateral e perderia esse histórico). Esta consulta une TODAS as entradas
-- de stock_lots da Jarluvis, não só as do fornecedor atual do produto.

SELECT
  sl.entry_date                     AS data_entrada,
  sl.quantity_original               AS quantidade,
  p.name                            AS produto,
  pv.sku_variation                   AS sku_variacao,
  s.name                            AS fornecedor_na_entrada,
  prod_sup.name                     AS fornecedor_atual_do_produto,
  (s.id = p.supplier_id)             AS fornecedor_mudou
FROM public.stock_lots sl
JOIN public.product_variations pv ON pv.id = sl.product_variation_id
JOIN public.products p            ON p.id = pv.product_id
JOIN public.suppliers s           ON s.id = sl.supplier_id
LEFT JOIN public.suppliers prod_sup ON prod_sup.id = p.supplier_id
WHERE s.name ILIKE '%jarluvis%'
  AND sl.entry_type = 'purchase'
ORDER BY sl.entry_date DESC;
