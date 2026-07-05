-- =============================================================================
-- 20260705_marketing_costs_finance_entries_sync.sql
--
-- Sincroniza marketing_costs → finance_entries.
--
-- Problema: custos de marketing eram registrados apenas em marketing_costs,
-- ficando invisíveis para a DRE e dashboard financeiro (que leem finance_entries).
-- O campo marketing_cost_id já existia em finance_entries mas nunca foi populado.
--
-- O que esta migration faz:
--   1. Aborta se detectar duplicidade em finance_entries.marketing_cost_id
--   2. Backfill: cria finance_entry para todo marketing_cost sem vínculo
--   3. Adiciona UNIQUE em finance_entries.marketing_cost_id
-- =============================================================================

DO $$
DECLARE
  v_dup_count INT;
BEGIN

  -- ── Passo 1: Verificar duplicidades existentes ─────────────────────────────
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT marketing_cost_id
    FROM public.finance_entries
    WHERE marketing_cost_id IS NOT NULL
    GROUP BY marketing_cost_id
    HAVING COUNT(*) > 1
  ) dupes;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'Abortado: existem % marketing_cost_id(s) duplicados em finance_entries. '
      'Resolva manualmente antes de aplicar esta migration.',
      v_dup_count;
  END IF;

  -- ── Passo 2: Backfill ──────────────────────────────────────────────────────
  -- Para cada marketing_cost que ainda não tem finance_entry vinculada,
  -- cria um lançamento de despesa de marketing.
  INSERT INTO public.finance_entries (
    type,
    category,
    description,
    amount,
    reference_date,
    company_id,
    marketing_cost_id,
    created_by,
    created_at
  )
  SELECT
    'expense'::public.finance_entry_type,
    'marketing'::public.finance_category,
    mc.description,
    mc.amount,
    mc.cost_date,
    mc.company_id,
    mc.id,
    mc.created_by,
    mc.created_at
  FROM public.marketing_costs mc
  LEFT JOIN public.finance_entries fe ON fe.marketing_cost_id = mc.id
  WHERE fe.id IS NULL;

  RAISE NOTICE 'Backfill concluído.';

END $$;

-- ── Passo 3: Adicionar UNIQUE constraint ──────────────────────────────────────
-- Garante que cada marketing_cost tenha no máximo uma finance_entry vinculada.
-- (NULL não participa do UNIQUE — campo pode ser NULL para lançamentos manuais)
ALTER TABLE public.finance_entries
  ADD CONSTRAINT uq_finance_entry_marketing_cost
  UNIQUE (marketing_cost_id);
