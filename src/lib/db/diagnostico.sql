-- =============================================================================
-- SANTTORINI ERP — SCRIPT DE DIAGNÓSTICO COMPLETO
-- Versão: 2026-05-21
--
-- INSTRUÇÕES:
--   Execute no Supabase SQL Editor (ou psql).
--   Leitura somente — nenhum dado é alterado.
--   Cole o resultado completo e compartilhe para análise.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 1: ESTRUTURA DAS VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 1: VIEWS E MATERIALIZED VIEWS ===' AS titulo;

-- 1a. Lista todas as views e materialized views do schema public
SELECT
  CASE relkind
    WHEN 'v'  THEN 'VIEW regular'
    WHEN 'm'  THEN 'MATERIALIZED VIEW'
    ELSE relkind::text
  END AS tipo,
  relname AS nome
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind IN ('v', 'm')
ORDER BY relkind, relname;

-- 1b. Diagnóstico específico de mv_stock_status
SELECT
  '--- mv_stock_status ---' AS check_name,
  CASE
    WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname = 'mv_stock_status' AND relnamespace = 'public'::regnamespace AND relkind = 'm')
      THEN '⚠ MATERIALIZED VIEW (precisa de REFRESH)'
    WHEN EXISTS (SELECT 1 FROM pg_class WHERE relname = 'mv_stock_status' AND relnamespace = 'public'::regnamespace AND relkind = 'v')
      THEN '✓ VIEW regular (sempre atualizada)'
    ELSE '✗ NÃO EXISTE — erro grave!'
  END AS status;

-- 1c. Definição atual de mv_stock_status (mostra se usa stock.quantity ou stock_lots)
SELECT
  '--- Definição de mv_stock_status ---' AS check_name,
  CASE
    WHEN pg_get_viewdef('public.mv_stock_status'::regclass, true) ILIKE '%stock_lots%'
      THEN '🔴 ERRADO: usa stock_lots.quantity_remaining (migration 036 ativa)'
    WHEN pg_get_viewdef('public.mv_stock_status'::regclass, true) ILIKE '%stock s%quantity%'
         OR pg_get_viewdef('public.mv_stock_status'::regclass, true) ILIKE '%FROM stock%'
      THEN '✓ CORRETO: usa stock.quantity'
    ELSE '? Definição inesperada — verificar manualmente'
  END AS status;

-- 1d. Primeiras 200 chars da definição atual (para confirmação visual)
SELECT
  left(pg_get_viewdef('public.mv_stock_status'::regclass, true), 400) AS definicao_atual
FROM pg_class
WHERE relname = 'mv_stock_status'
  AND relnamespace = 'public'::regnamespace;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 2: ESTRUTURA DAS TABELAS CRÍTICAS
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 2: TABELAS CRÍTICAS ===' AS titulo;

-- 2a. Verifica existência de tabelas essenciais
SELECT
  tablename AS tabela,
  CASE WHEN tablename IS NOT NULL THEN '✓ existe' ELSE '✗ FALTANDO' END AS status
FROM (
  VALUES
    ('products'), ('product_variations'), ('product_variation_attributes'),
    ('stock'), ('stock_lots'), ('stock_movements'),
    ('sales'), ('sale_items'), ('customers'), ('users'),
    ('finance_entries'), ('companies'),
    ('pedidos'), ('pedidos_itens'), ('estoque_movimentacoes'),
    ('produto_map'), ('nuvemshop_sync_logs')
) AS needed(t)
LEFT JOIN pg_tables pt ON pt.tablename = needed.t AND pt.schemaname = 'public';

-- 2b. Colunas de stock_movements (verifica se notes/created_by existem ou não)
SELECT
  '--- Colunas de stock_movements ---' AS check_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'stock_movements'
ORDER BY ordinal_position;

-- 2c. Colunas de customers (verifica se email existe)
SELECT
  '--- Colunas de customers ---' AS check_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'customers'
ORDER BY ordinal_position;

