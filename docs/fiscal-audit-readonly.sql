-- ============================================================================
-- AUDITORIA FISCAL — ERP SANTTORINI — CONSULTAS SOMENTE LEITURA
-- ============================================================================
-- Gerado em: 2026-08-04
-- Regra absoluta: TODAS as consultas abaixo são SELECT / leitura de catálogo
-- do sistema (information_schema / pg_catalog). NENHUMA delas faz
-- INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE ou CREATE.
--
-- Este arquivo NÃO foi executado contra nenhum banco. Ele existe para
-- REVISÃO MANUAL e execução posterior, mediante autorização, por alguém
-- com acesso de leitura ao Supabase self-hosted da Santtorini (idealmente
-- via um usuário com permissão apenas de leitura, não a service_role key).
--
-- Objetivo: confirmar, em dados reais, os pontos que a auditoria de
-- código (docs/fiscal-audit-report.md, docs/fiscal-risk-register.md)
-- não conseguiu fechar apenas lendo arquivos de migration — porque as
-- duas árvores de migration do projeto (supabase/migrations/ e
-- src/lib/db/migrations/) são comprovadamente divergentes e incompletas
-- em relação ao schema real (ver seção 1 do relatório principal).
-- ============================================================================


-- ============================================================================
-- SEÇÃO 1 — RECONCILIAÇÃO DO ACHADO MAIS CRÍTICO: sales.products_total NULL
-- ============================================================================
-- Objetivo: confirmar se, de fato, toda venda criada a partir de
-- 2026-06-14 tem products_total NULL, como a leitura de código sugere
-- (supabase/migrations/20260613_shipping_fiscal_ready.sql populou a
-- coluna por um dia; a reescrita seguinte de rpc_create_sale parou de
-- preenchê-la e isso nunca foi corrigido em nenhuma das 6 reescritas
-- subsequentes até a versão vigente).

-- 1.1 Visão geral por status de preenchimento
SELECT
  (sale_date < '2026-06-14') AS antes_da_regressao,
  count(*) AS total_vendas,
  count(*) FILTER (WHERE products_total IS NULL) AS com_products_total_null,
  count(*) FILTER (WHERE products_total IS NOT NULL) AS com_products_total_preenchido
FROM public.sales
GROUP BY 1
ORDER BY 1;

-- 1.2 Detalhe por dia, últimos 90 dias (para visualizar o exato dia da regressão)
SELECT
  sale_date,
  count(*) AS total_vendas,
  count(*) FILTER (WHERE products_total IS NULL) AS null_count,
  count(*) FILTER (WHERE products_total IS NOT NULL) AS preenchido_count
FROM public.sales
WHERE sale_date >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY sale_date
ORDER BY sale_date;

-- 1.3 Amostra de linhas afetadas, para inspeção manual
SELECT id, sale_number, sale_date, status, subtotal, discount_amount, products_total, total
FROM public.sales
WHERE sale_date >= '2026-06-14' AND products_total IS NULL
ORDER BY sale_date DESC
LIMIT 20;


-- ============================================================================
-- SEÇÃO 2 — UNICIDADE REAL DE products.sku E product_variations.sku_variation
-- ============================================================================
-- Objetivo: a migration supabase/migrations/202607302600_pim_product_sku_identity.sql
-- admite que products.sku NUNCA teve UNIQUE (contrariando
-- src/lib/db/migrations/000_schema_completo.sql, que afirma que tem) e que
-- a unicidade de product_variations.sku_variation nunca foi verificada.

-- 2.1 Constraints UNIQUE reais nas duas tabelas
SELECT
  conrelid::regclass AS tabela,
  conname AS nome_constraint,
  contype AS tipo, -- 'u' = unique, 'p' = primary key
  pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid IN ('public.products'::regclass, 'public.product_variations'::regclass)
  AND contype IN ('u', 'p')
ORDER BY tabela, nome_constraint;

-- 2.2 Índices (únicos ou não) nas duas tabelas, para comparar com os
-- "idx_products_sku"/"idx_products_company_sku" citados como NÃO-únicos
SELECT
  schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('products', 'product_variations')
ORDER BY tablename, indexname;

