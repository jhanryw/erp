-- =============================================================================
-- 20260615_vw_data_quality_issues.sql
--
-- View de auditoria gerencial: detecta inconsistências que distorcem
-- estoque, margem, custo real e relatórios.
--
-- Severidades:
--   critical — dado errado distorcendo financeiro agora
--   high     — gap que causa relatório incorreto
--   medium   — dado incompleto ou alerta de negócio
--
-- Nota: stock_divergence usa stock_balances diretamente (não vw_stock_divergence,
--   que referenciava a tabela stock antiga — substituída pelo multi-estoque).
-- =============================================================================

CREATE OR REPLACE VIEW public.vw_data_quality_issues AS

-- ─── CRITICAL ────────────────────────────────────────────────────────────────

-- 1. Lotes: unit_cost > 0 mas total_lot_cost = 0 (custo real não contabilizado)
SELECT
  'lot_cost_zero'                                                        AS issue_type,
  'critical'                                                             AS severity,
  'stock_lot'                                                            AS entity_type,
  sl.id::text                                                            AS entity_id,
  p.name || ' — ' || pv.sku_variation                                   AS entity_label,
  'unit_cost=' || sl.unit_cost
    || ' mas total_lot_cost=0. Custo real não contabilizado.'            AS description,
  'UPDATE stock_lots SET total_lot_cost = unit_cost * quantity_original'
    || ' + freight_cost + tax_cost WHERE id = ' || sl.id                AS suggested_action,
  sl.entry_date                                                          AS reference_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.unit_cost > 0 AND sl.total_lot_cost = 0

UNION ALL

-- 2. Divergência stock_balances × ledger de movimentos
SELECT
  'stock_divergence', 'critical', 'variation',
  total_sb.product_variation_id::text,
  p.name || ' — ' || pv.sku_variation,
  'Saldo em stock_balances=' || total_sb.qty
    || ' diverge do ledger (movimentos=' || COALESCE(total_mv.qty, 0)
    || ', delta=' || (total_sb.qty - COALESCE(total_mv.qty, 0)) || ').',
  'Verificar movimentos do produto. Executar reconciliação manual após inventário físico.',
  total_sb.last_updated::date
FROM (
  SELECT product_variation_id, SUM(quantity)::int AS qty, MAX(last_updated) AS last_updated
  FROM stock_balances
  GROUP BY product_variation_id
) total_sb
JOIN product_variations pv ON pv.id = total_sb.product_variation_id
JOIN products p             ON p.id  = pv.product_id
LEFT JOIN (
  SELECT product_variation_id, SUM(quantity)::int AS qty
  FROM stock_movements
  GROUP BY product_variation_id
) total_mv ON total_mv.product_variation_id = total_sb.product_variation_id
WHERE total_sb.qty != COALESCE(total_mv.qty, 0)

UNION ALL

-- 3. Vendas pagas/enviadas sem nenhum pagamento registrado
-- sale_status enum: 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'returned'
-- 'paid', 'shipped', 'delivered' = venda concluída com valor a receber
SELECT
  'sale_no_payment', 'critical', 'sale',
  s.id::text,
  'Venda #' || s.id || COALESCE(' — ' || c.name, ''),
  'Venda com status "' || s.status || '" sem linha em sale_payments. Caixa pode estar incorreto.',
  'Verificar e registrar pagamento manualmente em /vendas/' || s.id,
  s.created_at::date
FROM sales s
LEFT JOIN customers c ON c.id = s.customer_id
WHERE s.status IN ('paid', 'shipped', 'delivered')
  AND NOT EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id)

UNION ALL

-- ─── HIGH ─────────────────────────────────────────────────────────────────────

-- 4. Lotes: freight_cost > 0 mas total_lot_cost = 0 (frete perdido no custo)
SELECT
  'lot_freight_no_total_cost', 'high', 'stock_lot',
  sl.id::text,
  p.name || ' — ' || pv.sku_variation,
  'freight_cost=R$' || sl.freight_cost || ' mas total_lot_cost=0. Frete não incorporado ao custo.',
  'Verificar se unit_cost está preenchido e recalcular total_lot_cost para lote #' || sl.id,
  sl.entry_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.freight_cost > 0 AND sl.total_lot_cost = 0

UNION ALL

-- 5. Lotes: quantity_remaining negativo (venda além do recebido)
SELECT
  'lot_remaining_negative', 'high', 'stock_lot',
  sl.id::text,
  p.name || ' — ' || pv.sku_variation,
  'quantity_remaining=' || sl.quantity_remaining
    || ' (negativo). Lote vendido além do recebido.',
  'Investigar movimentos do lote #' || sl.id || '. Possível bypass do RPC ou bug em cancelamento.',
  sl.entry_date
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p             ON p.id  = pv.product_id
WHERE sl.quantity_remaining < 0

UNION ALL

-- 6. Produtos ativos com margem negativa (custo > preço)
SELECT
  'product_negative_margin', 'high', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Margem negativa: custo R$' || p.base_cost
    || ' > preço R$' || p.base_price
    || ' (' || ROUND(p.margin_pct, 1) || '%). Cada venda gera prejuízo.',
  'Corrigir base_cost ou base_price em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true AND p.margin_pct < 0

