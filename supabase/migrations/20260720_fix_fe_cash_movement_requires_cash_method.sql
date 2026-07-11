-- =============================================================================
-- 20260720_fix_fe_cash_movement_requires_cash_method.sql
--
-- Corrige a constraint fe_cash_movement_requires_cash_method (criada em
-- 20260710_02_finance_entries_payment_fields.sql), que se mostrou rígida
-- demais ao rodar a regularização histórica (Entrega 3) contra dados reais.
--
-- ANTES:
--   CHECK (cash_movement_id IS NULL OR payment_method = 'cash')
--
-- DEPOIS:
--   CHECK (cash_movement_id IS NULL OR payment_method IS NOT NULL)
--
-- POR QUE — cash_movement_id tem dois usos legítimos nesta fase do ERP:
--
--   1. Vínculo com uma movimentação FÍSICA futura, criada automaticamente
--      quando uma despesa nova é paga em dinheiro (Entrega 4, ainda não
--      implementada). Nesse caso o método É sempre 'cash' por construção do
--      próprio fluxo — mas essa garantia pertence à RPC/regra de domínio
--      daquele fluxo futuro, não a esta constraint genérica da tabela.
--
--   2. Vínculo de PROVENIÊNCIA com movimentações históricas registradas pela
--      antiga tela do Caixa (rpc_regularizar_despesa_caixa, Entrega 3) —
--      essas movimentações têm o método real que a atendente usou antes do
--      bloqueio da Entrega 1, que inclui PIX e cartão, não só dinheiro.
--
--   A presença de cash_movement_id NÃO significa automaticamente "pagamento
--   em dinheiro" — o método real de pagamento continua sendo determinado
--   exclusivamente por payment_method, nunca inferido a partir de
--   cash_movement_id estar preenchido ou não. A única garantia que esta
--   constraint deve manter é: nunca existir um vínculo de Caixa sem saber
--   como a despesa foi paga (payment_method IS NOT NULL).
--
-- NÃO ALTERA: dados de nenhuma linha, as outras duas constraints
-- (fe_payment_method_paid_at_together, fe_cash_movement_id_unique), o
-- índice idx_fe_paid_at, a RPC rpc_regularizar_despesa_caixa, cash_movements
-- ou cash_register_sessions. Sem backfill.
--
-- IDEMPOTENTE e DEFENSIVA: confirma que a constraint antiga existe antes de
-- removê-la (DROP aponta só para este nome específico); recria imediatamente
-- na mesma transação (migração é transacional por padrão no Postgres — se
-- qualquer passo falhar, nada é aplicado).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_entries'::regclass
      AND conname  = 'fe_cash_movement_requires_cash_method'
  ) THEN
    ALTER TABLE public.finance_entries
      DROP CONSTRAINT fe_cash_movement_requires_cash_method;
  END IF;

  ALTER TABLE public.finance_entries
    ADD CONSTRAINT fe_cash_movement_requires_cash_method
    CHECK (cash_movement_id IS NULL OR payment_method IS NOT NULL);
END $$;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.finance_entries'::regclass
  AND  conname  = 'fe_cash_movement_requires_cash_method';
-- Esperado: 1 linha, definition = 'CHECK (((cash_movement_id IS NULL) OR (payment_method IS NOT NULL)))'

-- =============================================================================
-- FIM DA MIGRATION 20260720
-- =============================================================================
