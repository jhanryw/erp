-- =============================================================================
-- 20260705_push_subscriptions.sql
--
-- Tabela de assinaturas push (Web Push API).
-- Cada linha representa um dispositivo/navegador que aceitou receber
-- notificações push. Um mesmo usuário pode ter múltiplos dispositivos.
--
-- Campos de autenticação (endpoint, p256dh, auth) são os retornados pelo
-- PushManager.subscribe() do navegador e usados pelo web-push no servidor.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id           BIGSERIAL    PRIMARY KEY,
  user_id      UUID         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id   INT          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role         TEXT         NOT NULL,
  endpoint     TEXT         NOT NULL,
  p256dh       TEXT         NOT NULL,
  auth         TEXT         NOT NULL,
  user_agent   TEXT,
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Um endpoint é globalmente único (identifica dispositivo+browser)
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint)
);

-- Índices de consulta — busca por empresa + role é o padrão no envio
CREATE INDEX IF NOT EXISTS idx_push_subs_company_role
  ON public.push_subscriptions (company_id, role, active);

CREATE INDEX IF NOT EXISTS idx_push_subs_user
  ON public.push_subscriptions (user_id, active);

-- RLS
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Usuário vê apenas suas próprias assinaturas
DROP POLICY IF EXISTS "push_subs_own" ON public.push_subscriptions;
CREATE POLICY "push_subs_own" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO authenticated;
GRANT ALL ON public.push_subscriptions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_subscriptions_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_subscriptions_id_seq TO authenticated;
