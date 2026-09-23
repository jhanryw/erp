-- =============================================================================
-- 202609241000_mercadolivre_oauth_foundation.sql
--
-- MARKETPLACE HUB / MERCADO LIVRE — Fase 1: fundação OAuth genérica.
--
-- Reaproveita a Integration Foundation (20260817): company_integrations
-- (conta conectada por empresa) + integration_secrets (tokens cifrados
-- AES-256-GCM na aplicação). Nada é reconstruído. Esta migration só:
--
--   1. amplia company_integrations.provider com 'mercadolivre';
--   2. amplia company_integrations.status com 'needs_reauth'
--        active       = conectado
--        inactive     = desligado pelo usuário (desconectado)
--        needs_reauth = token revogado/expirado — exige novo OAuth
--        error        = falha operacional (não é revogação)
--        pending      = (inalterado)
--   3. adiciona METADADOS NÃO SECRETOS de OAuth em company_integrations
--      (colunas genéricas, servem a qualquer provider OAuth futuro —
--      Shopee/Amazon): expiração, escopos, datas de refresh/validação/
--      conexão e o lease de refresh. Tokens continuam SÓ em
--      integration_secrets (cifrados) — nunca em settings.
--   4. cria integration_oauth_states: state OAuth de uso único, guardado
--      como HASH (sha256), vinculado a company_id + user_id + expiração,
--      com o code_verifier PKCE cifrado.
--   5. RPCs transacionais (service_role only):
--        rpc_consume_oauth_state             — consumo atômico e único do state
--        rpc_upsert_oauth_integration        — conexão/reconexão + tokens, atômico
--        rpc_claim_integration_token_refresh — lease de refresh por integração
--        rpc_complete_integration_token_refresh — grava tokens rotacionados (fencing)
--        rpc_fail_integration_token_refresh  — libera lease / marca needs_reauth
--        rpc_disconnect_oauth_integration    — desconexão preservando auditoria
--
-- POR QUE LEASE (e não advisory lock / SELECT FOR UPDATE):
--   O refresh exige uma chamada HTTP ao Mercado Livre DENTRO da janela
--   exclusiva. Pela aplicação (supabase-js → PostgREST) cada RPC é uma
--   transação isolada — não existe como segurar um lock de transação durante
--   o HTTP. O lease (refresh_lease_until/by) é adquirido
--   atomicamente (UPDATE ... WHERE lease livre), e a gravação final só é
--   aceita se o worker AINDA for o dono (fencing). Mesmo padrão de
--   claim-lease já usado na emissão fiscal (rpc_claim_fiscal_emission).
--   O lease (60s) é bem maior que o timeout HTTP (15s).
--
-- 100% aditiva: CHECKs ampliados (superset), colunas nullable, tabela nova.
-- =============================================================================

BEGIN;

-- ─── 1-2. provider / status ──────────────────────────────────────────────────

ALTER TABLE public.company_integrations
  DROP CONSTRAINT IF EXISTS company_integrations_provider_check;
ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_provider_check
  CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop', 'focus_nfe', 'fiscal_certificate', 'mercadolivre'));

ALTER TABLE public.company_integrations
  DROP CONSTRAINT IF EXISTS company_integrations_status_check;
ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_status_check
  CHECK (status IN ('pending', 'active', 'inactive', 'error', 'needs_reauth'));


-- ─── 3. Metadados OAuth não secretos ─────────────────────────────────────────

ALTER TABLE public.company_integrations
  ADD COLUMN IF NOT EXISTS credential_expires_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oauth_scopes               TEXT[],
  ADD COLUMN IF NOT EXISTS credential_refreshed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_validated_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS connected_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disconnected_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refresh_lease_owner    TEXT;

COMMENT ON COLUMN public.company_integrations.credential_expires_at IS
  'Expiração do access_token OAuth corrente (NÃO secreto). O token em si fica cifrado em integration_secrets(key=access_token).';