-- 2.3 Evidência direta de duplicidade de SKU (se existir hoje)
SELECT sku, company_id, count(*) AS quantidade_produtos
FROM public.products
GROUP BY sku, company_id
HAVING count(*) > 1
ORDER BY quantidade_produtos DESC
LIMIT 50;

SELECT sku_variation, count(*) AS quantidade_variacoes
FROM public.product_variations
GROUP BY sku_variation
HAVING count(*) > 1
ORDER BY quantidade_variacoes DESC
LIMIT 50;


-- ============================================================================
-- SEÇÃO 3 — RLS REAL (policies ativas), inclusive possíveis policies
-- antigas permissivas (USING (true)) nunca dropadas
-- ============================================================================
-- Objetivo: confirmar se companies/products/sales/sale_items/
-- product_variations/customers/sale_payments têm RLS habilitado, e se
-- coexistem policies antigas (src/lib/db/migrations/archive/001_rls_and_audit.sql,
-- USING(true)) com as policies novas por company_id.

-- 3.1 RLS habilitado por tabela
SELECT
  n.nspname AS schema,
  c.relname AS tabela,
  c.relrowsecurity AS rls_habilitado,
  c.relforcerowsecurity AS rls_forcado
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('companies', 'products', 'product_variations', 'sales',
                     'sale_items', 'sale_payments', 'customers', 'returns',
                     'return_items', 'exchanges', 'exchange_items',
                     'cashback_transactions', 'pedidos', 'pedidos_itens')
ORDER BY c.relname;

-- 3.2 Todas as policies ativas nessas tabelas (inclusive antigas)
SELECT
  schemaname, tablename, policyname, permissive, roles, cmd,
  qual AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE tablename IN ('companies', 'products', 'product_variations', 'sales',
                     'sale_items', 'sale_payments', 'customers', 'returns',
                     'return_items', 'exchanges', 'exchange_items',
                     'cashback_transactions', 'pedidos', 'pedidos_itens')
ORDER BY tablename, policyname;


-- ============================================================================
-- SEÇÃO 4 — SCHEMA REAL DAS TABELAS QUE PREDATAM O HISTÓRICO DE MIGRATIONS
-- ============================================================================
-- Objetivo: companies, products, customers, pedidos, pedidos_itens não
-- têm CREATE TABLE rastreado em nenhuma das duas árvores de migration —
-- precisamos da estrutura real de colunas antes de desenhar qualquer
-- extensão fiscal sobre elas. Isto substitui parcialmente a necessidade
-- de um pg_dump --schema-only completo (recomendado em separado).

SELECT table_name, column_name, ordinal_position, data_type,
       character_maximum_length, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('companies', 'products', 'product_variations', 'customers',
                      'sales', 'sale_items', 'sale_payments', 'pedidos',
                      'pedidos_itens', 'produto_map', 'returns', 'return_items',
                      'exchanges', 'exchange_items', 'cashback_transactions',
                      'stock_lots', 'stock_balances', 'audit_logs', 'users',
                      'authorization_tokens')
ORDER BY table_name, ordinal_position;

-- 4.1 Foreign keys de todas essas tabelas
SELECT
  tc.table_name, kcu.column_name,
  ccu.table_name AS referenced_table, ccu.column_name AS referenced_column,
  tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name IN ('companies', 'products', 'product_variations', 'customers',
                         'sales', 'sale_items', 'sale_payments', 'pedidos',
                         'pedidos_itens', 'produto_map')
ORDER BY tc.table_name;

-- 4.2 CHECK constraints dessas tabelas (para ver enforcement real de NCM/CEST/origem etc.)
SELECT
  conrelid::regclass AS tabela, conname AS nome_constraint,
  pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid::regclass::text IN ('public.products', 'public.product_variations',
                                    'public.customers', 'public.sales', 'public.sale_items',
                                    'public.sale_payments')
ORDER BY tabela;


-- ============================================================================
-- SEÇÃO 5 — INVENTÁRIO GERAL DE SCHEMA (item 24 do escopo da auditoria)
-- ============================================================================

-- 5.1 Todos os schemas do banco
SELECT schema_name FROM information_schema.schemata ORDER BY schema_name;

-- 5.2 Todas as tabelas do schema public, com contagem aproximada de linhas
SELECT
  c.relname AS tabela,
  c.reltuples::bigint AS linhas_aprox
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY tabela;

