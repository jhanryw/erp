-- =============================================================================
-- Migration 20260522: Tabela sale_payments — múltiplas formas de pagamento
--
-- O QUE FAZ:
--   1. Adiciona 'credit_card' e 'debit_card' ao enum payment_method
--   2. Cria a tabela sale_payments com todas as constraints
--   3. Cria índices
--   4. Cria função helper get_dominant_payment_method (com fallback legado)
--   5. Habilita RLS e cria política de acesso
--   6. Grants
--
-- IMPACTO EM DADOS EXISTENTES:
--   Nenhum. Tabela nova, sem retroativo. Vendas antigas continuam
--   funcionando via sales.payment_method sem qualquer alteração.
--
-- IDEMPOTENTE:
--   Sim. IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS / EXCEPTION guards.
--
-- ROLLBACK:
--   DROP TABLE public.sale_payments CASCADE;
--   DROP FUNCTION IF EXISTS public.get_dominant_payment_method(int);
--   Os valores do enum NÃO podem ser removidos no PostgreSQL.
--   Veja seção 8 do spec: docs/superpowers/specs/2026-05-22-multiple-payments-design.md
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Extensão do enum payment_method
--
-- Valores atuais esperados: pix, card, cash
-- Novos valores: credit_card, debit_card
-- O valor 'card' permanece para compatibilidade com vendas antigas e Nuvemshop.
-- O frontend novo nunca gera 'card' — usa apenas 'credit_card' ou 'debit_card'.
--
-- ALTER TYPE ... ADD VALUE não pode ser revertido via SQL padrão.
-- Verificar ANTES de aplicar:
--   SELECT enumlabel FROM pg_enum
--   WHERE enumtypid = 'public.payment_method'::regtype
--   ORDER BY enumsortorder;
-- =============================================================================

DO $$
BEGIN
  -- Adiciona 'credit_card' se ainda não existir
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.payment_method'::regtype
      AND enumlabel  = 'credit_card'
  ) THEN
    ALTER TYPE public.payment_method ADD VALUE 'credit_card';
  END IF;

  -- Adiciona 'debit_card' se ainda não existir
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.payment_method'::regtype
      AND enumlabel  = 'debit_card'
  ) THEN
    ALTER TYPE public.payment_method ADD VALUE 'debit_card';
  END IF;
END
$$;

