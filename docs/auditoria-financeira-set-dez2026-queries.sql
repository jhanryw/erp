-- =============================================================================
-- AUDITORIA FINANCEIRA/COMERCIAL/ESTOQUE — SANTTORINI (2026-08-28)
-- Pacote de consultas SOMENTE LEITURA (SELECT). Nenhuma escrita, nenhuma
-- migration, nenhuma alteração de dado. Seguro para rodar em produção.
--
-- COMO USAR:
--   1. Rode a Query 0 primeiro. Se retornar MAIS DE 1 empresa, troque o
--      subquery "(SELECT id FROM public.companies ORDER BY id LIMIT 1)"
--      pelo ID LITERAL correto da Santtorini em TODAS as queries abaixo
--      antes de rodar o resto.
--   2. Rode cada query numerada separadamente (Q1, Q2a, Q2b...).
--   3. Cole o resultado de cada uma de volta na conversa — pode ser a
--      grade de resultado do SQL Editor, JSON ou CSV exportado. Para a
--      Q4 (a maior, uma linha por variação de produto), prefira exportar
--      como CSV (botão de export do SQL Editor) e colar o conteúdo.
--   4. Período principal usado: 01/06/2026 a 28/08/2026 (conforme
--      solicitado). Se você rodar isso em outra data, ajuste os literais
--      de data onde marcado "AJUSTAR SE NECESSÁRIO".
--
-- Definição de "venda válida" usada em toda esta auditoria (ver mapa de
-- fontes, docs/auditoria-financeira-set-dez2026-mapa-fontes.md):
--   status NOT IN ('cancelled','returned') — é a definição dominante no
--   próprio ERP (dashboard.ts, sellerDashboard.ts, mv_product_performance).
--   A Query 1b existe exatamente para medir quantas vendas 'pending'
--   existem, já que essa definição as inclui e uma view do ERP
--   (vw_daily_revenue_trend) as exclui — reportaremos a diferença se for
--   material.
-- =============================================================================


-- =============================================================================
-- Q0 — Identificação da empresa (RODAR PRIMEIRO)
-- =============================================================================
SELECT id, name FROM public.companies ORDER BY id;


-- =============================================================================
-- Q1 — Série diária de faturamento (2026-04-01 a 2026-08-28)
-- Janela alargada para trás (abril) só para permitir médias móveis de 7/14/30
-- dias já a partir do início de junho, sem "buraco" no começo da série.
-- =============================================================================
SELECT
  s.sale_date,
  EXTRACT(ISODOW FROM s.sale_date)::int                         AS dia_semana_iso, -- 1=seg...7=dom
  COUNT(DISTINCT s.id)                                          AS qtd_vendas,
  COALESCE(SUM(s.subtotal), 0)                                  AS faturamento_bruto,
  COALESCE(SUM(s.discount_amount), 0)                           AS descontos,
  COALESCE(SUM(s.cashback_used), 0)                             AS cashback_usado,
  COALESCE(SUM(s.total), 0)                                     AS faturamento_liquido,
  COALESCE(SUM(si.quantity), 0)                                 AS itens_vendidos,
  COUNT(DISTINCT s.customer_id)                                 AS clientes_unicos
FROM public.sales s
LEFT JOIN public.sale_items si ON si.sale_id = s.id
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND s.status NOT IN ('cancelled', 'returned')
  AND s.sale_date BETWEEN '2026-04-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
GROUP BY s.sale_date
ORDER BY s.sale_date;


-- =============================================================================
-- Q1b — Vendas por status no período principal (para validar "venda válida")
-- =============================================================================
SELECT
  s.status,
  COUNT(*)          AS qtd,
  SUM(s.total)       AS valor_total,
  MIN(s.sale_date)   AS primeira,
  MAX(s.sale_date)   AS ultima
FROM public.sales s
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND s.sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
GROUP BY s.status
ORDER BY qtd DESC;


-- =============================================================================
-- Q2a — Cobertura sale_payments (novo, com multi-forma+taxa) vs. legado
-- =============================================================================
SELECT
  DATE_TRUNC('month', s.sale_date)::date                                              AS mes,
  COUNT(*)                                                                            AS total_vendas,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.sale_payments sp WHERE sp.sale_id = s.id)) AS com_sale_payments,
  COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.sale_payments sp WHERE sp.sale_id = s.id)) AS somente_legado
