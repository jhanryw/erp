-- =============================================================================
-- 20260710_02_finance_entries_payment_fields.sql
--
-- Entrega 2 do plano de correção Caixa × Financeiro.
--
-- ATENÇÃO — RECONCILIAÇÃO DE ESTADO:
-- Uma versão anterior desta migration (que ainda incluía a view
-- vw_fluxo_caixa_diario, sem security_invoker, e paid_at como TIMESTAMPTZ)
-- foi aplicada diretamente neste banco antes da decisão final de arquitetura
-- ser fechada. Este arquivo foi reescrito para ser seguro em dois cenários:
--   (a) banco novo, sem nada disso ainda — cria tudo do zero, já correto;
--   (b) este banco específico — remove a view remanescente e converte
--       paid_at de TIMESTAMPTZ para DATE preservando o dia calendário no
--       fuso America/Fortaleza (não o fuso da sessão que rodar a migration).
-- payment_method, cash_movement_id, as 3 constraints e o índice já foram
-- conferidos idênticos ao desenho final nesse banco — permanecem com
-- ADD/CREATE ... IF NOT EXISTS, sem necessidade de ajuste adicional.
--
-- O QUE FAZ:
--   0. Remove a view vw_fluxo_caixa_diario, se existir (execução anterior)
--   1. Garante payment_method, paid_at (DATE), cash_movement_id em
--      finance_entries — todas NULLABLE, sem backfill, sem alterar valores
--      de linhas existentes (só corrige o TIPO de paid_at se necessário)
--   2. Garante as constraints de coerência entre os três campos
--   3. Garante o índice de consulta por data de pagamento
--
-- O QUE NÃO FAZ (fora de escopo desta entrega — decisões auditadas e
-- explicitamente adiadas):
--   - Não cria financial_payments / financial_payment_allocations
--   - Não cria vw_fluxo_caixa_diario nem qualquer outra view: existe hoje um
--     único consumidor (financeiro/fluxo/page.tsx), que agrega em
--     JavaScript — uma view só se justifica quando surgir um segundo
--     consumidor real (Dashboard, BI, AI Engine, API)
--   - Não faz backfill de nenhuma linha existente
--   - Não cria RPC de regularização (Entrega 3)
--   - Não cria automação de vínculo com Caixa (Entrega 4)
--   - Não altera vw_dre_mensal nem qualquer consulta baseada em reference_date
--
-- paid_at é DATE, não TIMESTAMPTZ: nenhum consumidor do domínio (Fluxo de
-- Caixa, DRE, regularização) opera abaixo do grão "dia". DATE elimina
-- qualquer necessidade de conversão de timezone — o formulário trabalha com
-- 'yyyy-MM-dd' do início ao fim, sem round-trip de Date/UTC. Precisão de
-- hora, se algum dia for necessária (conciliação bancária, PIX, Open
-- Finance), pertence a uma futura entidade de pagamento/extrato — não ao
-- livro-razão (finance_entries).
--
-- IDEMPOTENTE: sim — DROP VIEW IF EXISTS, ADD COLUMN IF NOT EXISTS, checagem
-- de tipo de paid_at antes de alterar, constraints via DO block com checagem
-- em pg_constraint (ALTER TABLE ADD CONSTRAINT não aceita IF NOT EXISTS
-- diretamente no Postgres), CREATE INDEX IF NOT EXISTS.
-- =============================================================================

-- =============================================================================
-- PARTE 0 — Remove a view remanescente de uma execução anterior
-- =============================================================================

DROP VIEW IF EXISTS public.vw_fluxo_caixa_diario;

-- =============================================================================
-- PARTE 1 — Colunas
-- =============================================================================

-- payment_method e cash_movement_id: já corretos se existirem, criados do
-- zero se não existirem — ADD COLUMN IF NOT EXISTS resolve os dois casos.
ALTER TABLE public.finance_entries
  ADD COLUMN IF NOT EXISTS payment_method   public.payment_method,
  ADD COLUMN IF NOT EXISTS cash_movement_id BIGINT REFERENCES public.cash_movements(id);

-- paid_at precisa de tratamento especial: ADD COLUMN IF NOT EXISTS sozinho
-- NÃO corrigiria o tipo se a coluna já existisse como TIMESTAMPTZ (só
-- pularia silenciosamente) — por isso a checagem explícita de tipo abaixo.
DO $$
DECLARE
  v_current_type text;