-- 2d. Colunas de stock (verifica company_id)
SELECT
  '--- Colunas de stock ---' AS check_name,
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'stock'
ORDER BY ordinal_position;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 3: FUNÇÕES RPC
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 3: FUNÇÕES RPC ===' AS titulo;

-- 3a. Lista todas as versões de rpc_create_sale (detecta overloads órfãos)
SELECT
  p.proname AS funcao,
  pg_get_function_arguments(p.oid) AS argumentos,
  CASE p.prosecdef WHEN true THEN '✓ SECURITY DEFINER' ELSE '⚠ sem SECURITY DEFINER' END AS seguranca
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'rpc_create_sale', 'rpc_cancel_sale', 'rpc_return_sale',
    'rpc_stock_entry', 'rpc_stock_adjust', 'rpc_stock_initialize',
    'rpc_nuvemshop_sale_deduct',
    'refresh_materialized_view', 'refresh_analytics_views'
  )
ORDER BY p.proname, pg_get_function_arguments(p.oid);

-- 3b. Verifica se rpc_nuvemshop_sale_deduct ainda existe (função perigosa)
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'rpc_nuvemshop_sale_deduct'
    ) THEN '⚠ rpc_nuvemshop_sale_deduct EXISTE — deve ser descartada'
    ELSE '✓ rpc_nuvemshop_sale_deduct não existe'
  END AS status;

-- 3c. Verifica se refresh_materialized_view existe (chamada pelo cron)
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'refresh_materialized_view'
    ) THEN '✓ refresh_materialized_view existe'
    ELSE '🔴 refresh_materialized_view NÃO EXISTE — cron job está falhando silenciosamente'
  END AS status;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 4: TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 4: TRIGGERS ===' AS titulo;

SELECT
  trigger_name,
  event_object_table AS tabela,
  event_manipulation AS evento,
  action_timing AS momento
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 5: CONSISTÊNCIA DO ESTOQUE
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 5: CONSISTÊNCIA DE ESTOQUE ===' AS titulo;

-- 5a. Resumo geral do estoque
SELECT
  COUNT(*)                                          AS total_variacoes_com_estoque,
  SUM(quantity)                                     AS total_unidades,
  COUNT(*) FILTER (WHERE quantity = 0)              AS variacoes_zeradas,
  COUNT(*) FILTER (WHERE quantity < 0)              AS variacoes_negativas,
  MIN(quantity)                                     AS menor_quantidade,
  MAX(quantity)                                     AS maior_quantidade,
  ROUND(SUM(quantity * avg_cost), 2)               AS valor_total_custo
FROM stock;

-- 5b. Variações com estoque NEGATIVO (não deve existir — constraint deveria bloquear)
SELECT
  s.product_variation_id,
  pv.sku_variation,
  p.name AS produto,
  s.quantity AS quantidade_negativa,
  s.avg_cost
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE s.quantity < 0
ORDER BY s.quantity;

-- 5c. Variações que existem em product_variations mas NÃO têm registro em stock
SELECT
  pv.id AS product_variation_id,
  pv.sku_variation,
  p.name AS produto
FROM product_variations pv
JOIN products p ON p.id = pv.product_id
WHERE NOT EXISTS (SELECT 1 FROM stock s WHERE s.product_variation_id = pv.id)
  AND pv.active = true
ORDER BY p.name, pv.sku_variation
LIMIT 50;

-- 5d. Comparação stock.quantity vs reconstrução pelo ledger stock_movements
-- Se divergirem, há movimento registrado que não foi aplicado ao saldo (ou vice-versa)
SELECT
  s.product_variation_id,
  pv.sku_variation,
  p.name AS produto,
  s.quantity                                         AS saldo_atual,
  COALESCE(SUM(sm.quantity), 0)::int                AS soma_movimentos,
  s.quantity - COALESCE(SUM(sm.quantity), 0)        AS divergencia
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock_movements sm ON sm.product_variation_id = s.product_variation_id
GROUP BY s.product_variation_id, pv.sku_variation, p.name, s.quantity
HAVING s.quantity != COALESCE(SUM(sm.quantity), 0)
ORDER BY ABS(s.quantity - COALESCE(SUM(sm.quantity), 0)) DESC
LIMIT 30;

