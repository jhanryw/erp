-- Migration 020: Tabela de taxas de pagamento editaveis por empresa

CREATE TABLE IF NOT EXISTS public.payment_fee_settings (
  id              SERIAL PRIMARY KEY,
  company_id      INT            NOT NULL,
  payment_method  TEXT           NOT NULL,
  installments    INT            NOT NULL DEFAULT 1,
  label           TEXT           NOT NULL,
  fee_percentage  NUMERIC(6,4)   NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, payment_method, installments)
);

CREATE INDEX IF NOT EXISTS idx_pfs_company ON payment_fee_settings(company_id);

GRANT SELECT ON payment_fee_settings TO authenticated;
GRANT ALL    ON payment_fee_settings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE payment_fee_settings_id_seq TO service_role;

-- Seed: busca company_id real via subquery (sem DO $$ para evitar problemas de encoding)
INSERT INTO public.payment_fee_settings (company_id, payment_method, installments, label, fee_percentage)
SELECT c.company_id, t.method, t.inst, t.lbl, 0
FROM (
  SELECT DISTINCT company_id FROM public.users WHERE company_id IS NOT NULL LIMIT 1
) AS c
CROSS JOIN (VALUES
  ('pix',            1,  'PIX'),
  ('card',           1,  'Cartao 1x'),
  ('card',           2,  'Cartao 2x'),
  ('card',           3,  'Cartao 3x'),
  ('card',           4,  'Cartao 4x'),
  ('card',           5,  'Cartao 5x'),
  ('card',           6,  'Cartao 6x'),
  ('card',           7,  'Cartao 7x'),
  ('card',           8,  'Cartao 8x'),
  ('card',           9,  'Cartao 9x'),
  ('card',           10, 'Cartao 10x'),
  ('card',           11, 'Cartao 11x'),
  ('card',           12, 'Cartao 12x'),
  ('nuvemshop_pix',  1,  'Nuvemshop PIX'),
  ('nuvemshop_card', 1,  'Nuvemshop Cartao')
) AS t(method, inst, lbl)
ON CONFLICT (company_id, payment_method, installments) DO NOTHING;
