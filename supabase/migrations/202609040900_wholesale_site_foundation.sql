-- =============================================================================
-- 202609040900_wholesale_site_foundation.sql
--
-- Site de Atacado — Fase 8. Fundação mínima de schema pros 3 gaps reais
-- encontrados na auditoria curta desta fase (nenhuma tabela de catálogo/
-- estoque/venda nova — tudo isso já existe e é reaproveitado):
--
--   1. `customers` não tinha como se ligar a uma identidade de login —
--      `auth_user_id` (nullable, único) liga uma linha de `customers` a
--      um `auth.users` real quando o cliente cria conta no site. Nunca
--      obrigatório (cliente de balcão continua sem login).
--   2. `customers` não suportava CNPJ estruturalmente — auditoria
--      confirmou que só `sale_recipients` (snapshot POR VENDA) tinha essa
--      coluna. `customers.cnpj` é a identidade COMERCIAL/CRM (útil pra
--      "lembrar" o CNPJ do cliente atacadista entre pedidos, acelerando
--      checkout futuro — item 16 do pedido) — DISTINTO do snapshot fiscal
--      por venda, que continua em `sale_recipients` e nunca é substituído
--      por esta coluna.
--   3. Pagamento — auditoria confirmou ZERO integração de gateway
--      (Pix/cartão) em todo o projeto (nenhuma referência a Mercado Pago/
--      PagSeguro/Stripe/Pagar.me/Asaas/Gerencianet em nenhum lugar do
--      código). Por instrução explícita ("não crie checkout falso"), a
--      v1 do checkout cria o pedido com pagamento NEGOCIADO/faturado —
--      `payment_method` ganha o valor 'invoice', usado exclusivamente
--      pelo checkout do site de atacado pra representar "cobrança
--      combinada com o time comercial, fora do sistema" — nunca finge
--      cobrar Pix/cartão sem infraestrutura real por trás. Mesmo padrão
--      já usado 2x antes neste enum (credit_card/debit_card,
--      20260522_sale_payments.sql) — ALTER TYPE ADD VALUE dentro de
--      DO $$ com checagem IF NOT EXISTS, nunca referenciado nesta mesma
--      migration (restrição do Postgres: precisa commitar antes de usar).
--
-- Idempotência de checkout (seção 39 do pedido — duplo clique/duplo
-- submit não pode criar duas vendas): `wholesale_checkout_idempotency`,
-- UNIQUE(idempotency_key) — o checkout faz INSERT ANTES de criar a venda;
-- uma segunda tentativa com a MESMA chave falha por unique_violation e o
-- service devolve o resultado da primeira tentativa (ou "ainda
-- processando", se a primeira ainda não terminou) — nunca cria uma
-- segunda venda. Mesmo princípio de claim atômico já usado em
-- rpc_claim_fiscal_emission (Fase Fiscal 3B), sem reaproveitar aquela
-- tabela (é especificamente de emissão fiscal, escopo diferente).
-- =============================================================================

-- ─── 1. customers.auth_user_id + customers.cnpj ─────────────────────────────

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cnpj TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_auth_user_id ON public.customers(auth_user_id) WHERE auth_user_id IS NOT NULL;

COMMENT ON COLUMN public.customers.auth_user_id IS 'Site de Atacado — liga esta linha a um auth.users real (login de cliente B2B). Nullable: cliente de balcão nunca precisa disso. Nunca usado por RBAC de staff (public.users é uma tabela separada).';
COMMENT ON COLUMN public.customers.cnpj IS 'Identidade COMERCIAL/CRM do cliente (empresa atacadista) — distinto do snapshot fiscal por venda em sale_recipients.cnpj, que nunca é substituído por este valor. Nullable: cliente PF continua só com cpf.';

-- ─── 2. payment_method ganha 'invoice' ──────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE  enumtypid = 'public.payment_method'::regtype
      AND  enumlabel = 'invoice'
  ) THEN
    ALTER TYPE public.payment_method ADD VALUE 'invoice';
  END IF;
END
$$;

-- ─── 3. Idempotência de checkout ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wholesale_checkout_idempotency (
  id                SERIAL       PRIMARY KEY,
  idempotency_key   UUID         NOT NULL,
  company_id        INT          NOT NULL REFERENCES public.companies(id),
  customer_id       INT          REFERENCES public.customers(id),
  sale_id           INT          REFERENCES public.sales(id),
  status            TEXT         NOT NULL DEFAULT 'processing'
                       CHECK (status IN ('processing', 'completed', 'failed')),
  error_message     TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,

  CONSTRAINT uq_wholesale_checkout_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wholesale_checkout_idempotency_company ON public.wholesale_checkout_idempotency(company_id);

ALTER TABLE public.wholesale_checkout_idempotency ENABLE ROW LEVEL SECURITY;
-- Deny-by-default — só service_role acessa (mesmo padrão de toda a infra
-- fiscal/integrações desta base). Toda leitura/escrita passa pela rota de
-- checkout (admin client), nunca pelo browser diretamente.
REVOKE ALL ON public.wholesale_checkout_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_checkout_idempotency TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_checkout_idempotency_id_seq TO service_role;

COMMENT ON TABLE public.wholesale_checkout_idempotency IS 'Site de Atacado — garante que um duplo clique/duplo submit no checkout nunca cria duas vendas. INSERT com a chave do cliente ANTES de chamar createSale(); UNIQUE(idempotency_key) rejeita a segunda tentativa concorrente.';

-- =============================================================================
-- Smoke tests
-- =============================================================================

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customers' AND column_name IN ('auth_user_id', 'cnpj');
-- Esperado: 2 linhas

SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.payment_method'::regtype ORDER BY enumsortorder;
-- Esperado: pix, card, cash, credit_card, debit_card, invoice (ordem pode variar, 'invoice' deve estar presente)

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'wholesale_checkout_idempotency';
-- Esperado: 1 linha

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP TABLE IF EXISTS public.wholesale_checkout_idempotency;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS auth_user_id,
  DROP COLUMN IF EXISTS cnpj;

-- Remover um valor de enum não é suportado nativamente pelo Postgres —
-- reverter 'invoice' exigiria recriar o tipo inteiro (mesmo custo/risco
-- já documentado nas duas adições anteriores deste enum). Não incluído
-- automaticamente — nenhuma linha usa 'invoice' se este rollback rodar
-- antes do checkout do site de atacado entrar em uso real.
*/