-- 5e. Divergência entre mv_stock_status e stock real (apenas se view existir)
SELECT
  mv.product_variation_id,
  mv.product_name,
  mv.sku_variation,
  mv.current_qty    AS qty_na_view,
  s.quantity        AS qty_real_no_stock,
  mv.current_qty - s.quantity AS diferenca
FROM mv_stock_status mv
JOIN stock s ON s.product_variation_id = mv.product_variation_id
WHERE mv.current_qty != s.quantity
ORDER BY ABS(mv.current_qty - s.quantity) DESC
LIMIT 30;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 6: INTEGRIDADE DE VENDAS
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 6: INTEGRIDADE DE VENDAS ===' AS titulo;

-- 6a. Resumo de vendas por status
SELECT
  status,
  COUNT(*)                    AS quantidade,
  SUM(total)                  AS total_vendido,
  MIN(sale_date)              AS primeira_venda,
  MAX(sale_date)              AS ultima_venda
FROM sales
GROUP BY status
ORDER BY status;

-- 6b. Vendas com status 'paid' mas SEM stock_movement do tipo 'sale'
-- Sinal de venda criada sem decrementar estoque
SELECT
  s.id           AS sale_id,
  s.sale_number,
  s.sale_date,
  s.total,
  s.status
FROM sales s
WHERE s.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.type = 'sale'
  )
ORDER BY s.sale_date DESC
LIMIT 20;

-- 6c. Vendas canceladas/devolvidas sem stock_movement de 'return'
-- Sinal de cancelamento que não restaurou o estoque
SELECT
  s.id           AS sale_id,
  s.sale_number,
  s.sale_date,
  s.status,
  s.total
FROM sales s
WHERE s.status IN ('cancelled', 'returned')
  AND NOT EXISTS (
    SELECT 1 FROM stock_movements sm
    WHERE sm.reference_id = s.id::text
      AND sm.type = 'return'
  )
ORDER BY s.sale_date DESC
LIMIT 20;

-- 6d. Vendas com itens em product_variation inexistente (FK quebrada)
SELECT
  si.sale_id,
  si.product_variation_id,
  si.quantity
FROM sale_items si
WHERE NOT EXISTS (
  SELECT 1 FROM product_variations pv WHERE pv.id = si.product_variation_id
)
LIMIT 20;

-- 6e. Vendas com sale_number duplicado (não deveria acontecer — tem UNIQUE)
SELECT
  sale_number,
  COUNT(*) AS ocorrencias
FROM sales
GROUP BY sale_number
HAVING COUNT(*) > 1
ORDER BY ocorrencias DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 7: INTEGRIDADE DA INTEGRAÇÃO NUVEMSHOP
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 7: INTEGRAÇÃO NUVEMSHOP ===' AS titulo;

-- 7a. Resumo de pedidos por status
SELECT
  status,
  channel_status,
  stock_processed,
  COUNT(*) AS quantidade
FROM pedidos
GROUP BY status, channel_status, stock_processed
ORDER BY status;

-- 7b. Pedidos pagos com stock_processed = false (perdidos — nunca foram processados)
SELECT
  id        AS pedido_id,
  external_id,
  status,
  channel_status,
  total,
  created_at
FROM pedidos
WHERE channel_status = 'paid'
  AND (stock_processed = false OR stock_processed IS NULL)
ORDER BY created_at DESC
LIMIT 20;

-- 7c. Pedidos com stock_processed = true mas sem sale_id (processamento incompleto)
SELECT
  id        AS pedido_id,
  external_id,
  status,
  total,
  created_at
FROM pedidos
WHERE stock_processed = true
  AND sale_id IS NULL
ORDER BY created_at DESC
LIMIT 20;

