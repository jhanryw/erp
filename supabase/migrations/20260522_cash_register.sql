-- =============================================================================
-- Migration 20260522 — Módulo de Caixa (Parte 1/3): Tabelas
--
-- DEPENDE DE:
--   Tabelas existentes: companies, users, sales
--   (Não depende de sale_payments para a estrutura, apenas para os RPCs)
--
-- O QUE FAZ:
--   1. Cria cash_register_sessions (sessão de caixa abertura→fechamento)
--   2. Cria cash_movements (sangria, suprimento, despesa)
--   3. Adiciona cash_session_id em sales (nullable, sem breaking change)
--   4. Índices, constraints, RLS, grants
--
-- AJUSTES INCORPORADOS:
--   - closing_confirmed_by (dupla conferência futura)
--   - metadata jsonb em cash_movements (comprovantes, pix_id, etc.)
--   - reference_sale_id em cash_movements (rastreabilidade futura)
--   - cancelled_at/cancelled_by/cancellation_reason (soft delete lógico — D14)
--
-- IDEMPOTENTE: sim (IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS)
-- ROLLBACK:
--   DROP TABLE public.cash_movements CASCADE;
--   DROP TABLE public.cash_register_sessions CASCADE;
--   ALTER TABLE public.sales DROP COLUMN IF EXISTS cash_session_id;
-- =============================================================================

-- =============================================================================
-- PARTE 1a — cash_register_sessions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cash_register_sessions (
  id                      BIGSERIAL       PRIMARY KEY,
  company_id              INT             NOT NULL
                            REFERENCES public.companies(id),
  status                  TEXT            NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'closed')),

  -- ─── Abertura ──────────────────────────────────────────────────────────────
  opened_by               UUID            NOT NULL
                            REFERENCES public.users(id),
  opened_at               TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  opening_amount_cash     NUMERIC(10,2)   NOT NULL DEFAULT 0
                            CHECK (opening_amount_cash >= 0),
  notes_open              TEXT,

  -- ─── Fechamento (NULL enquanto aberto) ─────────────────────────────────────
  closed_by               UUID            REFERENCES public.users(id),
  closed_at               TIMESTAMPTZ,
  counted_cash            NUMERIC(10,2)   CHECK (counted_cash >= 0),
  notes_close             TEXT,
  -- Futuro: dupla conferência de fechamento (não usado na UI v1)
  closing_confirmed_by    UUID            REFERENCES public.users(id),

  -- ─── Snapshot de vendas (calculado e gravado no fechamento) ────────────────
  -- Fonte de verdade: sale_payments das vendas com cash_session_id = id
  total_sales             NUMERIC(10,2),  -- SUM(sales.total) da sessão
  total_cash              NUMERIC(10,2),  -- SUM(sp.net_amount) WHERE method='cash'
  total_pix               NUMERIC(10,2),  -- SUM(sp.net_amount) WHERE method='pix'
  total_credit_card       NUMERIC(10,2),  -- SUM(sp.net_amount) WHERE method='credit_card'
  total_debit_card        NUMERIC(10,2),  -- SUM(sp.net_amount) WHERE method='debit_card'
  total_card_fees         NUMERIC(10,2),  -- SUM(sp.fee_amount) cartões
  total_cash_change       NUMERIC(10,2),  -- SUM(sp.change_amount) WHERE change_method='cash'
  total_pix_change        NUMERIC(10,2),  -- SUM(sp.change_amount) WHERE change_method='pix'

  -- ─── Snapshot de movimentos (calculado e gravado no fechamento) ─────────────
  -- Apenas movimentos com cancelled_at IS NULL entram no snapshot
  total_sangria           NUMERIC(10,2),
  total_suprimento        NUMERIC(10,2),
  total_expenses          NUMERIC(10,2),  -- total de despesas (todos os métodos)

  -- ─── Apuração de caixa ─────────────────────────────────────────────────────
  -- expected_cash =
  --   opening_amount_cash
  --   + SUM(sp.amount_tendered WHERE method='cash')    ← bruto recebido em dinheiro
  --   - SUM(sp.change_amount WHERE method='cash'
  --          AND change_method='cash')                 ← troco dado em dinheiro
  --   + total_suprimento
  --   - total_sangria
  --   - SUM(cm.amount WHERE type='expense' AND method='cash')
  --
  -- Nota: troco via PIX (change_method='pix') NÃO é subtraído do dinheiro físico
  -- porque o dinheiro permanece na gaveta — a saída é digital.
  expected_cash           NUMERIC(10,2),
  cash_difference         NUMERIC(10,2),  -- counted_cash - expected_cash

  created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- ─── Constraints de integridade ─────────────────────────────────────────────
  CONSTRAINT crs_closed_requires_closed_at
    CHECK (status = 'open' OR closed_at IS NOT NULL),
  CONSTRAINT crs_closed_requires_counted_cash
    CHECK (status = 'open' OR counted_cash IS NOT NULL),
  CONSTRAINT crs_closed_by_with_closed_at
    CHECK (closed_at IS NULL OR closed_by IS NOT NULL)
);

-- =============================================================================
-- PARTE 1b — Índices de cash_register_sessions
-- =============================================================================

-- Um único caixa aberto por empresa (regra de negócio fundamental)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_sessions_one_open_per_company
  ON public.cash_register_sessions (company_id)
  WHERE status = 'open';

-- Relatórios e histórico por empresa/período
CREATE INDEX IF NOT EXISTS idx_cash_sessions_company_opened
  ON public.cash_register_sessions (company_id, opened_at DESC);

