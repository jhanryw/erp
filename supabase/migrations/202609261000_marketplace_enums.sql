-- =============================================================================
-- 202609261000_marketplace_enums.sql — Fase 3 Mercado Livre (pedidos)
--
-- Valores novos de ENUM, em migration PRÓPRIA: um valor adicionado por
-- ALTER TYPE ... ADD VALUE só pode ser USADO depois do COMMIT (views e
-- constraints da migration seguinte, 202609261100, dependem deles).
--
--   finance_category.marketplace_fee — tarifa/comissão REAL de marketplace
--     (genérica: ML hoje, outros marketplaces depois). Despesa variável de
--     venda — nunca 'operational'.
--   payment_method.digital_wallet — saldo/crédito em carteira digital
--     (ML: account_money, digital_currency/consumer_credits do Mercado Pago).
--   payment_method.boleto — boleto bancário (ML: payment_type 'ticket').
--
-- O método ORIGINAL do marketplace fica sempre em sale_payments.metadata;
-- estes valores genéricos só existem para não distorcer a forma de
-- pagamento (ex.: gravar saldo MP como 'pix').
--
-- 100% aditiva e idempotente. Nenhuma linha existente muda.
-- =============================================================================

ALTER TYPE public.finance_category ADD VALUE IF NOT EXISTS 'marketplace_fee';
ALTER TYPE public.payment_method   ADD VALUE IF NOT EXISTS 'digital_wallet';
ALTER TYPE public.payment_method   ADD VALUE IF NOT EXISTS 'boleto';
