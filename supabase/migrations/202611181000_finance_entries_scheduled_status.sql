-- =============================================================================
-- 202611181000_finance_entries_scheduled_status.sql
--
-- Pagamento AGENDADO de despesas (boleto programado no banco, ainda não
-- confirmado).
--
-- payment_status passa a aceitar 'scheduled' além de 'paid' e 'pending'.
-- Interpretação de paid_at conforme o status (NÃO há coluna nova):
--   pending   -> paid_at NULL
--   scheduled -> paid_at = data PROGRAMADA (pode ser futura)
--   paid      -> paid_at = data EFETIVA (a aplicação impede data futura)
-- reference_date continua sendo vencimento/competência (DRE).
--
-- NÃO altera nenhuma linha existente. Backward-compatible: default 'paid'
-- permanece; inserções automáticas (vendas, estoque, marketing...) e registros
-- legados com paid_at NULL não são tocados.
--
-- Constraints mantidas sem alteração:
--   fe_pending_has_no_payment, fe_payment_method_paid_at_together,
--   fe_cash_movement_requires_cash_method, fe_cash_movement_id_unique.
--
-- ANTES DE APLICAR: rodar docs/sql/verificar-constraints-finance-entries.sql
-- em produção e conferir se bate com o esperado (guarda abaixo aborta se não).
-- Idempotente.
-- =============================================================================

DO $$
BEGIN
  -- Guarda: a migration 202610011000 precisa ter sido aplicada.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'finance_entries'
      AND column_name = 'payment_status'
  ) THEN
    RAISE EXCEPTION 'finance_entries.payment_status não existe: aplique 202610011000 antes.';
  END IF;

  -- Substitui o CHECK de valores válidos (text + CHECK, não enum).
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.finance_entries'::regclass
               AND conname = 'fe_payment_status_valid') THEN
    ALTER TABLE public.finance_entries DROP CONSTRAINT fe_payment_status_valid;
  END IF;
  ALTER TABLE public.finance_entries
    ADD CONSTRAINT fe_payment_status_valid
    CHECK (payment_status IN ('paid', 'pending', 'scheduled'));

  -- Agendado: despesa, com forma de pagamento e data programada, sem vínculo
  -- com o Caixa (cash_movement_id só nasce na liquidação/regularização).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.finance_entries'::regclass
                   AND conname = 'fe_scheduled_requires_payment_plan') THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_scheduled_requires_payment_plan
      CHECK (payment_status <> 'scheduled'
             OR (type = 'expense'
                 AND paid_at IS NOT NULL
                 AND payment_method IS NOT NULL
                 AND cash_movement_id IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.finance_entries.payment_status IS
  'paid = realizado (inclui legado com paid_at NULL, realizado em reference_date); pending = obrigação não paga e sem agendamento; scheduled = despesa com pagamento programado (paid_at = data programada), fora do caixa realizado. Nunca vira paid automaticamente. reference_date = vencimento/competência.';

CREATE INDEX IF NOT EXISTS idx_fe_scheduled_due
  ON public.finance_entries (company_id, paid_at)
  WHERE payment_status = 'scheduled';
