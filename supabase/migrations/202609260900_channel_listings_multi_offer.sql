-- =============================================================================
-- 202609260900_channel_listings_multi_offer.sql — Marketplace Hub: N ofertas
--
-- Decisão arquitetural (24/09/2026): 1 variação vendável → N anúncios/ofertas
-- no MESMO canal e na MESMA integração (ex.: ML Clássico R$ 39,90 + ML
-- Premium R$ 44,90), todos compartilhando o estoque-mãe da variação (kit:
-- disponibilidade derivada). Estoque nunca pertence ao anúncio; preço,
-- status e condições comerciais pertencem ao anúncio.
--
--   1. channel_listings.listing_type_id — condição comercial consultável
--      (ML: gold_special/gold_pro…), antes só em metadata.
--   2. channel_listings.offer_key — chave ESTÁVEL da oferta dentro da
--      variação (idempotência da publicação). Padrão = listing_type_id; o
--      usuário pode definir outra para duas ofertas do mesmo tipo. Não é
--      vínculo com o canal (esse é sempre por id externo).
--   3. Unicidade passa de (integração, variação) para
--      (integração, variação, offer_key) entre vínculos vivos.
--   4. rpc_begin_channel_listing_publish passa a reservar POR OFERTA.
--
-- Roda DEPOIS de 202609251000 (já aplicada) e ANTES de 202609261000/1100.
-- Preserva todos os vínculos existentes (sem chamada externa, sem apagar
-- nada): hoje há no máximo 1 vínculo vivo por variação, então o backfill
-- satisfaz a unicidade nova. Idempotente.
-- =============================================================================

BEGIN;

ALTER TABLE public.channel_listings ADD COLUMN IF NOT EXISTS listing_type_id TEXT;
ALTER TABLE public.channel_listings ADD COLUMN IF NOT EXISTS offer_key TEXT;

UPDATE public.channel_listings
SET listing_type_id = COALESCE(listing_type_id, NULLIF(metadata->>'listing_type_id', ''))
WHERE listing_type_id IS NULL;

UPDATE public.channel_listings
SET offer_key = COALESCE(listing_type_id, 'default')
WHERE offer_key IS NULL;

ALTER TABLE public.channel_listings ALTER COLUMN offer_key SET DEFAULT 'default';
ALTER TABLE public.channel_listings ALTER COLUMN offer_key SET NOT NULL;

ALTER TABLE public.channel_listings DROP CONSTRAINT IF EXISTS channel_listings_offer_key_valid;
ALTER TABLE public.channel_listings
  ADD CONSTRAINT channel_listings_offer_key_valid CHECK (offer_key ~ '^[a-z0-9][a-z0-9_-]{0,59}$');

-- Antes: 1 vínculo vivo por (integração, variação). Agora: por oferta.
DROP INDEX IF EXISTS public.uq_channel_listings_live_variation;
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_listings_live_offer
  ON public.channel_listings (integration_id, product_variation_id, offer_key)
  WHERE local_status <> 'closed';

-- Reserva por OFERTA. Assinatura muda (p_offer_key, p_listing_type_id) →
-- DROP da antiga para não existir overload ambíguo.
--
-- BACKWARD-SAFE (janela migration → deploy): os dois parâmetros novos têm
-- DEFAULT NULL, então o código ANTERIOR (11 parâmetros nomeados) continua
-- resolvendo esta mesma função. p_offer_key NULL = chamada legada → mesma
-- semântica de antes ("o" vínculo vivo da variação, sem criar 2ª oferta);
-- na inserção a oferta recebe o tipo de anúncio do metadata (ou 'default').
-- Uma única função, sem lógica duplicada.
DROP FUNCTION IF EXISTS public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.rpc_begin_channel_listing_publish(
  p_company_id           int,
  p_integration_id       bigint,
  p_provider             text,
  p_product_id           int,
  p_product_variation_id int,
  p_seller_sku           text,
  p_attempt_id           uuid,
  p_lease_seconds        int,
  p_channel_price        numeric,
  p_metadata             jsonb,
  p_user_id              uuid,
  p_offer_key            text DEFAULT NULL,
  p_listing_type_id      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row    record;
  v_legacy boolean := NULLIF(trim(p_offer_key), '') IS NULL;
  v_type   text := COALESCE(NULLIF(trim(p_listing_type_id), ''), NULLIF(trim(p_metadata->>'listing_type_id'), ''));
  v_key    text := lower(COALESCE(NULLIF(trim(p_offer_key), ''), v_type, 'default'));
BEGIN
  SELECT id, local_status, publish_lease_until, external_listing_id INTO v_row
  FROM channel_listings
  WHERE integration_id = p_integration_id
    AND product_variation_id = p_product_variation_id
    -- chamada legada (sem offer_key): qualquer vínculo vivo da variação
    AND (v_legacy OR offer_key = v_key)
    AND company_id = p_company_id
    AND local_status <> 'closed'
  ORDER BY id
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_row.local_status IN ('active', 'paused') OR v_row.external_listing_id IS NOT NULL THEN
      RETURN jsonb_build_object('result', 'already_published', 'listing_id', v_row.id);
    END IF;
    IF v_row.local_status = 'publishing' THEN
      IF v_row.publish_lease_until > NOW() THEN
        RETURN jsonb_build_object('result', 'in_progress', 'listing_id', v_row.id);
      END IF;
      RETURN jsonb_build_object('result', 'needs_reconciliation', 'listing_id', v_row.id);
    END IF;
    -- draft / error sem id externo → reaproveita a linha DESTA oferta
    UPDATE channel_listings
    SET local_status = 'publishing', publish_attempt_id = p_attempt_id,
        publish_lease_until = NOW() + make_interval(secs => GREATEST(p_lease_seconds, 10)),
        seller_sku = p_seller_sku, channel_price = p_channel_price,
        listing_type_id = COALESCE(v_type, listing_type_id),
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
        last_error = NULL
    WHERE id = v_row.id;
    RETURN jsonb_build_object('result', 'claimed', 'listing_id', v_row.id);
  END IF;

  INSERT INTO channel_listings (
    company_id, integration_id, provider, product_id, product_variation_id, seller_sku, offer_key, listing_type_id,
    local_status, publish_attempt_id, publish_lease_until, channel_price, metadata, created_by
  )
  VALUES (
    p_company_id, p_integration_id, p_provider, p_product_id, p_product_variation_id, p_seller_sku, v_key, v_type,
    'publishing', p_attempt_id, NOW() + make_interval(secs => GREATEST(p_lease_seconds, 10)),
    p_channel_price, COALESCE(p_metadata, '{}'::jsonb), p_user_id
  )
  RETURNING id INTO v_row;
  RETURN jsonb_build_object('result', 'claimed', 'listing_id', v_row.id);
EXCEPTION
  WHEN unique_violation THEN
    -- corrida: outro processo inseriu a MESMA oferta no mesmo instante
    RETURN jsonb_build_object('result', 'in_progress');
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid, text, text) TO service_role;

COMMENT ON COLUMN public.channel_listings.offer_key IS
  'Chave estável da oferta dentro da variação (idempotência da publicação). Padrão = listing_type_id. Nunca usada como vínculo com o canal (vínculo = external_listing_id).';
COMMENT ON COLUMN public.channel_listings.listing_type_id IS
  'Condição comercial do anúncio no canal (ML: gold_special, gold_pro…). Preço/status/condições pertencem ao anúncio; estoque, à variação.';

COMMIT;

NOTIFY pgrst, 'reload schema';