FROM public.sales s
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND s.status NOT IN ('cancelled', 'returned')
  AND s.sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
GROUP BY 1
ORDER BY 1;

-- Q2b — Forma de pagamento por mês (fonte nova, com taxa de adquirente)
SELECT
  DATE_TRUNC('month', s.sale_date)::date AS mes,
  sp.method,
  COUNT(*)                    AS qtd_pagamentos,
  SUM(sp.net_amount)          AS valor_total,
  SUM(sp.fee_amount)          AS taxa_total,
  AVG(sp.fee_percentage)      AS taxa_media_pct
FROM public.sale_payments sp
JOIN public.sales s ON s.id = sp.sale_id
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND s.status NOT IN ('cancelled', 'returned')
  AND s.sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
GROUP BY 1, 2
ORDER BY 1, 2;

-- Q2c — Forma de pagamento legado (só vendas sem linha em sale_payments)
SELECT
  DATE_TRUNC('month', s.sale_date)::date AS mes,
  s.payment_method,
  COUNT(*)          AS qtd,
  SUM(s.total)       AS valor_total
FROM public.sales s
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND s.status NOT IN ('cancelled', 'returned')
  AND s.sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
  AND NOT EXISTS (SELECT 1 FROM public.sale_payments sp WHERE sp.sale_id = s.id)
GROUP BY 1, 2
ORDER BY 1, 2;


-- =============================================================================
-- Q3a — DRE mensal (view pronta do próprio ERP, já traz opex por categoria)
-- =============================================================================
SELECT *
FROM public.vw_dre_mensal
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
ORDER BY mes;

-- Q3b — Detalhe de lançamentos financeiros no período (recorrente x não-recorrente)
SELECT
  type,
  category,
  description,
  amount,
  reference_date,
  paid_at,
  (sale_id IS NOT NULL)      AS ligado_a_venda,
  (stock_lot_id IS NOT NULL) AS ligado_a_compra
FROM public.finance_entries
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND reference_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
ORDER BY reference_date, category;

-- Q3c — Despesas futuras / contas a pagar cadastradas (se existirem)
SELECT
  type, category, description, amount, reference_date, paid_at
FROM public.finance_entries
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND (reference_date > CURRENT_DATE OR (type = 'expense' AND paid_at IS NULL))
ORDER BY reference_date;


