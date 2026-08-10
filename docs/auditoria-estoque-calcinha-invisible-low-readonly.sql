-- ============================================================================
-- AUDITORIA — ÚLTIMA ADIÇÃO DE ESTOQUE: "CALCINHA INVISIBLE LOW" (ESTOQUE LOJA)
-- ============================================================================
-- Gerado em: 2026-08-10. Somente SELECT — nenhuma alteração.
-- Não executado por mim (Claude) nesta sessão — sem acesso direto ao banco.
-- Rode no SQL Editor do Supabase.
--
-- Como funciona uma "adição" de estoque hoje (confirmado lendo
-- supabase/migrations/20260615_fix_rpc_stock_entry_total_lot_cost.sql, a
-- versão vigente de rpc_stock_entry, e 20260610_multi_estoque.sql):
--   - Toda entrada de estoque grava em 3 lugares na mesma transação:
--       1) stock_lots        — o "lote" (quantidade, custo, fornecedor, notas)
--       2) stock_balances    — saldo atualizado por variação + local
--       3) stock_movements   — o "ledger"/histórico de movimentações,
--          com type='entry', movement_type='entry', reference_type='lot',
--          destination_location_id = local de destino, created_by = quem fez.
--   - "Loja" = public.stock_locations onde is_main_store = true (nome
--     cadastrado literalmente como 'Estoque Loja').
--   - Um AJUSTE manual positivo (rpc_stock_adjust, ex.: correção de
--     contagem) também aumenta o saldo, mas grava type='adjust', não
--     'entry' — por isso a Seção 2 mostra as duas possibilidades
--     separadamente: se você "subiu sem querer" pode ter sido qualquer
--     uma das duas, dependendo de qual tela você usou.
-- ============================================================================


-- ============================================================================
-- SEÇÃO 0 — LOCALIZAR O PRODUTO/VARIAÇÃO "CALCINHA INVISIBLE LOW"
-- ============================================================================
-- ILIKE por segurança de grafia/acentuação. Confirme visualmente o(s)
-- product_id / variacao_id certos antes de interpretar a Seção 1/2.

SELECT
  p.id            AS produto_id,
  p.name          AS produto,
  pv.id           AS variacao_id,
  pv.sku_variation AS sku_variacao,
  pv.color, pv.size, pv.model,
  pv.active       AS variacao_ativa
FROM public.products p
LEFT JOIN public.product_variations pv ON pv.product_id = p.id
WHERE p.name ILIKE '%invisible%low%'
   OR pv.model ILIKE '%invisible%low%'
ORDER BY p.id, pv.id;


-- ============================================================================
-- SEÇÃO 1 — HISTÓRICO COMPLETO DE MOVIMENTAÇÕES NA LOJA, MAIS RECENTE PRIMEIRO
-- ============================================================================
-- Todas as movimentações (entrada, venda, ajuste, transferência, devolução)
-- da(s) variação(ões) encontrada(s) na Seção 0, no local "Estoque Loja".
-- Use isto para ver o contexto completo em volta da data suspeita, não só
-- as adições.

SELECT
  sm.created_at            AS quando,
  sm.type                  AS tipo_legado,
  sm.movement_type         AS tipo_movimento,
  sm.quantity               AS quantidade_delta,
  sm.previous_stock         AS saldo_antes,
  sm.new_stock              AS saldo_depois,
  sm.reference_type,
  sm.reference_id,
  sm.notes,
  u.name                    AS feito_por,
  loc.name                  AS local_destino,
  p.name                    AS produto,
  pv.sku_variation           AS sku_variacao
FROM public.stock_movements sm
JOIN public.product_variations pv ON pv.id = sm.product_variation_id
JOIN public.products p            ON p.id = pv.product_id
LEFT JOIN public.users u          ON u.id = sm.created_by
LEFT JOIN public.stock_locations loc ON loc.id = sm.destination_location_id
WHERE (p.name ILIKE '%invisible%low%' OR pv.model ILIKE '%invisible%low%')
  AND (loc.is_main_store = true OR sm.destination_location_id IS NULL)
ORDER BY sm.created_at DESC;


-- ============================================================================
-- SEÇÃO 2 — SÓ AS ADIÇÕES (entrada de lote OU ajuste positivo), MAIS RECENTE
--           PRIMEIRO — provavelmente a resposta direta que você quer
-- ============================================================================
-- Traz também os dados do lote (fornecedor, custo, data de entrada, notas)
-- quando a adição veio de uma entrada formal (type='entry'), via
-- reference_id (que guarda o id do stock_lot como texto).

SELECT
  sm.created_at            AS quando_a_adicao_foi_feita,
  sm.type                  AS tipo,
  sm.quantity                AS quantidade_adicionada,
  sm.previous_stock          AS saldo_antes,
  sm.new_stock               AS saldo_depois,
  u.name                     AS feito_por,
  loc.name                   AS local,
  p.name                     AS produto,
  pv.sku_variation             AS sku_variacao,
  sl.entry_date               AS data_entrada_lote,
  sl.notes                    AS notas_do_lote,
  s.name                      AS fornecedor_do_lote,
  sl.quantity_original         AS quantidade_original_lote
FROM public.stock_movements sm
JOIN public.product_variations pv ON pv.id = sm.product_variation_id
JOIN public.products p            ON p.id = pv.product_id
LEFT JOIN public.users u          ON u.id = sm.created_by
LEFT JOIN public.stock_locations loc ON loc.id = sm.destination_location_id
LEFT JOIN public.stock_lots sl    ON sl.id = NULLIF(sm.reference_id, '')::int
                                   AND sm.reference_type = 'lot'
LEFT JOIN public.suppliers s      ON s.id = sl.supplier_id
WHERE (p.name ILIKE '%invisible%low%' OR pv.model ILIKE '%invisible%low%')
  AND sm.quantity > 0
  AND sm.type IN ('entry', 'adjust')
  AND (loc.is_main_store = true OR sm.destination_location_id IS NULL)
ORDER BY sm.created_at DESC;