-- =============================================================================
-- PARTE 2a — cash_movements
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.cash_movements (
  id                    BIGSERIAL       PRIMARY KEY,
  cash_session_id       BIGINT          NOT NULL
                          REFERENCES public.cash_register_sessions(id),
  company_id            INT             NOT NULL
                          REFERENCES public.companies(id),

  -- Tipo de movimento
  -- sangria    → retirada de dinheiro físico (sempre cash)
  -- suprimento → entrada manual de dinheiro (sempre cash)
  -- expense    → despesa operacional (qualquer método)
  type                  TEXT            NOT NULL
                          CHECK (type IN ('sangria', 'suprimento', 'expense')),

  -- Método de pagamento
  -- Sangria e suprimento: sempre 'cash' (constraint cm_sangria_suprimento_cash_only)
  -- Despesa: qualquer método (só cash afeta o dinheiro físico esperado)
  method                TEXT            NOT NULL DEFAULT 'cash'
                          CHECK (method IN ('cash', 'pix', 'credit_card', 'debit_card')),

  amount                NUMERIC(10,2)   NOT NULL CHECK (amount > 0),
  description           TEXT            NOT NULL,

  -- Rastreabilidade futura (ex.: ajuste de caixa ligado a uma venda específica)
  reference_sale_id     BIGINT          REFERENCES public.sales(id),

  -- Extensibilidade: comprovante PIX, auth_code, observações extras
  metadata              JSONB           NOT NULL DEFAULT '{}',

  -- Rastreabilidade
  created_by            UUID            NOT NULL REFERENCES public.users(id),
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  -- ─── Cancelamento lógico (soft delete — D14) ────────────────────────────────
  -- Movimentos cancelados são excluídos de todos os cálculos (WHERE cancelled_at IS NULL)
  -- mas permanecem no histórico com badge "cancelado"
  cancelled_at          TIMESTAMPTZ,
  cancelled_by          UUID            REFERENCES public.users(id),
  cancellation_reason   TEXT,

  -- ─── Constraints de integridade ──────────────────────────────────────────────
  -- Sangria e suprimento são sempre dinheiro físico
  CONSTRAINT cm_sangria_suprimento_cash_only
    CHECK (type NOT IN ('sangria', 'suprimento') OR method = 'cash'),

  -- Cancelamento: se cancelado, exige quem cancelou e o motivo
  CONSTRAINT cm_cancel_coherence
    CHECK (
      cancelled_at IS NULL
      OR (cancelled_by IS NOT NULL AND cancellation_reason IS NOT NULL)
    )
);

-- =============================================================================
-- PARTE 2b — Índices de cash_movements
-- =============================================================================

-- JOIN principal: movimentos de uma sessão
CREATE INDEX IF NOT EXISTS idx_cash_movements_session
  ON public.cash_movements (cash_session_id);

-- Filtro dominante: apenas movimentos ativos (cancelled_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_cash_movements_active
  ON public.cash_movements (cash_session_id)
  WHERE cancelled_at IS NULL;

-- Relatórios por empresa/período
CREATE INDEX IF NOT EXISTS idx_cash_movements_company_date
  ON public.cash_movements (company_id, created_at DESC);

-- Rastreabilidade por venda
CREATE INDEX IF NOT EXISTS idx_cash_movements_reference_sale
  ON public.cash_movements (reference_sale_id)
  WHERE reference_sale_id IS NOT NULL;

-- =============================================================================
-- PARTE 3 — Adicionar cash_session_id em sales
--
-- Nullable por design:
--   - Vendas físicas de balcão → preenchido com o ID da sessão aberta
--   - Vendas de envio/delivery → NULL (não exigem caixa)
--   - Vendas via webhook Nuvemshop → NULL (fluxo online, sem caixa)
--   - Vendas antigas → NULL (compatibilidade retroativa)
-- =============================================================================

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS cash_session_id BIGINT
    REFERENCES public.cash_register_sessions(id);

-- Índice para buscar todas as vendas de uma sessão
CREATE INDEX IF NOT EXISTS idx_sales_cash_session
  ON public.sales (cash_session_id)
  WHERE cash_session_id IS NOT NULL;

-- =============================================================================
-- PARTE 4 — RLS
--
-- Todas as escritas são feitas via RPCs SECURITY DEFINER (service_role).
-- RLS protege leitura direta autenticada.
-- =============================================================================

ALTER TABLE public.cash_register_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements          ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer usuário autenticado da empresa pode ver o caixa
DROP POLICY IF EXISTS "cash_sessions_company_read" ON public.cash_register_sessions;
CREATE POLICY "cash_sessions_company_read"
  ON public.cash_register_sessions
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

DROP POLICY IF EXISTS "cash_movements_company_read" ON public.cash_movements;
CREATE POLICY "cash_movements_company_read"
  ON public.cash_movements
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- =============================================================================
-- PARTE 5 — Grants
-- =============================================================================

GRANT SELECT ON public.cash_register_sessions TO authenticated;
GRANT SELECT ON public.cash_movements          TO authenticated;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

-- Tabelas criadas?
SELECT table_name
FROM   information_schema.tables
WHERE  table_schema = 'public'
  AND  table_name IN ('cash_register_sessions', 'cash_movements')
ORDER  BY table_name;
-- Esperado: 2 linhas

-- cash_session_id em sales?
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'sales'
  AND  column_name  = 'cash_session_id';
-- Esperado: 1 linha, bigint, YES

-- Índice partial unique (um caixa por empresa)?
SELECT indexname
FROM   pg_indexes
WHERE  tablename = 'cash_register_sessions'
  AND  indexname = 'idx_cash_sessions_one_open_per_company';
-- Esperado: 1 linha

-- =============================================================================
-- FIM DA MIGRATION 20260522 — PARTE 1/3 (Tabelas)
-- =============================================================================
