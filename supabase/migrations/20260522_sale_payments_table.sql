-- =============================================================================
-- Migration 20260522 — PARTE 2/2: Tabela sale_payments
--
-- DEPENDE da parte 1 já ter sido executada e commitada:
--   20260522_sale_payments.sql (extensão do enum)
--
-- O QUE FAZ:
--   - Cria tabela sale_payments com todas as constraints
--   - Cria 3 índices
--   - Cria função get_dominant_payment_method (com fallback para legado)
--   - Habilita RLS com política para admin/gerente
--   - Grants
--
-- IDEMPOTENTE: sim (IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS)
-- ROLLBACK: DROP TABLE public.sale_payments CASCADE;
--           DROP FUNCTION IF EXISTS public.get_dominant_payment_method(int);
-- =============================================================================

-- =============================================================================
-- PARTE 2a — Tabela sale_payments
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sale_payments (
  id               BIGSERIAL                  PRIMARY KEY,

  -- Vínculo
  sale_id          INT                        NOT NULL
                     REFERENCES public.sales(id) ON DELETE CASCADE,
  company_id       INT                        NOT NULL
                     REFERENCES public.companies(id),

  -- Forma de pagamento (usa enum já estendido na parte 1)
  -- Valores válidos: pix | cash | credit_card | debit_card
  -- 'card' nunca gerado pelo novo fluxo; reservado para legado
  method           public.payment_method      NOT NULL,

  -- Valores financeiros
  -- amount_tendered : quanto o cliente entregou (>= net_amount)
  -- change_amount   : troco devolvido (só quando method = 'cash')
  -- change_method   : forma do troco — 'cash' ou 'pix'
  -- net_amount      : valor líquido aplicado à venda
  -- Invariante: ROUND(net_amount,2) = ROUND(amount_tendered - change_amount, 2)
  amount_tendered  NUMERIC(10,2)              NOT NULL,
  change_amount    NUMERIC(10,2)              NOT NULL DEFAULT 0,
  change_method    TEXT,
  net_amount       NUMERIC(10,2)              NOT NULL,

  -- Cartão
  installments     INT                        NOT NULL DEFAULT 1,
  card_brand       TEXT,       -- 'visa' | 'mastercard' | 'elo' | 'hipercard' | etc.
  acquirer         TEXT,       -- 'stone' | 'cielo' | 'pagseguro' | etc.

  -- Taxa (preenchida automaticamente pelo rpc_create_sale via payment_fee_settings)
  fee_percentage   NUMERIC(6,4)               NOT NULL DEFAULT 0,
  fee_amount       NUMERIC(10,2)              NOT NULL DEFAULT 0,

  -- Extensibilidade: NSU, auth_code, terminal_id, dados de adquirente
  metadata         JSONB                      NOT NULL DEFAULT '{}',

  -- Rastreabilidade
  created_by       UUID                       REFERENCES public.users(id),
  created_at       TIMESTAMPTZ                NOT NULL DEFAULT NOW(),

  -- ─── Constraints de integridade ─────────────────────────────────────────

  -- Troco só em dinheiro
  CONSTRAINT sp_cash_only_change
    CHECK (change_amount = 0 OR method = 'cash'),

  -- change_method obrigatório quando há troco
  CONSTRAINT sp_change_method_required
    CHECK (change_amount = 0 OR change_method IS NOT NULL),

  -- change_method aceita apenas valores conhecidos
  CONSTRAINT sp_change_method_valid
    CHECK (change_method IS NULL OR change_method IN ('cash', 'pix')),

  -- Troco nunca negativo
  CONSTRAINT sp_change_nonnegative
    CHECK (change_amount >= 0),

  -- Valor entregue >= valor cobrado (excesso = troco)
  CONSTRAINT sp_amount_tendered_gte
    CHECK (amount_tendered >= net_amount),

  -- Invariante matemática (tolerância de centavo para arredondamento)
  CONSTRAINT sp_net_amount_eq
    CHECK (ROUND(net_amount, 2) = ROUND(amount_tendered - change_amount, 2)),

  -- Valor líquido sempre positivo
  CONSTRAINT sp_net_amount_positive
    CHECK (net_amount > 0),

  -- Parcelamento só em crédito
  CONSTRAINT sp_installments_credit_only
    CHECK (installments = 1 OR method = 'credit_card'),

  -- Parcelas mínimo 1
  CONSTRAINT sp_installments_positive
    CHECK (installments >= 1),

  -- Taxa nunca negativa
  CONSTRAINT sp_fee_nonnegative
    CHECK (fee_amount >= 0 AND fee_percentage >= 0)
);

-- =============================================================================
-- PARTE 2b — Índices
-- =============================================================================

-- JOIN principal: pagamentos de uma venda
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id
  ON public.sale_payments (sale_id);

-- Relatórios e fechamento de caixa por empresa/período
CREATE INDEX IF NOT EXISTS idx_sale_payments_company_date
  ON public.sale_payments (company_id, created_at DESC);

-- Filtro por método (dinheiro recebido, Pix, cartão)
CREATE INDEX IF NOT EXISTS idx_sale_payments_method
  ON public.sale_payments (company_id, method, created_at DESC);

-- =============================================================================
-- PARTE 2c — Função helper: get_dominant_payment_method
--
-- Retorna o método dominante (maior net_amount) de uma venda.
-- Fallback para sales.payment_method em vendas sem sale_payments (legado).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_dominant_payment_method(p_sale_id int)
RETURNS public.payment_method
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_method public.payment_method;
BEGIN
  -- Fonte de verdade: sale_payments (vendas novas)
  SELECT method
  INTO   v_method
  FROM   public.sale_payments
  WHERE  sale_id = p_sale_id
  ORDER  BY net_amount DESC
  LIMIT  1;

  -- Fallback: sales.payment_method (vendas legadas sem sale_payments)
  IF v_method IS NULL THEN
    SELECT payment_method
    INTO   v_method
    FROM   public.sales
    WHERE  id = p_sale_id;
  END IF;

  RETURN v_method;
END;
$$;

-- =============================================================================
-- PARTE 2d — RLS
--
-- O app usa service_role (bypassa RLS por design).
-- RLS protege acesso direto autenticado (defense-in-depth).
-- sale_payments tem dados financeiros → restrito a admin/gerente.
-- =============================================================================

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_payments_company" ON public.sale_payments;
CREATE POLICY "sale_payments_company"
  ON  public.sale_payments
  FOR SELECT
  TO  authenticated
  USING (
    company_id = public.current_company_id()
    AND public.get_user_role() IN ('admin', 'gerente')
  );

-- =============================================================================
-- PARTE 2e — Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.get_dominant_payment_method(int)
  TO service_role, authenticated;

-- =============================================================================
-- Smoke test inline — confirma estrutura criada
-- =============================================================================

-- Tabela existe com 16 colunas?
SELECT COUNT(*) AS total_colunas
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'sale_payments';
-- Esperado: 16

-- Constraints presentes?
SELECT conname
FROM   pg_constraint
WHERE  conrelid = 'public.sale_payments'::regclass
  AND  contype  = 'c'
ORDER  BY conname;
-- Esperado: 10 constraints (sp_*)

-- Índices presentes?
SELECT indexname
FROM   pg_indexes
WHERE  schemaname = 'public'
  AND  tablename  = 'sale_payments'
ORDER  BY indexname;
-- Esperado: 3 índices (idx_sale_payments_*)

-- =============================================================================
-- FIM DA MIGRATION 20260522 — PARTE 2/2
-- =============================================================================