UNION ALL

-- 7. Produtos ativos com preço de venda zerado
SELECT
  'product_no_price', 'high', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'base_price=0. Produto não pode ser vendido com valor correto.',
  'Preencher preço de venda em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true AND COALESCE(p.base_price, 0) = 0

UNION ALL

-- 8. Variações ativas sem SKU
SELECT
  'variation_no_sku', 'high', 'variation',
  pv.id::text,
  p.name || ' — variação #' || pv.id,
  'sku_variation ausente. Quebra rastreabilidade de lotes e integrações.',
  'Preencher sku_variation em /produtos/' || p.id,
  pv.created_at::date
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
WHERE pv.active = true
  AND (pv.sku_variation IS NULL OR TRIM(pv.sku_variation) = '')

UNION ALL

-- 9. Estoque parado — nunca vendido, entrada há mais de 30 dias (dead stock)
SELECT
  'dead_stock', 'high', 'variation',
  ms.product_variation_id::text,
  ms.product_name || ' — ' || pv.sku_variation,
  'Estoque=' || ms.current_qty || ' un. (R$' || ms.stock_value_at_cost
    || ' em custo), entrada em ' || ms.last_entry_date
    || ', nunca vendido.',
  'Avaliar promoção, transferência ou descarte do estoque parado.',
  ms.last_entry_date
FROM mv_stock_status ms
JOIN product_variations pv ON pv.id = ms.product_variation_id
WHERE ms.current_qty > 0
  AND ms.last_sale_date IS NULL
  AND ms.last_entry_date < CURRENT_DATE - INTERVAL '30 days'

UNION ALL

-- ─── MEDIUM ───────────────────────────────────────────────────────────────────

-- 10. Produtos ativos de terceiros sem fornecedor vinculado
SELECT
  'product_no_supplier', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Produto de terceiro sem fornecedor. Custo não rastreável por fornecedor.',
  'Vincular fornecedor em /produtos/' || p.id || '/editar.',
  p.created_at::date
FROM products p
WHERE p.active = true
  AND p.supplier_id IS NULL
  AND p.origin = 'third_party'

UNION ALL

-- 11. Produtos ativos sem NCM
-- Severidade: medium agora.
-- TODO: tornar critical quando NF-e for ativada (alterar severity abaixo).
SELECT
  'product_no_ncm', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'NCM ausente. Obrigatório para emissão de NF-e e classificação fiscal.',
  'Preencher NCM em /produtos/' || p.id || '/editar → Dados Fiscais.',
  p.created_at::date
FROM products p
WHERE p.active = true AND p.ncm IS NULL

UNION ALL

-- 12. Estoque parado há 90+ dias (vendeu antes, mas estagnou)
-- Excluindo dead_stock (last_sale_date IS NULL) para não duplicar alertas
SELECT
  'product_no_sale_90d', 'medium', 'variation',
  ms.product_variation_id::text,
  ms.product_name || ' — ' || pv.sku_variation,
  'Estoque=' || ms.current_qty || ' un., última venda em '
    || ms.last_sale_date || ' ('
    || (CURRENT_DATE - ms.last_sale_date) || ' dias atrás).',
  'Avaliar desconto pontual ou redistribuição do estoque parado.',
  ms.last_sale_date
FROM mv_stock_status ms
JOIN product_variations pv ON pv.id = ms.product_variation_id
WHERE ms.current_qty > 0
  AND ms.last_sale_date IS NOT NULL
  AND ms.last_sale_date < CURRENT_DATE - INTERVAL '90 days'

UNION ALL

-- 13. Produtos com margem abaixo do alvo (0–20%)
-- Limiar: 20%. Ajustar conforme política da empresa.
-- Excluindo negativos (já cobertos por product_negative_margin)
SELECT
  'margin_below_target', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ')',
  'Margem ' || ROUND(p.margin_pct, 1) || '% abaixo do alvo de 20%.'
    || ' Custo R$' || p.base_cost || ', preço R$' || p.base_price || '.',
  'Renegociar custo com fornecedor ou revisar preço de venda.',
  p.created_at::date
FROM products p
WHERE p.active = true
  AND p.margin_pct >= 0
  AND p.margin_pct < 20

UNION ALL

-- 14. Produtos ativos com fornecedor inativado
SELECT
  'supplier_inactive', 'medium', 'product',
  p.id::text,
  p.name || ' (' || p.sku || ') — Forn: ' || sup.name,
  'Produto ativo vinculado ao fornecedor "' || sup.name || '" que está inativo.',
  'Reativar fornecedor, vincular outro, ou desativar produto em /produtos/' || p.id,
  p.created_at::date
FROM products p
JOIN suppliers sup ON sup.id = p.supplier_id
WHERE p.active = true AND sup.active = false;

-- Grant acesso
GRANT SELECT ON public.vw_data_quality_issues TO authenticated, service_role;

-- Comentário de uso:
-- SELECT issue_type, severity, COUNT(*) FROM vw_data_quality_issues GROUP BY 1, 2 ORDER BY 2, 1;
-- SELECT * FROM vw_data_quality_issues WHERE severity = 'critical' ORDER BY reference_date DESC;