-- =============================================================================
-- Q4 — DATASET MESTRE: 1 linha por variação de produto, com estoque, custo,
-- preço e vendas em 5 janelas (7/15/30/60/90d) + período principal.
-- Esta é a query mais importante — alimenta Curva ABC, Ruptura, Calcinhas,
-- Matriz de Reposição, Estoque Encalhado e GMROI. Recomendo EXPORTAR COMO
-- CSV (botão de export do SQL Editor) em vez de copiar a grade manualmente.
-- =============================================================================
WITH ref AS (
  SELECT DATE '2026-08-28' AS hoje  -- AJUSTAR SE NECESSÁRIO (data de "hoje" na auditoria)
),
stock_agg AS (
  SELECT
    product_variation_id,
    SUM(quantity)::int AS current_qty,
    CASE WHEN SUM(quantity) > 0 THEN SUM(quantity * avg_cost) / SUM(quantity) ELSE 0 END AS avg_cost_weighted
  FROM public.stock_balances
  GROUP BY product_variation_id
),
attrs AS (
  SELECT
    pva.product_variation_id,
    MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS cor,
    MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS tamanho
  FROM public.product_variation_attributes pva
  JOIN public.variation_types  vt ON vt.id = pva.variation_type_id
  JOIN public.variation_values vv ON vv.id = pva.variation_value_id
  GROUP BY pva.product_variation_id
),
sales_win AS (
  SELECT
    si.product_variation_id,
    SUM(si.quantity)      FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 6)  AS qty_7d,
    SUM(si.total_price)   FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 6)  AS rev_7d,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 6)  AS profit_7d,
    SUM(si.quantity)      FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 14) AS qty_15d,
    SUM(si.total_price)   FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 14) AS rev_15d,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 14) AS profit_15d,
    SUM(si.quantity)      FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 29) AS qty_30d,
    SUM(si.total_price)   FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 29) AS rev_30d,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 29) AS profit_30d,
    SUM(si.quantity)      FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 59) AS qty_60d,
    SUM(si.total_price)   FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 59) AS rev_60d,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 59) AS profit_60d,
    SUM(si.quantity)      FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 89) AS qty_90d,
    SUM(si.total_price)   FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 89) AS rev_90d,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date >= (SELECT hoje FROM ref) - 89) AS profit_90d,
    SUM(si.quantity)      FILTER (WHERE s.sale_date BETWEEN '2026-06-01' AND '2026-08-28') AS qty_periodo,
    SUM(si.total_price)   FILTER (WHERE s.sale_date BETWEEN '2026-06-01' AND '2026-08-28') AS rev_periodo,
    SUM(si.gross_profit)  FILTER (WHERE s.sale_date BETWEEN '2026-06-01' AND '2026-08-28') AS profit_periodo,
    MIN(s.sale_date) AS first_sale_date,
    MAX(s.sale_date) AS last_sale_date
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
    AND s.status NOT IN ('cancelled', 'returned')
  GROUP BY si.product_variation_id
),
last_entry AS (
  SELECT product_variation_id, MAX(entry_date) AS last_entry_date
  FROM public.stock_lots
  GROUP BY product_variation_id
)
SELECT
  p.id                                                            AS product_id,
  p.name                                                          AS product_name,
  c.name                                                          AS category_name,
  b.name                                                          AS brand_name,
  sup.name                                                        AS supplier_name,
  p.origin,
  p.active                                                        AS product_active,
  p.created_at                                                    AS product_created_at,
  pv.id                                                            AS variation_id,
  pv.sku_variation,
  pv.active                                                       AS variation_active,
  a.cor,
  a.tamanho,
  COALESCE(pv.price_override, p.base_price)                       AS preco_venda,
  COALESCE(pv.cost_override, p.base_cost)                         AS custo_cadastro,
  COALESCE(sa.current_qty, 0)                                     AS estoque_atual,
  COALESCE(sa.avg_cost_weighted, COALESCE(pv.cost_override, p.base_cost)) AS custo_medio_estoque,
  ROUND(COALESCE(sa.current_qty, 0) * COALESCE(sa.avg_cost_weighted, COALESCE(pv.cost_override, p.base_cost)), 2) AS valor_estoque_custo,
  ROUND(COALESCE(sa.current_qty, 0) * COALESCE(pv.price_override, p.base_price), 2) AS valor_estoque_potencial_venda,
  le.last_entry_date,
  sw.first_sale_date,
  sw.last_sale_date,
  COALESCE(sw.qty_7d, 0)  AS qty_7d,  COALESCE(sw.rev_7d, 0)  AS rev_7d,  COALESCE(sw.profit_7d, 0)  AS profit_7d,
  COALESCE(sw.qty_15d, 0) AS qty_15d, COALESCE(sw.rev_15d, 0) AS rev_15d, COALESCE(sw.profit_15d, 0) AS profit_15d,
  COALESCE(sw.qty_30d, 0) AS qty_30d, COALESCE(sw.rev_30d, 0) AS rev_30d, COALESCE(sw.profit_30d, 0) AS profit_30d,
  COALESCE(sw.qty_60d, 0) AS qty_60d, COALESCE(sw.rev_60d, 0) AS rev_60d, COALESCE(sw.profit_60d, 0) AS profit_60d,
  COALESCE(sw.qty_90d, 0) AS qty_90d, COALESCE(sw.rev_90d, 0) AS rev_90d, COALESCE(sw.profit_90d, 0) AS profit_90d,
  COALESCE(sw.qty_periodo, 0)   AS qty_periodo_jun_ago,
  COALESCE(sw.rev_periodo, 0)   AS rev_periodo_jun_ago,
  COALESCE(sw.profit_periodo,0) AS profit_periodo_jun_ago
FROM public.products p
JOIN public.product_variations pv ON pv.product_id = p.id
LEFT JOIN public.categories c ON c.id = p.category_id
LEFT JOIN public.brands b ON b.id = p.brand_id
LEFT JOIN public.suppliers sup ON sup.id = p.supplier_id
LEFT JOIN attrs a       ON a.product_variation_id = pv.id
LEFT JOIN stock_agg sa  ON sa.product_variation_id = pv.id
LEFT JOIN sales_win sw  ON sw.product_variation_id = pv.id
LEFT JOIN last_entry le ON le.product_variation_id = pv.id
WHERE p.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
ORDER BY p.name, a.tamanho;


