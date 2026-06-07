-- Migration: 20260606_customer_anonymous_flag.sql
-- Adiciona flag is_anonymous em customers para identificar clientes avulsos
-- que não devem receber cashback, mensagens automáticas ou aparecer em listas de marketing.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN NOT NULL DEFAULT FALSE;

-- Marca o cliente avulso (CPF 111.111.111-11)
UPDATE customers
SET is_anonymous = TRUE
WHERE cpf = '11111111111';

-- Índice parcial para consultas que filtram clientes reais
CREATE INDEX IF NOT EXISTS idx_customers_not_anonymous
  ON customers (id)
  WHERE is_anonymous = FALSE;
