-- =============================================================================
-- 202609251000_channel_listings.sql
--
-- MARKETPLACE HUB — Fase 2: vínculo genérico variação Qarvon ↔ anúncio em
-- canal externo. NÃO é específico do Mercado Livre (provider é texto; a
-- mesma tabela servirá Shopee/Amazon/Nuvemshop no futuro).
--
-- Grão: 1 linha = 1 VARIAÇÃO VENDÁVEL do Qarvon (produto normal ou kit —
-- indiferente) anunciada em 1 integração (conta de canal). Motivo: no modelo
-- vigente do Mercado Livre (User Products, doc "Preço por variação",
-- 17/09/2026) cada variação é um ITEM próprio (sem array variations), e o
-- ML agrupa itens por família. O modelo legado (item com N variações) é
-- representável pelos campos external_variant_id/external_ids sem mudar o grão.
--
-- Identificadores externos EXTENSÍVEIS (sobrevivem à migração legado → UP):
--   external_listing_id  — ML: item_id (MLB…)
--   external_variant_id  — ML legado: variation_id dentro do item (NULL no UP)
--   external_product_id  — ML: user_product_id (MLBU…)
--   external_group_id    — ML: family_id
--   external_ids (jsonb) — qualquer outro id que o canal devolver
--
-- Unicidade: uma variação tem no máximo UM vínculo VIVO por integração
-- (partial unique, WHERE local_status <> 'closed'). Anúncio encerrado não
-- bloqueia republicar. Se no futuro existir motivo explícito para vários
-- anúncios da mesma variação (ex.: condições de venda diferentes no mesmo
-- User Product — o ML permite até 30 itens por UP), basta acrescentar uma
-- coluna de "slot" ao índice — nada aqui é irreversível.
--
-- Estados:
--   local_status   — do Qarvon: draft | publishing | active | paused | error | closed
--                    'paused' = pausa MANUAL feita pelo usuário (nunca desfeita sozinha)
--   external_status/external_sub_status — texto cru do canal (active, paused,
--                    closed, under_review… / out_of_stock, paused_by_seller…);
--                    nunca substitui local_status.
--
-- Idempotência de publicação: rpc_begin_channel_listing_publish cria/assume
-- a linha em 'publishing' com lease (attempt_id) ANTES de chamar o canal;
-- rpc_complete/fail finalizam só se o attempt ainda for o dono. Um lease
-- vencido em 'publishing' significa "o canal pode ter criado o anúncio e o
-- processo caiu antes de salvar" → exige RECONCILIAÇÃO (busca por
-- seller_sku) antes de qualquer nova tentativa, nunca republicação cega.
--
-- 100% aditiva: tabela nova + RPCs novas. Nenhuma tabela existente muda.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.channel_listings (
  id                        BIGSERIAL     PRIMARY KEY,
  company_id                INT           NOT NULL REFERENCES public.companies(id),
  integration_id            BIGINT        NOT NULL REFERENCES public.company_integrations(id),
  provider                  TEXT          NOT NULL,
  product_id                INT           NOT NULL REFERENCES public.products(id),
  product_variation_id      INT           NOT NULL REFERENCES public.product_variations(id),

  -- SKU enviado ao canal = sku_variation da variação vendável (kit: SKU do kit).
  seller_sku                TEXT          NOT NULL,

  external_listing_id       TEXT,
  external_variant_id       TEXT,
  external_product_id       TEXT,
  external_group_id         TEXT,
  external_ids              JSONB         NOT NULL DEFAULT '{}'::jsonb,
  external_category_id      TEXT,
  external_status           TEXT,
  external_sub_status       TEXT[],
  permalink                 TEXT,

  local_status              TEXT          NOT NULL DEFAULT 'draft',

  -- Preço: NULL = herda o preço do Qarvon (variação ?? produto). Valor =
  -- preço específico do canal (ex.: ML 59,90 × varejo 49,90), sem tabela nova.
  channel_price             NUMERIC(12,2),
  last_sent_price           NUMERIC(12,2),
  synced_quantity           INT,
  last_synced_at            TIMESTAMPTZ,
  last_error                TEXT,

  -- Lease da publicação (idempotência).
  publish_attempt_id        UUID,
  publish_lease_until       TIMESTAMPTZ,

  -- Conteúdo específico do canal (tipo de anúncio, atributos escolhidos,
  -- descrição, family_name, modelo UP/legado…). Nunca segredo.
  metadata                  JSONB         NOT NULL DEFAULT '{}'::jsonb,

  created_by                UUID,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT channel_listings_local_status_valid
    CHECK (local_status IN ('draft', 'publishing', 'active', 'paused', 'error', 'closed')),
  CONSTRAINT channel_listings_channel_price_positive
    CHECK (channel_price IS NULL OR channel_price > 0),
  CONSTRAINT channel_listings_synced_quantity_non_negative
    CHECK (synced_quantity IS NULL OR synced_quantity >= 0)
);

