-- =============================================================================
-- 202610011000_finance_entries_payment_status.sql
--
-- Lançamentos futuros/pendentes (contas a pagar/receber).
--
-- Por quê: finance_entries não distingue "pendente" de "registro antigo/
-- automático sem info de pagamento" — ambos têm paid_at NULL, e o Fluxo de
-- Caixa trata paid_at NULL como realizado em reference_date (legado). Sem um
-- marcador explícito, uma conta pendente entraria como caixa realizado.
--
-- Backward-compatible: coluna NOT NULL DEFAULT 'paid' => toda linha existente
-- (e todo INSERT automático: vendas, estoque, marketing, regularização)
-- mantém exatamente a semântica atual. Nenhum dado histórico é reinterpretado.
-- Vencimento = reference_date (já existente); data do pagamento = paid_at.
-- Idempotente.
-- =============================================================================

ALTER TABLE public.finance_entries
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'paid';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.finance_entries'::regclass
                   AND conname = 'fe_payment_status_valid') THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_payment_status_valid
      CHECK (payment_status IN ('paid', 'pending'));
  END IF;

  -- Pendente nunca tem pagamento registrado nem vínculo com o Caixa.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.finance_entries'::regclass
                   AND conname = 'fe_pending_has_no_payment') THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_pending_has_no_payment
      CHECK (payment_status <> 'pending'
             OR (paid_at IS NULL AND payment_method IS NULL AND cash_movement_id IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.finance_entries.payment_status IS
  'paid = realizado (inclui legado com paid_at NULL, realizado em reference_date); pending = obrigação futura/não paga, fora do caixa realizado. reference_date = vencimento/competência; paid_at = data real do pagamento.';

CREATE INDEX IF NOT EXISTS idx_fe_pending_due
  ON public.finance_entries (company_id, reference_date)
  WHERE payment_status = 'pending';
