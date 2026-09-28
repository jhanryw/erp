-- =============================================================================
-- 202609281000_shopee_provider_foundation.sql
--
-- MARKETPLACE HUB / SHOPEE — Fase 0 (preparação do core) + suporte à Fase 1
-- (OAuth/conexão de lojas Shopee).
--
-- Reaproveita a fundação OAuth genérica (202609241000): company_integrations
-- (colunas OAuth + lease), integration_secrets (tokens cifrados na aplicação),
-- integration_oauth_states e as RPCs de lease/refresh/desconexão — nada é
-- reconstruído. Esta migration só:
--
--   1. amplia company_integrations.provider com 'shopee' (superconjunto);
--   2. amplia sales.sales_channel com 'shopee' (superconjunto) — preparação,
--      nenhuma RPC de pedidos é alterada aqui;
--   3. cria rpc_upsert_oauth_account_integration: conexão/reconexão por
--      CONTA EXTERNA (company_id + provider + external_account_id).
--      Necessária porque a Shopee é multi-loja (um partner_id autoriza N
--      shop_id, e uma empresa pode conectar várias lojas), enquanto a
--      rpc_upsert_oauth_integration existente (usada pelo Mercado Livre) é
--      deliberadamente "uma conexão por provider por empresa" (reconectar
--      outra conta substitui a anterior). A RPC existente NÃO é alterada.
--
-- NÃO cria UNIQUE(company_id, provider). A mesma conta externa continua
-- nunca podendo ficar em duas empresas (uq_company_integrations_provider_account).
-- Nenhum índice de channel_listings é tocado.
--
-- 100% aditiva: CHECKs ampliados (superset), uma função nova.
-- =============================================================================

BEGIN;

-- ─── 1. company_integrations.provider ───────────────────────────────────────

-- Remove o CHECK vigente de provider pela DEFINIÇÃO (não pelo nome presumido)
-- — mesmo padrão de 202609241000. O CHECK de status não é tocado.
DO $$
DECLARE
  v_con record;
BEGIN
  FOR v_con IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.company_integrations'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ~* '\mprovider\M'
  LOOP
    EXECUTE format('ALTER TABLE public.company_integrations DROP CONSTRAINT %I', v_con.conname);
  END LOOP;
END $$;

-- Superconjunto da lista vigente (202609241000) — o ADD revalida as linhas
-- existentes, que continuam todas válidas.
ALTER TABLE public.company_integrations
  ADD CONSTRAINT company_integrations_provider_check
  CHECK (provider IN ('chatwoot', 'meta', 'nuvemshop', 'focus_nfe', 'fiscal_certificate', 'mercadolivre', 'shopee'));


-- ─── 2. sales.sales_channel ─────────────────────────────────────────────────

-- Mesmo padrão de 202609261100 (DROP IF EXISTS + ADD NOT VALID + VALIDATE).
ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_sales_channel_valid;
ALTER TABLE public.sales
  ADD CONSTRAINT sales_sales_channel_valid
    CHECK (sales_channel IS NULL OR sales_channel IN ('pos', 'manual', 'whatsapp', 'nuvemshop', 'wholesale_site', 'mercadolivre', 'shopee')) NOT VALID;
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_sales_channel_valid;


-- ─── 3. Conexão por conta externa (multi-loja) ──────────────────────────────

-- Reconexão da MESMA conta (ativa, ou desconectada antes — a desconexão
-- guarda a conta em settings.previous_external_account_id e zera
-- external_account_id) reaproveita a linha; conta nova = linha nova.
CREATE OR REPLACE FUNCTION public.rpc_upsert_oauth_account_integration(
  p_company_id            int,
  p_provider              text,
  p_external_account_id   text,
  p_settings              jsonb,
  p_access_ciphertext     text,
  p_refresh_ciphertext    text,
  p_key_version           int,
  p_credential_expires_at timestamptz,
  p_oauth_scopes          text[],
  p_user_id               uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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

  SELECT id INTO v_id
  FROM company_integrations
  WHERE company_id = p_company_id
    AND provider = p_provider
    AND (
      external_account_id = p_external_account_id
      OR (external_account_id IS NULL AND settings->>'previous_external_account_id' = p_external_account_id)
    )
  ORDER BY (external_account_id IS NOT NULL) DESC, id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    v_reconnect := true;
    UPDATE company_integrations
    SET external_account_id     = p_external_account_id,
        status                  = 'active',
        settings                = COALESCE(settings, '{}'::jsonb) || COALESCE(p_settings, '{}'::jsonb),
        last_error              = NULL,
        credential_expires_at   = p_credential_expires_at,
        oauth_scopes            = p_oauth_scopes,
        credential_refreshed_at = NOW(),
        last_validated_at       = NOW(),
        connected_at            = NOW(),
        disconnected_at         = NULL,
        refresh_lease_until     = NULL,
        refresh_lease_owner     = NULL
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

REVOKE ALL ON FUNCTION public.rpc_upsert_oauth_account_integration(int, text, text, jsonb, text, text, int, timestamptz, text[], uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_oauth_account_integration(int, text, text, jsonb, text, text, int, timestamptz, text[], uuid) TO service_role;

COMMIT;