-- 1 vínculo vivo por variação × integração.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_listings_live_variation
  ON public.channel_listings (integration_id, product_variation_id)
  WHERE local_status <> 'closed';

-- O mesmo anúncio externo nunca é vinculado duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_listings_external_listing
  ON public.channel_listings (integration_id, external_listing_id)
  WHERE external_listing_id IS NOT NULL AND external_variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_listings_external_variant
  ON public.channel_listings (integration_id, external_listing_id, external_variant_id)
  WHERE external_listing_id IS NOT NULL AND external_variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_listings_company_product
  ON public.channel_listings (company_id, product_id);
-- "Quais anúncios usam esta variação?" (futuro stock.changed → canais)
CREATE INDEX IF NOT EXISTS idx_channel_listings_variation
  ON public.channel_listings (product_variation_id)
  WHERE local_status IN ('active', 'paused');
CREATE INDEX IF NOT EXISTS idx_channel_listings_seller_sku
  ON public.channel_listings (integration_id, seller_sku);

DROP TRIGGER IF EXISTS trg_channel_listings_touch_updated_at ON public.channel_listings;
CREATE TRIGGER trg_channel_listings_touch_updated_at
  BEFORE UPDATE ON public.channel_listings
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- Integridade multi-tenant no banco: integração, produto e variação têm de
-- ser da MESMA empresa da linha (defesa em profundidade além do backend).
CREATE OR REPLACE FUNCTION public.fn_channel_listings_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_integrations
    WHERE id = NEW.integration_id AND company_id = NEW.company_id AND provider = NEW.provider
  ) THEN
    RAISE EXCEPTION 'Integração não pertence à empresa (ou provider divergente).' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = NEW.product_variation_id AND p.id = NEW.product_id AND p.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Variação/produto não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_listings_validate ON public.channel_listings;
CREATE TRIGGER trg_channel_listings_validate
  BEFORE INSERT OR UPDATE OF company_id, integration_id, provider, product_id, product_variation_id
  ON public.channel_listings
  FOR EACH ROW EXECUTE FUNCTION public.fn_channel_listings_validate();

COMMENT ON TABLE public.channel_listings IS
  'Vínculo genérico variação vendável Qarvon ↔ anúncio em canal (Marketplace Hub). Quantidade SEMPRE vem da camada central de disponibilidade (produto normal ou kit, transparente). Ids externos extensíveis para suportar User Products do ML.';


-- ─── RPCs de publicação idempotente ─────────────────────────────────────────

-- Reserva a publicação. Resultados:
--   claimed               → pode chamar o canal (linha em 'publishing' com este attempt)
--   already_published     → já existe vínculo ativo/pausado (nada a fazer)
--   in_progress           → outra tentativa com lease vivo
--   needs_reconciliation  → tentativa anterior caiu no meio; reconciliar antes
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
  p_user_id              uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT id, local_status, publish_lease_until, external_listing_id INTO v_row
  FROM channel_listings
  WHERE integration_id = p_integration_id
    AND product_variation_id = p_product_variation_id
    AND company_id = p_company_id
    AND local_status <> 'closed'
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
    -- draft / error sem id externo → reaproveita a linha
    UPDATE channel_listings
    SET local_status = 'publishing', publish_attempt_id = p_attempt_id,
        publish_lease_until = NOW() + make_interval(secs => GREATEST(p_lease_seconds, 10)),
        seller_sku = p_seller_sku, channel_price = p_channel_price,
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
        last_error = NULL
    WHERE id = v_row.id;
    RETURN jsonb_build_object('result', 'claimed', 'listing_id', v_row.id);
  END IF;

  INSERT INTO channel_listings (
    company_id, integration_id, provider, product_id, product_variation_id, seller_sku,
    local_status, publish_attempt_id, publish_lease_until, channel_price, metadata, created_by
  )
  VALUES (
    p_company_id, p_integration_id, p_provider, p_product_id, p_product_variation_id, p_seller_sku,
    'publishing', p_attempt_id, NOW() + make_interval(secs => GREATEST(p_lease_seconds, 10)),
    p_channel_price, COALESCE(p_metadata, '{}'::jsonb), p_user_id
  )
  RETURNING id INTO v_row;
  RETURN jsonb_build_object('result', 'claimed', 'listing_id', v_row.id);