COMMENT ON COLUMN public.company_integrations.refresh_lease_until IS
  'Lease de refresh de token: enquanto no futuro, só refresh_lease_owner pode usar o refresh_token (de uso único no Mercado Livre).';

-- Refresh proativo (job): integrações ativas com token perto de expirar.
CREATE INDEX IF NOT EXISTS idx_company_integrations_credential_expiry
  ON public.company_integrations (provider, credential_expires_at)
  WHERE status = 'active' AND credential_expires_at IS NOT NULL;


-- ─── 4. integration_oauth_states ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.integration_oauth_states (
  id                          BIGSERIAL    PRIMARY KEY,
  provider                    TEXT         NOT NULL,
  -- sha256(state) em hex — o state em claro só existe na URL do navegador.
  state_hash                  TEXT         NOT NULL UNIQUE,
  company_id                  INT          NOT NULL REFERENCES public.companies(id),
  user_id                     UUID         NOT NULL,
  -- PKCE code_verifier cifrado (secretCipher) — NULL quando PKCE desligado.
  code_verifier_ciphertext    TEXT,
  code_verifier_key_version   INT,
  expires_at                  TIMESTAMPTZ  NOT NULL,
  consumed_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expires
  ON public.integration_oauth_states (expires_at);

COMMENT ON TABLE public.integration_oauth_states IS
  'State OAuth de uso único (hash), vinculado a empresa+usuário+expiração. A identidade da empresa viaja no state, nunca na redirect_uri (que é fixa).';


-- ─── 5. RPCs ─────────────────────────────────────────────────────────────────

-- Consome o state UMA vez. Retorna status para a aplicação decidir a
-- mensagem, e os vínculos só quando 'ok'.
CREATE OR REPLACE FUNCTION public.rpc_consume_oauth_state(
  p_provider   text,
  p_state_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  UPDATE integration_oauth_states
  SET consumed_at = NOW()
  WHERE state_hash  = p_state_hash
    AND provider    = p_provider
    AND consumed_at IS NULL
    AND expires_at  > NOW()
  RETURNING company_id, user_id, code_verifier_ciphertext, code_verifier_key_version
  INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', 'ok',
      'company_id', v_row.company_id,
      'user_id', v_row.user_id,
      'code_verifier_ciphertext', v_row.code_verifier_ciphertext,
      'code_verifier_key_version', v_row.code_verifier_key_version
    );
  END IF;

  SELECT consumed_at, expires_at INTO v_row
  FROM integration_oauth_states
  WHERE state_hash = p_state_hash AND provider = p_provider;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  ELSIF v_row.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'consumed');
  ELSE
    RETURN jsonb_build_object('status', 'expired');
  END IF;
END;
$$;


