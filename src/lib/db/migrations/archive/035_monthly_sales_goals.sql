-- Migration 035: Módulo de metas mensais de faturamento
-- Tabela monthly_sales_goals: meta mínima, alvo e agressiva por mês/empresa.

-- ─── Tabela principal ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.monthly_sales_goals (
  id           SERIAL        PRIMARY KEY,
  company_id   INT           NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year         INT           NOT NULL,
  month        INT           NOT NULL CHECK (month BETWEEN 1 AND 12),
  goal_min     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (goal_min     >= 0),
  goal_target  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (goal_target  >= 0),
  goal_stretch NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (goal_stretch >= 0),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT monthly_sales_goals_company_year_month_unique UNIQUE (company_id, year, month)
);

-- Índice de busca por empresa + ano
CREATE INDEX IF NOT EXISTS idx_monthly_sales_goals_company_year
  ON public.monthly_sales_goals (company_id, year);

-- ─── Trigger updated_at ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Só cria o trigger se ainda não existir (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_monthly_sales_goals_updated_at'
  ) THEN
    CREATE TRIGGER trg_monthly_sales_goals_updated_at
      BEFORE UPDATE ON public.monthly_sales_goals
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END;
$$;

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.monthly_sales_goals ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer autenticado da mesma empresa
CREATE POLICY "msg_select" ON public.monthly_sales_goals
  FOR SELECT TO authenticated
  USING (company_id = public.current_company_id());

-- Escrita: apenas gerente e admin
CREATE POLICY "msg_insert" ON public.monthly_sales_goals
  FOR INSERT TO authenticated
  WITH CHECK (company_id = public.current_company_id()
              AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "msg_update" ON public.monthly_sales_goals
  FOR UPDATE TO authenticated
  USING (company_id = public.current_company_id()
         AND public.get_user_role() IN ('admin', 'gerente'));

CREATE POLICY "msg_delete" ON public.monthly_sales_goals
  FOR DELETE TO authenticated
  USING (company_id = public.current_company_id()
         AND public.get_user_role() IN ('admin', 'gerente'));

-- Acesso total para service_role (API server-side via admin client)
CREATE POLICY "msg_service_role" ON public.monthly_sales_goals
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── Permissões ───────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.monthly_sales_goals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.monthly_sales_goals TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.monthly_sales_goals_id_seq TO authenticated, service_role;