EXCEPTION
  WHEN unique_violation THEN
    -- corrida: outro processo inseriu no mesmo instante
    RETURN jsonb_build_object('result', 'in_progress');
END;
$$;

-- Finaliza com os ids externos (só o dono do attempt). p_attempt_id NULL =
-- reconciliação (a linha está em 'publishing' com lease vencido ou 'error').
CREATE OR REPLACE FUNCTION public.rpc_complete_channel_listing_publish(
  p_company_id          int,
  p_listing_id          bigint,
  p_attempt_id          uuid,
  p_external_listing_id text,
  p_external_variant_id text,
  p_external_product_id text,
  p_external_group_id   text,
  p_external_ids        jsonb,
  p_external_category_id text,
  p_external_status     text,
  p_external_sub_status text[],
  p_permalink           text,
  p_sent_price          numeric,
  p_synced_quantity     int,
  p_warning             text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE channel_listings
  SET external_listing_id  = p_external_listing_id,
      external_variant_id  = p_external_variant_id,
      external_product_id  = p_external_product_id,
      external_group_id    = p_external_group_id,
      external_ids         = COALESCE(external_ids, '{}'::jsonb) || COALESCE(p_external_ids, '{}'::jsonb),
      external_category_id = COALESCE(p_external_category_id, external_category_id),
      external_status      = p_external_status,
      external_sub_status  = p_external_sub_status,
      permalink            = p_permalink,
      local_status         = CASE WHEN p_external_status = 'closed' THEN 'closed' ELSE 'active' END,
      last_sent_price      = p_sent_price,
      synced_quantity      = p_synced_quantity,
      last_synced_at       = NOW(),
      last_error           = p_warning,
      publish_attempt_id   = NULL,
      publish_lease_until  = NULL
  WHERE id = p_listing_id
    AND company_id = p_company_id
    AND (
      (p_attempt_id IS NOT NULL AND publish_attempt_id = p_attempt_id AND local_status = 'publishing')
      OR (p_attempt_id IS NULL AND local_status IN ('publishing', 'error')
          AND (publish_lease_until IS NULL OR publish_lease_until < NOW()))
    );
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fail_channel_listing_publish(
  p_company_id int,
  p_listing_id bigint,
  p_attempt_id uuid,
  p_error      text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE channel_listings
  SET local_status = 'error', last_error = left(p_error, 1000),
      publish_attempt_id = NULL, publish_lease_until = NULL
  WHERE id = p_listing_id
    AND company_id = p_company_id
    AND (
      (p_attempt_id IS NOT NULL AND publish_attempt_id = p_attempt_id AND local_status = 'publishing')
      OR (p_attempt_id IS NULL AND local_status = 'publishing' AND publish_lease_until < NOW())
    );
  RETURN FOUND;
END;
$$;

-- ─── RLS / grants: deny-by-default, só service_role ─────────────────────────

ALTER TABLE public.channel_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.channel_listings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.channel_listings TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.channel_listings_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_complete_channel_listing_publish(int, bigint, uuid, text, text, text, text, jsonb, text, text, text[], text, numeric, int, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_fail_channel_listing_publish(int, bigint, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_begin_channel_listing_publish(int, bigint, text, int, int, text, uuid, int, numeric, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_complete_channel_listing_publish(int, bigint, uuid, text, text, text, text, jsonb, text, text, text[], text, numeric, int, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_fail_channel_listing_publish(int, bigint, uuid, text) TO service_role;

COMMIT;
