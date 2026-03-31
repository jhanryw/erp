-- =============================================================================
-- 009_error_logs.sql — Tabela de log de erros técnicos
-- Santtorini ERP
--
-- Registra exceções não tratadas capturadas nas rotas críticas.
-- Escrita exclusiva via service_role (RPCs e API routes).
-- Nunca exposto ao cliente final.
--
-- EXECUTAR APÓS 001–008.
-- Idempotente: usa CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.error_logs (
  id          BIGSERIAL     PRIMARY KEY,
  ts          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  route       TEXT,                              -- ex: 'POST /api/vendas'
  message     TEXT,                              -- err.message
  stack       TEXT,                              -- err.stack (apenas em dev/staging)
  context     JSONB,                             -- payload parcial, user_id, company_id
  resolved    BOOLEAN       NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_error_logs_ts      ON public.error_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_route   ON public.error_logs (route, ts DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_unresolved ON public.error_logs (resolved, ts DESC)
  WHERE resolved = FALSE;

COMMENT ON TABLE public.error_logs IS
  'Log de erros técnicos não tratados capturados nas rotas críticas. Nunca expor ao cliente.';

-- RLS: apenas service_role escreve; admin pode ler
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "error_logs_select" ON public.error_logs;
CREATE POLICY "error_logs_select"
  ON public.error_logs FOR SELECT
  TO authenticated
  USING (public.get_user_role() = 'admin');

-- Sem INSERT policy para authenticated: apenas service_role (via createAdminClient) grava
-- =============================================================================
-- FIM DA MIGRAÇÃO 009
-- =============================================================================