-- =============================================================================
-- Q5a — Reconciliação dos números do dashboard /estoque (437 / 3.525 / valores)
-- Replica exatamente a lógica de src/app/(dashboard)/estoque/page.tsx
-- =============================================================================
WITH v AS (
  SELECT *
  FROM public.vw_stock_live_multi
  WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
)
SELECT
  COUNT(DISTINCT product_id) FILTER (WHERE total_qty > 0)         AS produtos_com_estoque,
  COUNT(*)                   FILTER (WHERE total_qty > 0)         AS variacoes_com_estoque,
  SUM(total_qty)              FILTER (WHERE total_qty > 0)        AS unidades_totais,
  SUM(total_stock_value_at_cost)  FILTER (WHERE total_qty > 0)    AS valor_custo_total,
  SUM(total_stock_value_at_price) FILTER (WHERE total_qty > 0)    AS valor_venda_total,
  COUNT(*) FILTER (WHERE total_qty = 0)                           AS variacoes_zeradas,
  COUNT(*) FILTER (WHERE total_qty BETWEEN 1 AND 3)               AS variacoes_criticas,
  COUNT(DISTINCT product_id)                                      AS produtos_totais_qualquer_estoque
FROM v;

-- Q5b — Total de produtos ativos/inativos no catálogo (comparação com "437")
SELECT
  COUNT(*)                              AS produtos_total,
  COUNT(*) FILTER (WHERE active = true) AS produtos_ativos,
  COUNT(*) FILTER (WHERE active = false) AS produtos_inativos
FROM public.products
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1);


-- =============================================================================
-- Q6 — Cancelamentos, devoluções e trocas no período
-- =============================================================================
SELECT 'cancelamentos_status' AS tipo, COUNT(*) AS qtd, SUM(total) AS valor_total
FROM public.sales
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND status = 'cancelled'
  AND sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
UNION ALL
SELECT 'devolucoes_status', COUNT(*), SUM(total)
FROM public.sales
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND status = 'returned'
  AND sale_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
UNION ALL
SELECT 'returns_tabela', COUNT(*), SUM(r.total_refunded)
FROM public.returns r
JOIN public.sales s ON s.id = r.sale_id
WHERE s.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND r.created_at::date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
UNION ALL
SELECT 'trocas_exchanges', COUNT(*), SUM(returned_amount)
FROM public.exchanges
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND created_at::date BETWEEN '2026-06-01' AND '2026-08-28';  -- AJUSTAR SE NECESSÁRIO


-- =============================================================================
-- Q7 — Compras/entradas de estoque por fornecedor no período
-- =============================================================================
SELECT
  COALESCE(sup.name, '(produção própria / sem fornecedor)') AS fornecedor,
  COUNT(*)                          AS qtd_lotes,
  SUM(sl.quantity_original)         AS unidades_compradas,
  SUM(sl.total_lot_cost)            AS valor_total_compras,
  AVG(sl.cost_per_unit)             AS custo_medio_unidade
FROM public.stock_lots sl
JOIN public.product_variations pv ON pv.id = sl.product_variation_id
JOIN public.products p ON p.id = pv.product_id
LEFT JOIN public.suppliers sup ON sup.id = sl.supplier_id
WHERE p.company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1)
  AND sl.entry_date BETWEEN '2026-06-01' AND '2026-08-28'  -- AJUSTAR SE NECESSÁRIO
GROUP BY sup.name
ORDER BY valor_total_compras DESC NULLS LAST;


-- =============================================================================
-- Q8a — Qualidade de dados (view já pronta no ERP)
-- =============================================================================
SELECT *
FROM public.vw_data_quality_issues
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1);

-- Q8b — Sanidade extra de cadastro
SELECT
  COUNT(*) FILTER (WHERE category_id IS NULL)      AS sem_categoria,
  COUNT(*) FILTER (WHERE supplier_id IS NULL)       AS sem_fornecedor,
  COUNT(*) FILTER (WHERE base_cost = 0)             AS custo_zerado,
  COUNT(*) FILTER (WHERE wholesale_price IS NOT NULL) AS com_preco_atacado
FROM public.products
WHERE company_id = (SELECT id FROM public.companies ORDER BY id LIMIT 1);