-- =============================================================================
-- PARTE 2 — Tabela sale_payments
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sale_payments (
  id               BIGSERIAL        PRIMARY KEY,

  -- Vínculo com a venda
  sale_id          INT              NOT NULL
                     REFERENCES public.sales(id) ON DELETE CASCADE,
  company_id       INT              NOT NULL
                     REFERENCES public.companies(id),

  -- Forma de pagamento — usa o enum estendido
  -- Valores válidos: pix | cash | credit_card | debit_card
  -- 'card' nunca gerado pelo novo fluxo; reservado para legado
  method           public.payment_method NOT NULL,

  -- Valores financeiros
  -- amount_tendered: quanto o cliente entregou fisicamente (≥ net_amount)
  -- change_amount:   troco devolvido (só válido quando method = 'cash')
  -- net_amount:      valor efetivamente aplicado à venda (= amount_tendered - change_amount)
  -- Invariante: ROUND(net_amount, 2) = ROUND(amount_tendered - change_amount, 2)
  amount_tendered  NUMERIC(10,2)    NOT NULL,
  change_amount    NUMERIC(10,2)    NOT NULL DEFAULT 0,
  change_method    TEXT,            -- 'cash' | 'pix' | NULL; TEXT agora, enum futuro se necessário
  net_amount       NUMERIC(10,2)    NOT NULL,

  -- Cartão
  installments     INT              NOT NULL DEFAULT 1,
  card_brand       TEXT,            -- 'visa' | 'mastercard' | 'elo' | 'hipercard' | etc.
  acquirer         TEXT,            -- 'stone' | 'cielo' | 'pagseguro' | etc.

  -- Taxa de cartão (preenchida automaticamente pelo rpc_create_sale via payment_fee_settings)
  fee_percentage   NUMERIC(6,4)     NOT NULL DEFAULT 0,
  fee_amount       NUMERIC(10,2)    NOT NULL DEFAULT 0,

  -- Extensibilidade: NSU, auth_code, terminal_id, dados de integração com adquirente
  metadata         JSONB            NOT NULL DEFAULT '{}',

  -- Rastreabilidade
  created_by       UUID             REFERENCES public.users(id),
  created_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

  -- ─── Constraints de integridade ─────────────────────────────────────────

  -- Troco só pode existir em pagamentos em dinheiro
  CONSTRAINT sp_cash_only_change
    CHECK (change_amount = 0 OR method = 'cash'),

  -- change_method obrigatório quando há troco
  CONSTRAINT sp_change_method_required
    CHECK (change_amount = 0 OR change_method IS NOT NULL),

  -- change_method só aceita valores conhecidos (TEXT agora, preparado para enum)
  CONSTRAINT sp_change_method_valid
    CHECK (change_method IS NULL OR change_method IN ('cash', 'pix')),

  -- Troco nunca negativo
  CONSTRAINT sp_change_nonnegative
    CHECK (change_amount >= 0),

  -- Valor recebido deve cobrir o valor cobrado (excesso = troco)
  CONSTRAINT sp_amount_tendered_gte
    CHECK (amount_tendered >= net_amount),

  -- Invariante matemática do troco (tolerância de R$0,01 para float)
  CONSTRAINT sp_net_amount_eq
    CHECK (ROUND(net_amount, 2) = ROUND(amount_tendered - change_amount, 2)),

  -- Valor líquido sempre positivo
  CONSTRAINT sp_net_amount_positive
    CHECK (net_amount > 0),

  -- Parcelamento só faz sentido no crédito
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
-- PARTE 3 — Índices
-- =============================================================================

-- Lookup principal: buscar pagamentos de uma venda (JOIN mais comum)
CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id
  ON public.sale_payments (sale_id);

-- Relatórios e fechamento de caixa por empresa/período
CREATE INDEX IF NOT EXISTS idx_sale_payments_company_date
  ON public.sale_payments (company_id, created_at DESC);

-- Filtro por método (fechamento de caixa: dinheiro recebido, Pix, cartão)
CREATE INDEX IF NOT EXISTS idx_sale_payments_method
  ON public.sale_payments (company_id, method, created_at DESC);

-- =============================================================================
-- PARTE 4 — Função helper: get_dominant_payment_method
--
-- Retorna o método de pagamento dominante (maior net_amount) de uma venda.
-- Se a venda não tiver sale_payments (legado), faz fallback para sales.payment_method.
-- Usada pelo RPC para preencher sales.payment_method e por relatórios futuros.
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
  -- Fonte de verdade: sale_payments (vendas com novo fluxo)
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
-- PARTE 5 — RLS (Row-Level Security)
--
-- Padrão do projeto: service_role bypassa RLS.
-- RLS protege acesso direto autenticado (defense-in-depth).
-- sale_payments contém dados financeiros sensíveis → restrito a admin/gerente.
-- =============================================================================

ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_payments_company" ON public.sale_payments;
CREATE POLICY "sale_payments_company"
  ON public.sale_payments
  FOR SELECT
  TO authenticated
  USING (
    company_id = public.current_company_id()
    AND public.get_user_role() IN ('admin', 'gerente')
  );

-- =============================================================================
-- PARTE 6 — Grants
--
-- service_role já recebe ALL via "GRANT ALL ON ALL TABLES IN SCHEMA public"
-- (aplicado no schema original). A função helper precisa de grant explícito.
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.get_dominant_payment_method(int)
  TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRATION 20260522
-- =============================================================================