-- 7d. Pedidos Nuvemshop com MAIS DE UMA venda associada (duplicata)
-- Detecta o race condition de duplo processamento
SELECT
  p.external_id,
  p.id AS pedido_id,
  COUNT(DISTINCT sm.reference_id) AS vendas_associadas,
  STRING_AGG(DISTINCT s.sale_number, ', ') AS numeros_venda
FROM pedidos p
JOIN sales s ON s.notes ILIKE '%' || p.external_id || '%'
JOIN stock_movements sm ON sm.reference_id = s.id::text AND sm.type = 'sale'
WHERE p.source = 'nuvemshop'
GROUP BY p.external_id, p.id
HAVING COUNT(DISTINCT s.id) > 1
ORDER BY p.external_id;

-- 7e. Variações mapeadas na Nuvemshop vs saldo no ERP
SELECT
  pm.external_product_id,
  pm.external_variant_id,
  pv.sku_variation,
  p.name AS produto,
  s.quantity AS saldo_erp,
  pm.last_stock_synced_at
FROM produto_map pm
JOIN product_variations pv ON pv.id = pm.product_variation_id
JOIN products p ON p.id = pv.product_id
LEFT JOIN stock s ON s.product_variation_id = pm.product_variation_id
WHERE pm.source = 'nuvemshop'
  AND pm.external_variant_id IS NOT NULL
ORDER BY pm.last_stock_synced_at ASC NULLS FIRST
LIMIT 50;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 8: INTEGRIDADE FINANCEIRA
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 8: INTEGRIDADE FINANCEIRA ===' AS titulo;

-- 8a. Resumo de finance_entries por tipo e categoria
SELECT
  type,
  category,
  COUNT(*)          AS lancamentos,
  SUM(amount)       AS total,
  MIN(reference_date) AS primeiro,
  MAX(reference_date) AS ultimo
FROM finance_entries
GROUP BY type, category
ORDER BY type, category;

-- 8b. Vendas pagas sem finance_entry de receita (venda não gerou lançamento)
SELECT
  s.id           AS sale_id,
  s.sale_number,
  s.sale_date,
  s.total
FROM sales s
WHERE s.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM finance_entries fe
    WHERE fe.sale_id = s.id
      AND fe.type = 'income'
      AND fe.category = 'sale'
  )
ORDER BY s.sale_date DESC
LIMIT 20;

-- 8c. Entradas de estoque sem finance_entry de despesa
SELECT
  sl.id           AS lot_id,
  sl.entry_date,
  sl.quantity_original,
  sl.total_lot_cost,
  pv.sku_variation
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
WHERE NOT EXISTS (
  SELECT 1 FROM finance_entries fe
  WHERE fe.stock_lot_id = sl.id
    AND fe.category = 'stock_purchase'
)
ORDER BY sl.entry_date DESC
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 9: INTEGRIDADE MULTI-TENANT
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 9: MULTI-TENANT (company_id) ===' AS titulo;

-- 9a. Registros de stock sem company_id (deveria ser preenchido)
SELECT COUNT(*) AS stock_sem_company_id FROM stock WHERE company_id IS NULL;

-- 9b. Registros de stock_movements sem company_id
SELECT COUNT(*) AS movements_sem_company_id FROM stock_movements WHERE company_id IS NULL;

-- 9c. Vendas sem company_id
SELECT COUNT(*) AS sales_sem_company_id FROM sales WHERE company_id IS NULL;

-- 9d. Clientes sem company_id
SELECT COUNT(*) AS customers_sem_company_id FROM customers WHERE company_id IS NULL;

-- 9e. Variações de produto cujo product.company_id diverge do stock.company_id
SELECT
  s.product_variation_id,
  pv.sku_variation,
  p.company_id   AS company_produto,
  s.company_id   AS company_estoque
FROM stock s
JOIN product_variations pv ON pv.id = s.product_variation_id
JOIN products p ON p.id = pv.product_id
WHERE p.company_id != s.company_id
  AND s.company_id IS NOT NULL
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 10: SAÚDE GERAL DO BANCO
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 10: SAÚDE GERAL ===' AS titulo;

-- 10a. Contagem geral de todas as tabelas principais
SELECT
  'products'               AS tabela, COUNT(*) AS registros FROM products