BEGIN
  SELECT data_type INTO v_current_type
  FROM   information_schema.columns
  WHERE  table_schema = 'public'
    AND  table_name   = 'finance_entries'
    AND  column_name  = 'paid_at';

  IF v_current_type IS NULL THEN
    -- Coluna não existe ainda (banco novo) — cria já como DATE.
    ALTER TABLE public.finance_entries ADD COLUMN paid_at DATE;
  ELSIF v_current_type <> 'date' THEN
    -- Coluna existe com tipo errado (TIMESTAMPTZ, de execução anterior) —
    -- converte preservando o DIA CALENDÁRIO no fuso America/Fortaleza, não
    -- no fuso da sessão que rodar esta migration. Valores gravados pela
    -- versão anterior do código eram ancorados em meio-dia -03:00
    -- especificamente para que esta conversão seja exata.
    ALTER TABLE public.finance_entries
      ALTER COLUMN paid_at TYPE DATE
      USING (paid_at AT TIME ZONE 'America/Fortaleza')::date;
  END IF;
  -- Se já for 'date', não faz nada — idempotente.
END $$;

COMMENT ON COLUMN public.finance_entries.payment_method IS
  'Forma de pagamento da despesa/receita. Obrigatório (via API) para despesas novas; NULL em registros históricos e em lançamentos automáticos que não informam pagamento.';
COMMENT ON COLUMN public.finance_entries.paid_at IS
  'Data efetiva do pagamento (regime de caixa) — DATE, sem componente de hora nem timezone: nenhum consumidor do domínio opera abaixo do grão dia. Distinta de reference_date (competência).';
COMMENT ON COLUMN public.finance_entries.cash_movement_id IS
  'Vínculo opcional com a movimentação física do Caixa que originou esta despesa, quando payment_method = cash. Preenchido apenas pela RPC de regularização (Entrega 3) ou pela futura automação do Caixa (Entrega 4) — nunca pela API pública de lançamentos.';

-- =============================================================================
-- PARTE 2 — Constraints (idempotentes via checagem em pg_constraint)
-- =============================================================================

DO $$
BEGIN
  -- Regra 1+2: cash_movement_id só pode existir quando payment_method = 'cash'
  -- (payment_method = 'cash' NÃO exige cash_movement_id — pode ficar NULL
  -- até a regularização/automação preenchê-lo)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_entries'::regclass
      AND conname  = 'fe_cash_movement_requires_cash_method'
  ) THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_cash_movement_requires_cash_method
      CHECK (cash_movement_id IS NULL OR payment_method = 'cash');
  END IF;

  -- Regra 3: payment_method e paid_at sempre juntos, nunca só um dos dois
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_entries'::regclass
      AND conname  = 'fe_payment_method_paid_at_together'
  ) THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_payment_method_paid_at_together
      CHECK (
        (payment_method IS NULL AND paid_at IS NULL)
        OR
        (payment_method IS NOT NULL AND paid_at IS NOT NULL)
      );
  END IF;

  -- Unicidade: um movimento de caixa só pode originar UMA despesa financeira
  -- (idempotência da regularização garantida a nível de banco)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.finance_entries'::regclass
      AND conname  = 'fe_cash_movement_id_unique'
  ) THEN
    ALTER TABLE public.finance_entries
      ADD CONSTRAINT fe_cash_movement_id_unique UNIQUE (cash_movement_id);
  END IF;
END $$;

-- =============================================================================
-- PARTE 3 — Índice
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_fe_paid_at
  ON public.finance_entries (company_id, paid_at)
  WHERE paid_at IS NOT NULL;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

-- View foi removida?
SELECT table_name
FROM   information_schema.views
WHERE  table_schema = 'public'
  AND  table_name   = 'vw_fluxo_caixa_diario';
-- Esperado: 0 linhas

-- Colunas com o tipo certo?
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'finance_entries'
  AND  column_name IN ('payment_method', 'paid_at', 'cash_movement_id')
ORDER BY column_name;
-- Esperado: 3 linhas, todas is_nullable = YES
-- paid_at → data_type = 'date' (não 'timestamp with time zone')

-- Constraints presentes?
SELECT conname
FROM   pg_constraint
WHERE  conrelid = 'public.finance_entries'::regclass
  AND  conname IN (
    'fe_cash_movement_requires_cash_method',
    'fe_payment_method_paid_at_together',
    'fe_cash_movement_id_unique'
  )
ORDER BY conname;
-- Esperado: 3 linhas

-- Índice presente?
SELECT indexname
FROM   pg_indexes
WHERE  tablename  = 'finance_entries'
  AND  indexname  = 'idx_fe_paid_at';
-- Esperado: 1 linha

-- =============================================================================
-- FIM DA MIGRATION 20260710_02
-- =============================================================================
