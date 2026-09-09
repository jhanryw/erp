-- =============================================================================
-- 202609091200_push_send_logs.sql
--
-- Log de cada tentativa de envio de Web Push (sucesso ou erro), por assinatura.
-- Resolve o gap encontrado na auditoria: send.ts descartava silenciosamente
-- falhas 400/401/403 e a ausência de VAPID configurada, tornando impossível
-- diagnosticar por que um push não chegou. Alimenta o painel de diagnóstico
-- em Configurações > Notificações ("Último push enviado" / "Último status").
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.push_send_logs (
  id              BIGSERIAL    PRIMARY KEY,
  subscription_id BIGINT       REFERENCES public.push_subscriptions(id) ON DELETE SET NULL,
  company_id      INT          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id         UUID         REFERENCES public.users(id) ON DELETE SET NULL,
  endpoint        TEXT         NOT NULL,
  success         BOOLEAN      NOT NULL,
  status_code     INT,
  error_message   TEXT,
  sent_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_send_logs_user
  ON public.push_send_logs (user_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_push_send_logs_company
  ON public.push_send_logs (company_id, sent_at DESC);

-- RLS
ALTER TABLE public.push_send_logs ENABLE ROW LEVEL SECURITY;

-- Usuário vê apenas os logs das próprias assinaturas (leitura, via painel de diagnóstico)
DROP POLICY IF EXISTS "push_send_logs_own" ON public.push_send_logs;
CREATE POLICY "push_send_logs_own" ON public.push_send_logs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.push_send_logs TO authenticated;
GRANT ALL ON public.push_send_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.push_send_logs_id_seq TO service_role;