-- Conexão / reconexão atômica: integração + tokens + metadados.
-- Uma empresa tem no máximo UMA conexão por provider (reconectar outra conta
-- substitui a anterior). A mesma conta externa nunca fica em duas empresas
-- (uq_company_integrations_provider_account, mantido).
CREATE OR REPLACE FUNCTION public.rpc_upsert_oauth_integration(
  p_company_id           int,
  p_provider             text,
  p_external_account_id  text,
  p_settings             jsonb,
  p_access_ciphertext    text,
  p_refresh_ciphertext   text,
  p_key_version          int,
  p_credential_expires_at     timestamptz,
  p_oauth_scopes         text[],
  p_user_id              uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing  record;
  v_id        bigint;
  v_reconnect boolean := false;
BEGIN
  IF p_external_account_id IS NULL OR btrim(p_external_account_id) = '' THEN
    RAISE EXCEPTION 'Conta externa não identificada.' USING ERRCODE = 'P0001';
  END IF;
  IF p_access_ciphertext IS NULL OR p_refresh_ciphertext IS NULL THEN
    RAISE EXCEPTION 'Tokens ausentes.' USING ERRCODE = 'P0001';
  END IF;

  -- Mesma conta externa já vinculada a OUTRA empresa → recusa sem vazar qual.
  IF EXISTS (
    SELECT 1 FROM company_integrations
    WHERE provider = p_provider
      AND external_account_id = p_external_account_id
      AND company_id <> p_company_id
  ) THEN
    RAISE EXCEPTION 'account_linked_to_other_company' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, external_account_id INTO v_existing
  FROM company_integrations
  WHERE company_id = p_company_id AND provider = p_provider
  ORDER BY id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_id := v_existing.id;
    v_reconnect := true;
    UPDATE company_integrations
    SET external_account_id        = p_external_account_id,
        status                     = 'active',
        settings                   = COALESCE(settings, '{}'::jsonb) || COALESCE(p_settings, '{}'::jsonb),
        last_error                 = NULL,
        credential_expires_at           = p_credential_expires_at,
        oauth_scopes               = p_oauth_scopes,
        credential_refreshed_at         = NOW(),
        last_validated_at          = NOW(),
        connected_at               = NOW(),
        disconnected_at            = NULL,
        refresh_lease_until = NULL,
        refresh_lease_owner    = NULL
    WHERE id = v_id;
  ELSE
    INSERT INTO company_integrations (
      company_id, provider, external_account_id, status, settings, created_by,
      credential_expires_at, oauth_scopes, credential_refreshed_at, last_validated_at, connected_at
    )
    VALUES (
      p_company_id, p_provider, p_external_account_id, 'active', COALESCE(p_settings, '{}'::jsonb), p_user_id,
      p_credential_expires_at, p_oauth_scopes, NOW(), NOW(), NOW()
    )
    RETURNING id INTO v_id;
  END IF;

  INSERT INTO integration_secrets (integration_id, company_id, key, ciphertext, key_version)
  VALUES (v_id, p_company_id, 'access_token', p_access_ciphertext, p_key_version),
         (v_id, p_company_id, 'refresh_token', p_refresh_ciphertext, p_key_version)
  ON CONFLICT (integration_id, key) DO UPDATE
    SET ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version, updated_at = NOW();

  RETURN jsonb_build_object('integration_id', v_id, 'reconnected', v_reconnect);
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'account_linked_to_other_company' USING ERRCODE = 'P0001';
END;
$$;


-- Lease de refresh. Só concede se o lease estiver livre (ou vencido) e a
-- integração estiver ativa. Sempre devolve o estado atual para o chamador
-- decidir (usar token novo, esperar, ou falhar).
CREATE OR REPLACE FUNCTION public.rpc_claim_integration_token_refresh(
  p_integration_id bigint,
  p_company_id     int,
  p_worker_id      text,
  p_lease_seconds  int DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  UPDATE company_integrations
  SET refresh_lease_until = NOW() + make_interval(secs => GREATEST(p_lease_seconds, 5)),
      refresh_lease_owner    = p_worker_id
  WHERE id = p_integration_id
    AND company_id = p_company_id
    AND status = 'active'
    AND (refresh_lease_until IS NULL OR refresh_lease_until < NOW())
  RETURNING status, credential_expires_at, credential_refreshed_at INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true, 'status', v_row.status,
      'credential_expires_at', v_row.credential_expires_at, 'credential_refreshed_at', v_row.credential_refreshed_at);
  END IF;

  SELECT status, credential_expires_at, credential_refreshed_at INTO v_row
  FROM company_integrations
  WHERE id = p_integration_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'status', 'not_found');
  END IF;
  RETURN jsonb_build_object('claimed', false, 'status', v_row.status,
    'credential_expires_at', v_row.credential_expires_at, 'credential_refreshed_at', v_row.credential_refreshed_at);
END;
$$;