-- 5.3 Todos os enums (CREATE TYPE ... AS ENUM) e seus valores
SELECT
  t.typname AS enum_name,
  e.enumlabel AS valor,
  e.enumsortorder AS ordem
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
ORDER BY enum_name, ordem;

-- 5.4 Todas as views (inclusive materialized views)
SELECT table_name AS view_name, 'view' AS tipo
FROM information_schema.views
WHERE table_schema = 'public'
UNION ALL
SELECT matviewname AS view_name, 'materialized_view' AS tipo
FROM pg_matviews
WHERE schemaname = 'public'
ORDER BY view_name;

-- 5.5 Todas as functions/procedures customizadas (exclui as internas do Postgres/extensões)
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS argumentos,
  t.typname AS retorno,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_type t ON t.oid = p.prorettype
WHERE n.nspname = 'public'
ORDER BY function_name;

-- 5.6 Todos os triggers
SELECT
  event_object_table AS tabela,
  trigger_name,
  event_manipulation AS evento,
  action_timing AS momento,
  action_statement AS acao
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY tabela, trigger_name;

-- 5.7 Todos os índices do schema public
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- 5.8 Todas as foreign keys do schema public (visão completa, não só as tabelas-chave da seção 4)
SELECT
  tc.table_name, kcu.column_name,
  ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
ORDER BY tc.table_name;

-- 5.9 Todas as policies de RLS do schema public (visão completa)
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 5.10 Todas as tabelas com RLS habilitado vs. desabilitado (visão completa)
SELECT
  c.relname AS tabela,
  c.relrowsecurity AS rls_habilitado
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY rls_habilitado DESC, tabela;


-- ============================================================================
-- SEÇÃO 6 — TABELAS ESPECIFICAMENTE RELACIONADAS A NUVEMSHOP
-- ============================================================================
-- Objetivo: pedidos/pedidos_itens/produto_map/nuvemshop_sync_logs não têm
-- CREATE TABLE rastreado em nenhuma migration — confirmar estrutura real.

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('pedidos', 'pedidos_itens', 'produto_map', 'nuvemshop_sync_logs')
ORDER BY table_name, ordinal_position;

-- 6.1 Constraint UNIQUE real em pedidos (a auditoria de código encontrou
-- apenas um índice não-único idx_pedidos_external_source_lock, não uma
-- constraint UNIQUE em (external_id, source) — confirmar)
SELECT conrelid::regclass AS tabela, conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.pedidos'::regclass;


-- ============================================================================
-- SEÇÃO 7 — AUTENTICAÇÃO / USUÁRIOS / RBAC (leitura apenas de estrutura,
-- nunca de dados de usuário sensíveis)
-- ============================================================================

-- 7.1 Estrutura da tabela users (papéis/roles)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users'
ORDER BY ordinal_position;

-- 7.2 Contagem de usuários por role (sem expor dados pessoais)
SELECT role, count(*) AS quantidade
FROM public.users
GROUP BY role
ORDER BY role;

-- 7.3 Confirmar quantas empresas existem de fato hoje (valida a suposição
-- de single-tenant operacional discutida no relatório)
SELECT id, name, slug, plan, active, created_at FROM public.companies ORDER BY id;


-- ============================================================================
-- SEÇÃO 8 — LOGS E AUDITORIA
-- ============================================================================

-- 8.1 Estrutura de audit_logs (reaproveitável para trilha fiscal)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'audit_logs'
ORDER BY ordinal_position;

-- 8.2 Volume de audit_logs por mês (para avaliar se a retenção de 24
-- meses citada em TECHNICAL_NOTES.md já é um problema prático)
SELECT date_trunc('month', ts) AS mes, count(*) AS eventos
FROM public.audit_logs
GROUP BY 1
ORDER BY 1 DESC
LIMIT 24;


-- ============================================================================
-- FIM DO ARQUIVO
-- ============================================================================
-- Lembrete: nenhuma consulta acima deve ser alterada para incluir
-- INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE. Qualquer necessidade de
-- escrita no banco deve ser tratada como uma migration formal, proposta
-- separadamente e apenas após autorização expressa, conforme a regra de
-- segurança desta auditoria.
