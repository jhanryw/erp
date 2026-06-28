-- Fase 2 v2: ajustes pré-deploy

-- 1. Verificação de senha sem criar sessão (substitui signInWithPassword)
--    Usa pgcrypto (sempre disponível no Supabase) para comparar o hash.
--    SECURITY DEFINER acessa auth.users; restrito ao service_role.
CREATE OR REPLACE FUNCTION public.fn_verify_user_password(p_email TEXT, p_password TEXT)
RETURNS TABLE(user_id UUID, is_valid BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public, auth
AS $$
BEGIN
  RETURN QUERY
  SELECT
    u.id                                                                AS user_id,
    (u.encrypted_password = crypt(p_password, u.encrypted_password))   AS is_valid
  FROM auth.users u
  WHERE lower(u.email) = lower(p_email)
    AND u.deleted_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_verify_user_password(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_verify_user_password(TEXT, TEXT) TO service_role;

-- 2. Guardar desconto autorizado no token (para validar que o desconto não foi aumentado depois)
ALTER TABLE public.authorization_tokens
  ADD COLUMN IF NOT EXISTS authorized_discount_pct    NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS authorized_discount_amount NUMERIC(12,2);

-- 3. Expandir audit_logs com campos de autorização delegada
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS authorization_token_id UUID,
  ADD COLUMN IF NOT EXISTS authorization_action   TEXT,
  ADD COLUMN IF NOT EXISTS discount_percent       NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS discount_amount_audit  NUMERIC(12,2);