-- Grava o par rotacionado SOMENTE se o chamador ainda for o dono do lease
-- (fencing). Tokens + metadados + liberação do lease na mesma transação.
CREATE OR REPLACE FUNCTION public.rpc_complete_integration_token_refresh(
  p_integration_id     bigint,
  p_company_id         int,
  p_worker_id          text,
  p_access_ciphertext  text,
  p_refresh_ciphertext text,
  p_key_version        int,
  p_credential_expires_at   timestamptz,
  p_oauth_scopes       text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE company_integrations
  SET credential_expires_at           = p_credential_expires_at,
      oauth_scopes               = COALESCE(p_oauth_scopes, oauth_scopes),
      credential_refreshed_at         = NOW(),
      last_error                 = NULL,
      refresh_lease_until = NULL,
      refresh_lease_owner    = NULL
  WHERE id = p_integration_id
    AND company_id = p_company_id
    AND refresh_lease_owner = p_worker_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO integration_secrets (integration_id, company_id, key, ciphertext, key_version)
  VALUES (p_integration_id, p_company_id, 'access_token', p_access_ciphertext, p_key_version),
         (p_integration_id, p_company_id, 'refresh_token', p_refresh_ciphertext, p_key_version)
  ON CONFLICT (integration_id, key) DO UPDATE
    SET ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version, updated_at = NOW();

  RETURN true;
END;
$$;


-- Libera o lease após falha. p_needs_reauth=true (invalid_grant: revogado/
-- expirado) → status needs_reauth, sem novas tentativas automáticas.
-- Falha transitória → status continua 'active', só registra last_error.
CREATE OR REPLACE FUNCTION public.rpc_fail_integration_token_refresh(
  p_integration_id bigint,
  p_company_id     int,
  p_worker_id      text,
  p_needs_reauth   boolean,
  p_error          text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE company_integrations
  SET status = CASE WHEN p_needs_reauth THEN 'needs_reauth' ELSE status END,
      last_error = left(p_error, 500),
      refresh_lease_until = NULL,
      refresh_lease_owner    = NULL
  WHERE id = p_integration_id
    AND company_id = p_company_id
    AND refresh_lease_owner = p_worker_id;
END;
$$;


-- Desconexão: apaga os tokens (inutiliza), marca inactive, preserva a linha
-- (auditoria) e a conta anterior em settings; libera external_account_id
-- para que a conta possa ser conectada de novo (nesta ou em outra empresa).
CREATE OR REPLACE FUNCTION public.rpc_disconnect_oauth_integration(
  p_integration_id bigint,
  p_company_id     int,
  p_user_id        uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE company_integrations
  SET status                     = 'inactive',
      settings                   = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
                                     'previous_external_account_id', external_account_id,
                                     'disconnected_by', p_user_id),
      external_account_id        = NULL,
      disconnected_at            = NOW(),
      credential_expires_at           = NULL,
      refresh_lease_until = NULL,
      refresh_lease_owner    = NULL
  WHERE id = p_integration_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM integration_secrets
  WHERE integration_id = p_integration_id
    AND company_id = p_company_id
    AND key IN ('access_token', 'refresh_token');

  RETURN true;
END;
$$;


-- ─── RLS / grants ────────────────────────────────────────────────────────────

ALTER TABLE public.integration_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integration_oauth_states TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.integration_oauth_states_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.rpc_consume_oauth_state(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_upsert_oauth_integration(int, text, text, jsonb, text, text, int, timestamptz, text[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_claim_integration_token_refresh(bigint, int, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_complete_integration_token_refresh(bigint, int, text, text, text, int, timestamptz, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_fail_integration_token_refresh(bigint, int, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_disconnect_oauth_integration(bigint, int, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_consume_oauth_state(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_oauth_integration(int, text, text, jsonb, text, text, int, timestamptz, text[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_claim_integration_token_refresh(bigint, int, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_complete_integration_token_refresh(bigint, int, text, text, text, int, timestamptz, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fail_integration_token_refresh(bigint, int, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_disconnect_oauth_integration(bigint, int, uuid) TO service_role;

COMMIT;
