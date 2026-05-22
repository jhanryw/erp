-- =============================================================================
-- Validação pós-migration: 20260522_sale_payments
--
-- Execute no SQL Editor do Supabase APÓS aplicar a migration.
-- Cada bloco deve retornar o resultado esperado indicado no comentário.
-- Se algum falhar, NÃO aplique o rpc_create_sale ainda — investigue primeiro.
-- =============================================================================

-- =============================================================================
-- 1. Enum payment_method — verificar valores
-- Esperado: pix | card | cash | credit_card | debit_card (em qualquer ordem)
-- =============================================================================
SELECT enumlabel
FROM   pg_enum
WHERE  enumtypid = 'public.payment_method'::regtype
ORDER  BY enumsortorder;

-- =============================================================================
-- 2. Tabela sale_payments — verificar existência e colunas
-- Esperado: 16 linhas (uma por coluna)
-- =============================================================================
SELECT column_name, data_type, is_nullable, column_default
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'sale_payments'
ORDER  BY ordinal_position;

-- =============================================================================
-- 3. Constraints da tabela — verificar todas as 9 constraints
-- Esperado: sp_cash_only_change, sp_change_method_required, sp_change_method_valid,
--           sp_change_nonnegative, sp_amount_tendered_gte, sp_net_amount_eq,
--           sp_net_amount_positive, sp_installments_credit_only,
--           sp_installments_positive, sp_fee_nonnegative
-- =============================================================================
SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.sale_payments'::regclass
  AND  contype  = 'c'
ORDER  BY conname;

-- =============================================================================
-- 4. Índices — verificar 3 índices criados
-- Esperado: idx_sale_payments_sale_id, idx_sale_payments_company_date,
--           idx_sale_payments_method
-- =============================================================================
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public'
  AND  tablename  = 'sale_payments'
ORDER  BY indexname;

-- =============================================================================
-- 5. Função helper — verificar existência
-- Esperado: 1 linha com get_dominant_payment_method
-- =============================================================================
SELECT routine_name, routine_type, security_type
FROM   information_schema.routines
WHERE  routine_schema = 'public'
  AND  routine_name   = 'get_dominant_payment_method';

-- =============================================================================
-- 6. RLS — verificar política ativa
-- Esperado: rowsecurity = true, policy "sale_payments_company" existindo
-- =============================================================================
SELECT relname, relrowsecurity AS rowsecurity
FROM   pg_class
WHERE  relname = 'sale_payments'
  AND  relnamespace = 'public'::regnamespace;

SELECT policyname, cmd, roles, qual
FROM   pg_policies
WHERE  schemaname = 'public'
  AND  tablename  = 'sale_payments';

-- =============================================================================
-- 7. Teste funcional — get_dominant_payment_method com venda existente
--
-- Substitua <ID_DE_UMA_VENDA_EXISTENTE> pelo id de qualquer venda no banco.
-- Esperado: retorna o payment_method dessa venda (path legado / fallback).
-- =============================================================================
SELECT public.get_dominant_payment_method(<ID_DE_UMA_VENDA_EXISTENTE>);

-- =============================================================================
-- 8. Teste funcional — constraints de integridade
--
-- Cada INSERT abaixo deve FALHAR com a constraint indicada.
-- Se algum INSERIR sem erro, há problema na constraint.
-- ATENÇÃO: estes inserts são intencionalmente inválidos — vão dar erro, tudo certo.
-- =============================================================================

-- 8a. Troco em método não-cash → viola sp_cash_only_change
-- Esperado: ERROR — new row violates check constraint "sp_cash_only_change"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, change_amount, change_method, net_amount)
SELECT id, company_id, 'pix', 100, 20, 'cash', 80
FROM   public.sales LIMIT 1;

-- 8b. Troco sem change_method → viola sp_change_method_required
-- Esperado: ERROR — new row violates check constraint "sp_change_method_required"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, change_amount, net_amount)
SELECT id, company_id, 'cash', 100, 20, 80
FROM   public.sales LIMIT 1;

-- 8c. change_method inválido → viola sp_change_method_valid
-- Esperado: ERROR — new row violates check constraint "sp_change_method_valid"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, change_amount, change_method, net_amount)
SELECT id, company_id, 'cash', 100, 20, 'transferencia', 80
FROM   public.sales LIMIT 1;

-- 8d. amount_tendered < net_amount → viola sp_amount_tendered_gte
-- Esperado: ERROR — new row violates check constraint "sp_amount_tendered_gte"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, net_amount)
SELECT id, company_id, 'pix', 50, 80
FROM   public.sales LIMIT 1;

-- 8e. net_amount incoerente → viola sp_net_amount_eq
-- Esperado: ERROR — new row violates check constraint "sp_net_amount_eq"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, change_amount, net_amount)
SELECT id, company_id, 'cash', 100, 5, 80
FROM   public.sales LIMIT 1;

-- 8f. Parcelamento em Pix → viola sp_installments_credit_only
-- Esperado: ERROR — new row violates check constraint "sp_installments_credit_only"
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, net_amount, installments)
SELECT id, company_id, 'pix', 100, 100, 3
FROM   public.sales LIMIT 1;

-- =============================================================================
-- 9. Teste funcional — INSERT válido (smoke test)
--
-- Deve inserir 1 linha sem erro e depois fazer rollback para não sujar o banco.
-- Esperado: "INSERT 0 1" seguido de ROLLBACK.
-- =============================================================================
BEGIN;
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, change_amount, change_method, net_amount,
   installments, fee_percentage, fee_amount, metadata, created_by)
SELECT
  s.id,
  s.company_id,
  'cash'::public.payment_method,
  100.00,   -- amount_tendered
  20.00,    -- change_amount
  'pix',    -- change_method
  80.00,    -- net_amount
  1,        -- installments
  0,        -- fee_percentage
  0,        -- fee_amount
  '{"test": true}'::jsonb,
  s.seller_id
FROM public.sales s
LIMIT 1;

-- Confirmar que a linha existe antes do rollback
SELECT id, method, amount_tendered, change_amount, change_method, net_amount
FROM   public.sale_payments
ORDER  BY created_at DESC
LIMIT  1;

ROLLBACK;

-- Confirmar que não ficou nada no banco
SELECT COUNT(*) AS deve_ser_zero FROM public.sale_payments;

-- =============================================================================
-- 10. Teste get_dominant_payment_method — path sale_payments (novo)
--
-- Insere dois pagamentos em uma venda de teste, verifica o dominante,
-- depois faz rollback.
-- =============================================================================
BEGIN;
INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, net_amount, created_by)
SELECT id, company_id, 'pix'::public.payment_method, 150, 150, seller_id
FROM   public.sales LIMIT 1;

INSERT INTO public.sale_payments
  (sale_id, company_id, method, amount_tendered, net_amount, created_by)
SELECT id, company_id, 'cash'::public.payment_method, 130, 130, seller_id
FROM   public.sales LIMIT 1;

-- Esperado: 'pix' (maior net_amount = 150)
SELECT public.get_dominant_payment_method(
  (SELECT id FROM public.sales ORDER BY id DESC LIMIT 1)
);
ROLLBACK;

-- =============================================================================
-- Se todos os testes acima passaram:
--   ✓ enum tem credit_card e debit_card
--   ✓ tabela sale_payments existe com colunas corretas
--   ✓ todas as constraints estão ativas
--   ✓ índices criados
--   ✓ função helper funciona com fallback e com sale_payments
--   ✓ RLS ativa
--   → Pode prosseguir para a alteração do rpc_create_sale
-- =============================================================================
