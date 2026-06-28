-- Fase 2: Autorização inline para ações críticas de usuario/vendedora

CREATE TABLE IF NOT EXISTS public.authorization_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    INT         NOT NULL,
  requested_by  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  authorized_by UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  reason        TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Limpeza automática: tokens expirados não precisam ficar para sempre
CREATE INDEX IF NOT EXISTS idx_authorization_tokens_expires_at
  ON public.authorization_tokens (expires_at);

-- Acesso restrito ao service_role (backend only)
ALTER TABLE public.authorization_tokens ENABLE ROW LEVEL SECURITY;

-- RLS: service_role bypassa — nenhuma policy pública necessária

-- Extender audit_logs com campos de autorização delegada
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS authorized_by UUID,
  ADD COLUMN IF NOT EXISTS reason        TEXT;