UNION ALL SELECT 'product_variations',   COUNT(*) FROM product_variations
UNION ALL SELECT 'stock',                COUNT(*) FROM stock
UNION ALL SELECT 'stock_lots',           COUNT(*) FROM stock_lots
UNION ALL SELECT 'stock_movements',      COUNT(*) FROM stock_movements
UNION ALL SELECT 'sales',                COUNT(*) FROM sales
UNION ALL SELECT 'sale_items',           COUNT(*) FROM sale_items
UNION ALL SELECT 'customers',            COUNT(*) FROM customers
UNION ALL SELECT 'finance_entries',      COUNT(*) FROM finance_entries
UNION ALL SELECT 'cashback_transactions',COUNT(*) FROM cashback_transactions
UNION ALL SELECT 'produto_map',          COUNT(*) FROM produto_map
UNION ALL SELECT 'nuvemshop_sync_logs',  COUNT(*) FROM nuvemshop_sync_logs
ORDER BY tabela;

-- 10b. Contagem de pedidos (se tabela existir)
SELECT
  'pedidos' AS tabela, COUNT(*) AS registros FROM pedidos
UNION ALL SELECT 'pedidos_itens', COUNT(*) FROM pedidos_itens
UNION ALL SELECT 'estoque_movimentacoes', COUNT(*) FROM estoque_movimentacoes;

-- 10c. Usuários cadastrados e seus roles
SELECT
  u.name,
  u.role,
  u.active,
  c.name AS empresa,
  u.created_at
FROM users u
LEFT JOIN companies c ON c.id = u.company_id
ORDER BY u.role, u.name;

-- 10d. Empresas cadastradas
SELECT id, name, slug, plan, active FROM companies;

-- 10e. Últimas 10 entradas de estoque
SELECT
  sl.id,
  sl.entry_date,
  sl.entry_type,
  sl.quantity_original,
  sl.unit_cost,
  sl.total_lot_cost,
  pv.sku_variation,
  p.name AS produto
FROM stock_lots sl
JOIN product_variations pv ON pv.id = sl.product_variation_id
JOIN products p ON p.id = pv.product_id
ORDER BY sl.created_at DESC
LIMIT 10;

-- 10f. Últimas 10 vendas
SELECT
  s.id,
  s.sale_number,
  s.sale_date,
  s.status,
  s.total,
  s.payment_method,
  c.name AS cliente
FROM sales s
LEFT JOIN customers c ON c.id = s.customer_id
ORDER BY s.created_at DESC
LIMIT 10;

-- 10g. Últimas 10 falhas de sync com Nuvemshop
SELECT
  event_type,
  direction,
  product_variation_id,
  external_order_id,
  stock_before,
  stock_after,
  error_message,
  created_at
FROM nuvemshop_sync_logs
WHERE success = false
ORDER BY created_at DESC
LIMIT 10;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEÇÃO 11: VERIFICAÇÕES DE CONSTRAINT E RLS
-- ─────────────────────────────────────────────────────────────────────────────

SELECT '=== SEÇÃO 11: CONSTRAINTS E RLS ===' AS titulo;

-- 11a. Constraints de CHECK e UNIQUE nas tabelas de estoque
SELECT
  tc.table_name,
  tc.constraint_name,
  tc.constraint_type,
  cc.check_clause
FROM information_schema.table_constraints tc
LEFT JOIN information_schema.check_constraints cc
  ON cc.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public'
  AND tc.table_name IN ('stock', 'stock_lots', 'stock_movements', 'sales', 'sale_items')
ORDER BY tc.table_name, tc.constraint_type;

-- 11b. Tabelas com RLS habilitado
SELECT
  tablename,
  rowsecurity AS rls_habilitado
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'products', 'product_variations', 'stock', 'stock_movements',
    'sales', 'sale_items', 'customers', 'finance_entries'
  )
ORDER BY tablename;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIM DO DIAGNÓSTICO
-- Copy the full output and share for analysis.
-- =============================================================================
