-- =============================================================================
-- Migration 20260522 — PARTE 1/2: Extensão do enum payment_method
--
-- DEVE SER EXECUTADO SEPARADAMENTE, ANTES da parte 2.
-- Motivo: ALTER TYPE ADD VALUE precisa ser committed antes de poder
-- ser referenciado em constraints ou colunas na mesma sessão.
-- (Restrição do PostgreSQL — erro "unsafe use of new value of enum type")
--
-- INSTRUÇÃO:
--   1. Cole e execute este arquivo no SQL Editor do Supabase. (clique Run)
--   2. Só depois execute 20260522_sale_payments_table.sql.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE  enumtypid = 'public.payment_method'::regtype
      AND  enumlabel = 'credit_card'
  ) THEN
    ALTER TYPE public.payment_method ADD VALUE 'credit_card';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE  enumtypid = 'public.payment_method'::regtype
      AND  enumlabel = 'debit_card'
  ) THEN
    ALTER TYPE public.payment_method ADD VALUE 'debit_card';
  END IF;
END
$$;

-- Confirmar resultado — deve listar: pix, card, cash, credit_card, debit_card
SELECT enumlabel
FROM   pg_enum
WHERE  enumtypid = 'public.payment_method'::regtype
ORDER  BY enumsortorder;
