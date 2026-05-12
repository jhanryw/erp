-- Separação entre status do canal externo e status operacional interno
-- channel_status : valor real vindo da Nuvemshop (created, paid, cancelled, …)
-- operational_status : valor interno do ERP (pronto, em_separacao, enviado, …)

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS channel_status      TEXT,
  ADD COLUMN IF NOT EXISTS operational_status  TEXT;

-- Retrocompatibilidade: popular channel_status com o valor atual de status
-- para linhas já existentes que usavam status = 'pronto' ou status = rawStatus
UPDATE public.pedidos
SET channel_status = status
WHERE channel_status IS NULL AND status IS NOT NULL;
