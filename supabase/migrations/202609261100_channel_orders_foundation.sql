-- =============================================================================
-- 202609261100_channel_orders_foundation.sql — Fase 3 Mercado Livre (pedidos)
--
-- Fluxo inverso: MARKETPLACE → pedido → Qarvon (venda, estoque, financeiro),
-- com estruturas GENÉRICAS (nada de mercadolivre_orders):
--
--   1. sales.sales_channel aceita 'mercadolivre' (CHECK backward-safe).
--   2. sale_payments: external_payment_id + metadata (método ORIGINAL do canal).
--   3. inbound_events: fila de notificações recebidas (webhook só persiste e
--      responde 200; worker processa). Claim concorrente (SKIP LOCKED),
--      recuperação de 'processing' preso, backoff, dead-letter, coalescência
--      de notificações repetidas do mesmo recurso enquanto aberto.
--   4. channel_orders / channel_order_items: pedido do canal (snapshot,
--      estados separados do canal × processamento Qarvon, valores financeiros
--      REAIS vindos da API, vínculo sale_id).
--   5. rpc_create_sale ganha p_earn_cashback (DEFAULT true — nenhum canal
--      existente muda; marketplace passa false).
--   6. rpc_import_channel_order: UMA transação — lock do pedido, NO-OP se já
--      importado, valida itens/estoque, cria venda (core: itens, pagamento,
--      baixa online com prioridade de locais, kits, outbox sale.completed),
--      registra tarifa/frete do vendedor no financeiro e grava sale_id.
--      Falta de estoque/regra de negócio → needs_attention (sem venda parcial,
--      sem saldo negativo, sem erro eterno).
--   7. rpc_sync_channel_order_costs: custos que mudam depois (etiqueta/tarifa)
--      postam só a DIFERENÇA — nunca duplicam lançamento.
--   8. rpc_cancel_channel_order: cancela a venda UMA vez (estoque/kits voltam
--      pelo core), estorna tarifa/frete lançados; repetição = NO-OP.
--   9. DRE: tarifas_marketplace (despesa variável, líquida de estornos) e
--      frete líquido de estornos.
--  10. Estoque → canais: o processador de disponibilidade marca
--      channel_listings.stock_sync_pending (durável, mesma transação) e
--      devolve as variações alteradas. O importador NÃO empurra estoque.
--
-- Pré-requisitos: 202609261000_marketplace_enums.sql (commitada antes),
-- 202609231000..1300 (kits), 202609241000 (OAuth ML), 202609251000 (listings).
-- =============================================================================

BEGIN;

-- ─── 1. Canal da venda ──────────────────────────────────────────────────────

ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_sales_channel_valid;
ALTER TABLE public.sales
  ADD CONSTRAINT sales_sales_channel_valid
    CHECK (sales_channel IS NULL OR sales_channel IN ('pos', 'manual', 'whatsapp', 'nuvemshop', 'wholesale_site', 'mercadolivre')) NOT VALID;
ALTER TABLE public.sales VALIDATE CONSTRAINT sales_sales_channel_valid;

-- ─── 2. Pagamento: id externo + método original ────────────────────────────

ALTER TABLE public.sale_payments ADD COLUMN IF NOT EXISTS external_payment_id TEXT;
ALTER TABLE public.sale_payments ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Um pagamento externo pertence a no máximo UMA linha de pagamento por
-- adquirente/canal na empresa (idempotência também do pagamento).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_payments_external
  ON public.sale_payments (company_id, acquirer, external_payment_id)
  WHERE external_payment_id IS NOT NULL;

-- ─── 3. inbound_events ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.inbound_events (
  id                 BIGSERIAL    PRIMARY KEY,
  company_id         INT          NOT NULL REFERENCES public.companies(id),
  integration_id     BIGINT       NOT NULL REFERENCES public.company_integrations(id) ON DELETE CASCADE,
  provider           TEXT         NOT NULL,
  topic              TEXT         NOT NULL,
  resource           TEXT         NOT NULL,
  -- Chave de coalescência: notificações repetidas do MESMO recurso viram
  -- um único evento enquanto ele estiver aberto (pending/failed).
  dedup_key          TEXT         NOT NULL,
  external_event_id  TEXT,
  status             TEXT         NOT NULL DEFAULT 'pending',
  attempts           INT          NOT NULL DEFAULT 0,
  received_count     INT          NOT NULL DEFAULT 1,
  available_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  locked_at          TIMESTAMPTZ,
  locked_by          TEXT,
  last_error         TEXT,
  -- Payload MÍNIMO da notificação (topic/resource/ids/datas) — nunca token.
  payload            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMPTZ,

  CONSTRAINT inbound_events_status_valid
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_events_open
  ON public.inbound_events (integration_id, dedup_key)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_inbound_events_claim
  ON public.inbound_events (provider, status, available_at)
  WHERE status IN ('pending', 'failed', 'processing');
CREATE INDEX IF NOT EXISTS idx_inbound_events_company
  ON public.inbound_events (company_id, created_at DESC);

-- Enfileira uma notificação. A EMPRESA/INTEGRAÇÃO é resolvida AQUI pela
-- conta externa (user_id do ML) — nunca vem do corpo da notificação.
CREATE OR REPLACE FUNCTION public.rpc_enqueue_inbound_event(
  p_provider            text,
  p_external_account_id text,
  p_topic               text,
  p_resource            text,
  p_dedup_key           text,
  p_external_event_id   text,
  p_payload             jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_int record;
  v_id  bigint;
  v_new boolean;
BEGIN
  SELECT id, company_id INTO v_int
  FROM company_integrations
  WHERE provider = p_provider
    AND external_account_id = p_external_account_id
    AND status IN ('active', 'needs_reauth', 'error')
  ORDER BY id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'unknown_account');
  END IF;

  INSERT INTO inbound_events (company_id, integration_id, provider, topic, resource, dedup_key, external_event_id, payload)
  VALUES (v_int.company_id, v_int.id, p_provider, p_topic, p_resource, p_dedup_key, p_external_event_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (integration_id, dedup_key) WHERE status IN ('pending', 'failed')
  DO UPDATE SET received_count = inbound_events.received_count + 1,
                available_at   = LEAST(inbound_events.available_at, NOW()),
                payload        = EXCLUDED.payload,
                updated_at     = NOW()
  RETURNING id, (xmax = 0) INTO v_id, v_new;

  RETURN jsonb_build_object('result', CASE WHEN v_new THEN 'queued' ELSE 'coalesced' END,
                            'event_id', v_id, 'company_id', v_int.company_id, 'integration_id', v_int.id);
END;
$$;

-- Claim concorrente: pending/failed disponíveis + 'processing' preso há mais
-- de p_stale_seconds (worker morreu) — mesmo padrão SKIP LOCKED das deliveries.
CREATE OR REPLACE FUNCTION public.rpc_claim_inbound_events(
  p_provider      text,
  p_limit         int  DEFAULT 10,
  p_worker_id     text DEFAULT 'unknown',
  p_stale_seconds int  DEFAULT 300
)
RETURNS SETOF public.inbound_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE inbound_events
  SET status = 'processing', locked_at = NOW(), locked_by = p_worker_id,
      attempts = attempts + 1, updated_at = NOW()
  WHERE id IN (
    SELECT id FROM inbound_events
    WHERE provider = p_provider
      AND (
        (status IN ('pending', 'failed') AND available_at <= NOW())
        OR (status = 'processing' AND locked_at < NOW() - make_interval(secs => GREATEST(p_stale_seconds, 30)))
      )
    ORDER BY available_at, id
    LIMIT GREATEST(p_limit, 1)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

-- Fim do processamento — só o dono do lock (fencing por locked_by).
CREATE OR REPLACE FUNCTION public.rpc_finish_inbound_event(
  p_event_id  bigint,
  p_worker_id text,
  p_status    text,              -- processed | failed | dead
  p_error     text DEFAULT NULL,
  p_retry_at  timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('processed', 'failed', 'dead') THEN
    RAISE EXCEPTION 'status inválido: %', p_status USING ERRCODE = 'P0001';
  END IF;
  BEGIN
    UPDATE inbound_events
    SET status       = p_status,
        last_error   = CASE WHEN p_status = 'processed' THEN NULL ELSE left(p_error, 1000) END,
        available_at = CASE WHEN p_status = 'failed' THEN COALESCE(p_retry_at, NOW() + INTERVAL '1 minute') ELSE available_at END,
        processed_at = CASE WHEN p_status = 'processed' THEN NOW() ELSE processed_at END,
        locked_at    = NULL,
        locked_by    = NULL,
        updated_at   = NOW()
    WHERE id = p_event_id AND status = 'processing' AND locked_by = p_worker_id;
    RETURN FOUND;
  EXCEPTION WHEN unique_violation THEN
    -- Voltar a 'failed' colidiria com um evento mais novo já aberto para o
    -- mesmo recurso: o novo cobre este — encerra como processado.
    UPDATE inbound_events
    SET status = 'processed', processed_at = NOW(), last_error = left('coalescido: ' || COALESCE(p_error, ''), 1000),
        locked_at = NULL, locked_by = NULL, updated_at = NOW()
    WHERE id = p_event_id AND status = 'processing' AND locked_by = p_worker_id;
    RETURN FOUND;
  END;
END;
$$;

-- ─── 4. channel_orders / channel_order_items ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_orders (
  id                     BIGSERIAL     PRIMARY KEY,
  company_id             INT           NOT NULL REFERENCES public.companies(id),
  integration_id         BIGINT        NOT NULL REFERENCES public.company_integrations(id),
  provider               TEXT          NOT NULL,
  external_order_id      TEXT          NOT NULL,
  external_pack_id       TEXT,
  external_shipment_id   TEXT,

  -- Estado do CANAL (texto do provider) × estado de PROCESSAMENTO no Qarvon.
  channel_status         TEXT,
  payment_status         TEXT,
  shipping_status        TEXT,
  shipping_substatus     TEXT,
  shipping_mode          TEXT,
  shipping_logistic_type TEXT,
  tracking_number        TEXT,
  processing_state       TEXT          NOT NULL DEFAULT 'pending',
  attention_code         TEXT,
  attention_reason       TEXT,

  sale_id                INT           REFERENCES public.sales(id),
  customer_id            INT           REFERENCES public.customers(id),
  buyer_external_id      TEXT,
  buyer_nickname         TEXT,

  -- Valores REAIS da API do canal (nunca percentual estimado).
  currency               TEXT,
  gross_amount           NUMERIC(12,2),   -- Σ unit_price × qty (valor comercial)
  paid_amount            NUMERIC(12,2),   -- pago pelo comprador (inclui frete/juros dele)
  marketplace_fees       NUMERIC(12,2),   -- tarifa de venda do canal
  shipping_cost_seller   NUMERIC(12,2),   -- frete efetivamente a cargo do vendedor
  shipping_cost_buyer    NUMERIC(12,2),   -- frete pago pelo comprador (informativo)
  other_costs            NUMERIC(12,2),   -- outros encargos identificáveis (0 se nenhum)
  taxes_amount           NUMERIC(12,2),
  net_amount             NUMERIC(12,2),   -- líquido previsto = bruto − tarifas − frete vendedor − outros
  money_release_date     TIMESTAMPTZ,     -- liberação prevista do dinheiro (quando a API informar)
  -- Já lançado no financeiro (idempotência de custos).
  fees_posted            NUMERIC(12,2) NOT NULL DEFAULT 0,
  shipping_posted        NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- De qual endpoint/campo veio cada valor (auditoria).
  financial_sources      JSONB         NOT NULL DEFAULT '{}'::jsonb,

  is_test                BOOLEAN       NOT NULL DEFAULT false,
  tags                   TEXT[],
  -- Snapshot MÍNIMO sanitizado (sem dados pessoais do comprador).
  raw_snapshot           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  metadata               JSONB         NOT NULL DEFAULT '{}'::jsonb,

  created_at_external    TIMESTAMPTZ,
  updated_at_external    TIMESTAMPTZ,
  last_synced_at         TIMESTAMPTZ,
  imported_at            TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT channel_orders_state_valid
    CHECK (processing_state IN ('pending', 'awaiting_payment', 'needs_attention', 'imported', 'cancelled', 'ignored')),
  CONSTRAINT channel_orders_imported_has_sale
    CHECK (processing_state <> 'imported' OR sale_id IS NOT NULL),
  CONSTRAINT channel_orders_posted_non_negative
    CHECK (fees_posted >= 0 AND shipping_posted >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_orders_external
  ON public.channel_orders (company_id, integration_id, external_order_id);
-- Uma venda pertence a no máximo UM pedido de canal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_orders_sale
  ON public.channel_orders (sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channel_orders_company_state
  ON public.channel_orders (company_id, processing_state, created_at DESC);

CREATE TABLE IF NOT EXISTS public.channel_order_items (
  id                        BIGSERIAL     PRIMARY KEY,
  channel_order_id          BIGINT        NOT NULL REFERENCES public.channel_orders(id) ON DELETE CASCADE,
  company_id                INT           NOT NULL REFERENCES public.companies(id),
  line_no                   INT           NOT NULL,
  external_item_id          TEXT          NOT NULL,
  external_variation_id     TEXT,
  external_user_product_id  TEXT,
  seller_sku                TEXT,
  title                     TEXT,
  quantity                  INT           NOT NULL,
  unit_price                NUMERIC(12,2) NOT NULL,
  -- Tarifa de venda da LINHA (sale_fee × quantidade), da API.
  sale_fee                  NUMERIC(12,2),
  listing_type_id           TEXT,
  channel_listing_id        BIGINT        REFERENCES public.channel_listings(id),
  product_variation_id      INT           REFERENCES public.product_variations(id),
  mapping_status            TEXT          NOT NULL DEFAULT 'unmapped',
  mapping_note              TEXT,
  -- COMO a oferta foi resolvida (auditoria):
  --   exact                     item_id exato → channel_listing_id (caminho normal)
  --   user_product_id|seller_sku fallback com UM anúncio inequívoco
  --   ambiguous_same_variation  fallback achou N anúncios, TODOS da mesma
  --                             variação → importa pela variação, SEM inventar
  --                             channel_listing_id (fica NULL)
  --   unmapped | conflict       não importa
  listing_resolution        TEXT          NOT NULL DEFAULT 'unmapped',
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT channel_order_items_qty_positive CHECK (quantity > 0),
  CONSTRAINT channel_order_items_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT channel_order_items_mapping_valid CHECK (mapping_status IN ('mapped', 'unmapped', 'conflict')),
  CONSTRAINT channel_order_items_mapped_has_variation
    CHECK (mapping_status <> 'mapped' OR product_variation_id IS NOT NULL),
  CONSTRAINT channel_order_items_resolution_valid
    CHECK (listing_resolution IN ('exact', 'user_product_id', 'seller_sku', 'ambiguous_same_variation', 'unmapped', 'conflict')),
  -- Oferta exata só com anúncio identificado; ambígua nunca tem anúncio.
  CONSTRAINT channel_order_items_resolution_listing
    CHECK ((listing_resolution <> 'exact' OR channel_listing_id IS NOT NULL)
       AND (listing_resolution <> 'ambiguous_same_variation' OR channel_listing_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_order_items_line
  ON public.channel_order_items (channel_order_id, line_no);

DROP TRIGGER IF EXISTS trg_channel_orders_touch_updated_at ON public.channel_orders;
CREATE TRIGGER trg_channel_orders_touch_updated_at
  BEFORE UPDATE ON public.channel_orders
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- Multi-tenant no banco: integração/venda/cliente da MESMA empresa.
CREATE OR REPLACE FUNCTION public.fn_channel_orders_validate()
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
  IF NEW.sale_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales WHERE id = NEW.sale_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Venda não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Cliente não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_orders_validate ON public.channel_orders;
CREATE TRIGGER trg_channel_orders_validate
  BEFORE INSERT OR UPDATE OF company_id, integration_id, provider, sale_id, customer_id
  ON public.channel_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_channel_orders_validate();

CREATE OR REPLACE FUNCTION public.fn_channel_order_items_validate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM channel_orders WHERE id = NEW.channel_order_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Pedido não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.product_variation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = NEW.product_variation_id AND p.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Variação não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.channel_listing_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM channel_listings WHERE id = NEW.channel_listing_id AND company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Anúncio não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_channel_order_items_validate ON public.channel_order_items;
CREATE TRIGGER trg_channel_order_items_validate
  BEFORE INSERT OR UPDATE ON public.channel_order_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_channel_order_items_validate();

-- Upsert do snapshot do pedido (cabeçalho + itens). NUNCA muda estado de
-- importação/cancelamento nem sale_id; itens só são substituídos enquanto o
-- pedido não virou venda (depois disso a venda é a verdade comercial).
CREATE OR REPLACE FUNCTION public.rpc_upsert_channel_order(
  p_company_id     int,
  p_integration_id bigint,
  p_provider       text,
  p_order          jsonb,
  p_items          jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row  record;
  v_item jsonb;
  v_line int := 0;
BEGIN
  IF COALESCE(p_order->>'external_order_id', '') = '' THEN
    RAISE EXCEPTION 'external_order_id obrigatório' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO channel_orders (company_id, integration_id, provider, external_order_id)
  VALUES (p_company_id, p_integration_id, p_provider, p_order->>'external_order_id')
  ON CONFLICT (company_id, integration_id, external_order_id) DO NOTHING;

  SELECT * INTO v_row FROM channel_orders
  WHERE company_id = p_company_id AND integration_id = p_integration_id AND external_order_id = p_order->>'external_order_id'
  FOR UPDATE;

  UPDATE channel_orders SET
    external_pack_id       = NULLIF(p_order->>'external_pack_id', ''),
    external_shipment_id   = COALESCE(NULLIF(p_order->>'external_shipment_id', ''), external_shipment_id),
    channel_status         = p_order->>'channel_status',
    payment_status         = p_order->>'payment_status',
    shipping_status        = COALESCE(p_order->>'shipping_status', shipping_status),
    shipping_substatus     = COALESCE(p_order->>'shipping_substatus', shipping_substatus),
    shipping_mode          = COALESCE(p_order->>'shipping_mode', shipping_mode),
    shipping_logistic_type = COALESCE(p_order->>'shipping_logistic_type', shipping_logistic_type),
    tracking_number        = COALESCE(p_order->>'tracking_number', tracking_number),
    buyer_external_id      = p_order->>'buyer_external_id',
    buyer_nickname         = p_order->>'buyer_nickname',
    currency               = p_order->>'currency',
    gross_amount           = (p_order->>'gross_amount')::numeric,
    paid_amount            = (p_order->>'paid_amount')::numeric,
    marketplace_fees       = (p_order->>'marketplace_fees')::numeric,
    shipping_cost_seller   = COALESCE((p_order->>'shipping_cost_seller')::numeric, shipping_cost_seller),
    shipping_cost_buyer    = COALESCE((p_order->>'shipping_cost_buyer')::numeric, shipping_cost_buyer),
    other_costs            = COALESCE((p_order->>'other_costs')::numeric, other_costs),
    taxes_amount           = (p_order->>'taxes_amount')::numeric,
    net_amount             = (p_order->>'net_amount')::numeric,
    money_release_date     = COALESCE((p_order->>'money_release_date')::timestamptz, money_release_date),
    financial_sources      = COALESCE(p_order->'financial_sources', financial_sources),
    is_test                = COALESCE((p_order->>'is_test')::boolean, is_test),
    tags                   = ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_order->'tags', '[]'::jsonb))),
    raw_snapshot           = COALESCE(p_order->'raw_snapshot', raw_snapshot),
    -- Avisos de resolução de oferta etc. (ex.: listing_resolution_warnings) — auditáveis.
    metadata               = metadata || COALESCE(p_order->'metadata', '{}'::jsonb),
    created_at_external    = (p_order->>'created_at_external')::timestamptz,
    updated_at_external    = (p_order->>'updated_at_external')::timestamptz,
    last_synced_at         = NOW()
  WHERE id = v_row.id;

  IF v_row.sale_id IS NULL AND v_row.processing_state NOT IN ('imported', 'cancelled') THEN
    DELETE FROM channel_order_items WHERE channel_order_id = v_row.id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
      v_line := v_line + 1;
      INSERT INTO channel_order_items (
        channel_order_id, company_id, line_no, external_item_id, external_variation_id, external_user_product_id,
        seller_sku, title, quantity, unit_price, sale_fee, listing_type_id,
        channel_listing_id, product_variation_id, mapping_status, mapping_note, listing_resolution
      ) VALUES (
        v_row.id, p_company_id, v_line, v_item->>'external_item_id', NULLIF(v_item->>'external_variation_id', ''),
        NULLIF(v_item->>'external_user_product_id', ''), NULLIF(v_item->>'seller_sku', ''), left(v_item->>'title', 300),
        (v_item->>'quantity')::int, (v_item->>'unit_price')::numeric, (v_item->>'sale_fee')::numeric, v_item->>'listing_type_id',
        NULLIF(v_item->>'channel_listing_id', '')::bigint, NULLIF(v_item->>'product_variation_id', '')::int,
        COALESCE(v_item->>'mapping_status', 'unmapped'), left(v_item->>'mapping_note', 500),
        COALESCE(v_item->>'listing_resolution',
                 CASE WHEN COALESCE(v_item->>'mapping_status', 'unmapped') <> 'mapped' THEN COALESCE(v_item->>'mapping_status', 'unmapped')
                      WHEN NULLIF(v_item->>'channel_listing_id', '') IS NOT NULL THEN 'exact'
                      -- variação conhecida, oferta exata não: nunca inventa channel_listing_id
                      ELSE 'ambiguous_same_variation' END)
      );
    END LOOP;
  END IF;

  SELECT id, processing_state, sale_id INTO v_row FROM channel_orders WHERE id = v_row.id;
  RETURN jsonb_build_object('channel_order_id', v_row.id, 'processing_state', v_row.processing_state, 'sale_id', v_row.sale_id);
END;
$$;

-- Estados "antes da venda" (nunca imported/cancelled — esses só pelas RPCs
-- de importação/cancelamento).
CREATE OR REPLACE FUNCTION public.rpc_set_channel_order_state(
  p_company_id       int,
  p_channel_order_id bigint,
  p_state            text,
  p_code             text DEFAULT NULL,
  p_reason           text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_state NOT IN ('pending', 'awaiting_payment', 'needs_attention', 'ignored') THEN
    RAISE EXCEPTION 'estado não permitido aqui: %', p_state USING ERRCODE = 'P0001';
  END IF;
  UPDATE channel_orders
  SET processing_state = p_state,
      attention_code   = CASE WHEN p_state = 'needs_attention' THEN p_code ELSE NULL END,
      attention_reason = CASE WHEN p_state = 'needs_attention' THEN left(p_reason, 1000) ELSE NULL END
  WHERE id = p_channel_order_id AND company_id = p_company_id
    AND sale_id IS NULL AND processing_state NOT IN ('imported', 'cancelled');
  RETURN FOUND;
END;
$$;

-- ─── 5. rpc_create_sale + p_earn_cashback ──────────────────────────────────
-- Corpo IDÊNTICO ao de 202609231100_rpc_create_sale_kits.sql, exceto:
-- (a) parâmetro novo p_earn_cashback (DEFAULT true) e (b) o bloco de
-- crédito de cashback só roda com p_earn_cashback. Assinatura muda → DROP
-- da antiga para continuar existindo UM único rpc_create_sale.

DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb, text, text
);

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id           int,
  p_seller_id             uuid,
  p_payment_method        payment_method,
  p_sale_origin           text,
  p_discount_amount       numeric,
  p_cashback_used         numeric,
  p_shipping_charged      numeric,
  p_notes                 text,
  p_items                 jsonb,
  p_system_user_id        uuid,
  p_card_fee              numeric  DEFAULT 0,
  p_surcharge_amount      numeric  DEFAULT 0,
  p_payments              jsonb    DEFAULT NULL,
  p_cash_session_id       bigint   DEFAULT NULL,
  p_stock_mode            text     DEFAULT 'main_store',
  p_responsible_seller_id int      DEFAULT NULL,
  p_delivery_recipient    jsonb    DEFAULT NULL,
  -- Modalidade COMERCIAL da venda — retail/wholesale (fundação varejo/
  -- atacado, 2026-08-31). Nunca inferida — sempre explícita do caller;
  -- default 'retail' cobre todo caller que ainda não sabe sobre esta
  -- dimensão (ex.: PDV atual, antes de ganhar o seletor).
  p_sale_type             text     DEFAULT 'retail',
  -- Canal/origem OPERACIONAL da venda — pos/manual/whatsapp/nuvemshop/
  -- wholesale_site. NULL = não classificado ainda (ver comentário da
  -- coluna sales.sales_channel).
  p_sales_channel         text     DEFAULT NULL,
  -- Fase 3 marketplace (2026-09-26): marketplace NÃO gera cashback da loja.
  -- DEFAULT true = comportamento de todos os canais existentes inalterado;
  -- só o importador de pedidos de canal passa false, explicitamente.
  p_earn_cashback         boolean  DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id         int;
  v_sale_number     text;
  v_subtotal        numeric := 0;
  v_products_total  numeric;
  v_gross           numeric;
  v_total           numeric;
  v_eff_cashback    numeric;
  v_avail_credit    numeric;
  v_item            jsonb;
  v_pvid            int;
  v_qty             int;
  v_unit_price      numeric;
  v_unit_cost       numeric;
  v_discount        numeric;
  v_item_surcharge  numeric;
  v_list_price      numeric;
  v_current_qty     int;
  v_item_total      numeric;
  v_company_id      int;
  v_item_company    int;
  v_card_fee        numeric;
  v_surcharge       numeric;
  v_brazil_date     date;
  v_main_store_id   int;

  v_pmt             jsonb;
  v_pmt_method      payment_method;
  v_pmt_tendered    numeric;
  v_pmt_change      numeric;
  v_pmt_change_mth  text;
  v_pmt_net         numeric;
  v_pmt_install     int;
  v_pmt_brand       text;
  v_pmt_acquirer    text;
  v_pmt_fee         numeric;
  v_dominant_method payment_method;
  v_max_net         numeric := -1;

  v_online_loc      record;
  v_loc_qty         int;
  v_debit           int;
  v_remaining       int;

  v_is_anon         boolean;
  v_rate_pct        numeric;
  v_release_days    int;
  v_expiry_days     int;
  v_min_order       numeric;
  v_earn_amount     numeric;
  v_earn_status     cashback_status;
  v_earn_release    date;
  v_earn_expiry     date;

  v_recip_source_addr_id int;
  v_recip_addr           record;
  v_recip_cep             text;
  v_recip_logradouro      text;
  v_recip_numero          text;
  v_recip_complemento     text;
  v_recip_bairro          text;
  v_recip_municipio       text;
  v_recip_uf              text;
  v_recip_municipio_ibge  text;
  v_recip_ibge_source     text;

  -- Kits (202609231100)
  v_has_kit         boolean := false;
  v_kind            text;
  v_req             record;
  v_avail           int;
  v_sale_item_id    int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_stock_mode NOT IN ('main_store', 'online_priority') THEN
    RAISE EXCEPTION 'p_stock_mode inválido: %. Aceitos: main_store, online_priority.', p_stock_mode
      USING ERRCODE = 'P0001';
  END IF;

  IF p_sale_type NOT IN ('retail', 'wholesale') THEN
    RAISE EXCEPTION 'p_sale_type inválido: %. Aceitos: retail, wholesale.', p_sale_type
      USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = p_customer_id AND company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Cliente não pertence à empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF p_responsible_seller_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sellers
    WHERE id = p_responsible_seller_id
      AND company_id = v_company_id
      AND active = TRUE
  ) THEN
    RAISE EXCEPTION 'Vendedor responsável inválido ou inativo.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  IF p_stock_mode = 'main_store' THEN
    v_main_store_id := public.fn_main_store_id(v_company_id);
    IF v_main_store_id IS NULL THEN
      RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
        v_company_id USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nenhum item na venda.' USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid           := (v_item->>'product_variation_id')::int;
    v_qty            := (v_item->>'quantity')::int;
    v_unit_price     := (v_item->>'unit_price')::numeric;
    v_discount       := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_surcharge := COALESCE((v_item->>'surcharge_amount')::numeric, 0);

    SELECT p.company_id, p.product_kind INTO v_item_company, v_kind
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS DISTINCT FROM v_company_id THEN
      RAISE EXCEPTION 'Produto não pertence à empresa.' USING ERRCODE = 'P0001';
    END IF;

    IF v_kind = 'kit' THEN
      v_has_kit := true;
      IF COALESCE(v_qty, 0) <= 0 THEN
        RAISE EXCEPTION 'Quantidade inválida para o kit (variação #%).', v_pvid USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM product_kit_components
        WHERE kit_product_variation_id = v_pvid AND company_id = v_company_id
      ) THEN
        RAISE EXCEPTION 'Kit sem composição (variação #%) não pode ser vendido.', v_pvid USING ERRCODE = 'P0001';
      END IF;
    END IF;

    v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount + v_item_surcharge, 2);
  END LOOP;

  v_card_fee       := COALESCE(p_card_fee, 0);
  v_surcharge      := COALESCE(p_surcharge_amount, 0);
  v_products_total := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge, 2);
  v_eff_cashback   := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_gross          := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total          := ROUND(v_gross - v_eff_cashback, 2);

  IF v_eff_cashback > 0 THEN
    IF p_customer_id IS NULL THEN
      RAISE EXCEPTION 'Não é possível usar crédito em venda sem cliente identificado.'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT GREATEST(0,
      COALESCE(SUM(CASE
                     WHEN type = 'earn'
                      AND status = 'available'
                      AND amount > 0
                      AND (expiry_date IS NULL OR expiry_date > CURRENT_DATE)
                     THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'use' THEN amount ELSE 0 END), 0)
    ) INTO v_avail_credit
    FROM cashback_transactions
    WHERE customer_id = p_customer_id
      AND company_id  = v_company_id;

    IF v_avail_credit < v_eff_cashback THEN
      RAISE EXCEPTION
        'Saldo de crédito insuficiente. Disponível: R$ %, solicitado: R$ %.',
        v_avail_credit, v_eff_cashback
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  IF v_has_kit THEN
    -- Kits: lock sobre o conjunto FÍSICO (componentes expandidos + itens
    -- standard), ordem determinística por (variação, local).
    IF p_stock_mode = 'main_store' THEN
      FOR v_req IN SELECT * FROM public.fn_resolve_stock_requirements(p_items) LOOP
        PERFORM 1
        FROM stock_balances
        WHERE product_variation_id = v_req.product_variation_id
          AND stock_location_id    = v_main_store_id
        FOR UPDATE;
      END LOOP;
    ELSE
      PERFORM 1
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      WHERE sb.product_variation_id IN (
        SELECT r.product_variation_id FROM public.fn_resolve_stock_requirements(p_items) r
      )
        AND sl.company_id = v_company_id
        AND sl.active     = true
      ORDER BY sb.product_variation_id ASC, sb.stock_location_id ASC
      FOR UPDATE OF sb;
    END IF;

    -- Validação de TODOS os requisitos (já sob lock) antes de qualquer baixa.
    FOR v_req IN SELECT * FROM public.fn_resolve_stock_requirements(p_items) LOOP
      v_avail := public.fn_physical_available_quantity(v_company_id, v_req.product_variation_id, p_stock_mode);
      IF v_avail < v_req.quantity THEN
        RAISE EXCEPTION
          'Estoque insuficiente para a variação % (inclui componentes de kits). Disponível: %, necessário: %.',
          (SELECT sku_variation FROM product_variations WHERE id = v_req.product_variation_id),
          v_avail, v_req.quantity
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  ELSIF p_stock_mode = 'main_store' THEN
    FOR v_pvid IN
      SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
      FROM jsonb_array_elements(p_items) ORDER BY pvid
    LOOP
      PERFORM 1
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id
      FOR UPDATE;
    END LOOP;
  ELSE
    PERFORM 1
    FROM stock_balances sb
    JOIN stock_locations sl ON sl.id = sb.stock_location_id
    WHERE sb.product_variation_id IN (
      SELECT DISTINCT (value->>'product_variation_id')::int
      FROM jsonb_array_elements(p_items)
    )
      AND sl.company_id = v_company_id
      AND sl.active     = true
    ORDER BY sb.product_variation_id ASC, sb.stock_location_id ASC
    FOR UPDATE OF sb;
  END IF;

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    products_total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id,
    responsible_seller_id, sale_type, sales_channel
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    v_products_total,
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id,
    p_responsible_seller_id, p_sale_type, NULLIF(p_sales_channel, '')
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  IF v_eff_cashback > 0 AND p_customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      used_at, used_in_sale_id
    )
    VALUES (
      p_customer_id, v_company_id, v_sale_id,
      'use', v_eff_cashback, 'used',
      NOW(), v_sale_id
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid           := (v_item->>'product_variation_id')::int;
    v_qty            := (v_item->>'quantity')::int;
    v_unit_price     := (v_item->>'unit_price')::numeric;
    v_unit_cost      := (v_item->>'unit_cost')::numeric;
    v_discount       := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_surcharge := COALESCE((v_item->>'surcharge_amount')::numeric, 0);
    v_list_price     := NULLIF(v_item->>'list_price_snapshot', '')::numeric;
    v_item_total     := ROUND(v_unit_price * v_qty - v_discount + v_item_surcharge, 2);

    v_kind := NULL;
    IF v_has_kit THEN
      SELECT p.product_kind INTO v_kind
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_pvid;

      IF v_kind = 'kit' THEN
        -- Custo autoritativo do kit = soma dos componentes (snapshot).
        SELECT ROUND(COALESCE(SUM(ROUND(COALESCE(cpv.cost_override, cp.base_cost, 0), 2) * kc.quantity), 0), 2)
        INTO v_unit_cost
        FROM product_kit_components kc
        JOIN product_variations cpv ON cpv.id = kc.component_product_variation_id
        JOIN products cp            ON cp.id  = cpv.product_id
        WHERE kc.kit_product_variation_id = v_pvid;
      END IF;
    END IF;

    INSERT INTO sale_items (
      sale_id, product_variation_id, quantity,
      unit_price, unit_cost, discount_amount, surcharge_amount, list_price_snapshot, total_price
    )
    VALUES (v_sale_id, v_pvid, v_qty, v_unit_price, v_unit_cost, v_discount, v_item_surcharge, v_list_price, v_item_total)
    RETURNING id INTO v_sale_item_id;

    IF v_kind = 'kit' THEN
      PERFORM public._consume_kit_components(
        v_company_id, v_sale_id, v_sale_item_id, v_pvid, v_qty,
        p_stock_mode, v_main_store_id, p_system_user_id
      );
      CONTINUE;
    END IF;

    IF p_stock_mode = 'main_store' THEN

      SELECT COALESCE(quantity, 0) INTO v_current_qty
      FROM stock_balances
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

      IF COALESCE(v_current_qty, 0) < v_qty THEN
        RAISE EXCEPTION
          'Produto sem saldo no Estoque Loja (variação #%). '
          'Disponível: %, solicitado: %. Transfira antes de vender.',
          v_pvid, COALESCE(v_current_qty, 0), v_qty
          USING ERRCODE = 'P0001';
      END IF;

      UPDATE stock_balances
      SET quantity     = quantity - v_qty,
          last_updated = NOW()
      WHERE product_variation_id = v_pvid
        AND stock_location_id    = v_main_store_id;

      INSERT INTO stock_movements (
        product_variation_id, product_id, type, quantity,
        previous_stock, new_stock, unit_cost, reference_id, company_id,
        source_location_id, movement_type, reference_type, created_by
      )
      SELECT
        v_pvid, pv.product_id,
        'sale', -v_qty,
        v_current_qty, v_current_qty - v_qty,
        v_unit_cost, v_sale_id::text, v_company_id,
        v_main_store_id, 'sale', 'sale', p_system_user_id
      FROM product_variations pv WHERE pv.id = v_pvid;

    ELSE

      SELECT COALESCE(SUM(sb.quantity), 0) INTO v_current_qty
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      WHERE sb.product_variation_id = v_pvid
        AND sl.company_id = v_company_id
        AND sl.active     = true;

      IF v_current_qty < v_qty THEN
        RAISE EXCEPTION
          'Estoque total insuficiente para venda online (variação #%). '
          'Disponível: %, solicitado: %.',
          v_pvid, v_current_qty, v_qty
          USING ERRCODE = 'P0001';
      END IF;

      v_remaining := v_qty;

      FOR v_online_loc IN
        SELECT sl.id AS location_id, sl.priority
        FROM stock_locations sl
        JOIN stock_balances sb ON sb.stock_location_id = sl.id
                              AND sb.product_variation_id = v_pvid
        WHERE sl.company_id = v_company_id
          AND sl.active     = true
          AND sb.quantity   > 0
        ORDER BY sl.priority ASC, sl.id ASC
      LOOP
        EXIT WHEN v_remaining = 0;

        SELECT COALESCE(quantity, 0) INTO v_loc_qty
        FROM stock_balances
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        v_debit     := LEAST(v_remaining, v_loc_qty);
        v_remaining := v_remaining - v_debit;

        UPDATE stock_balances
        SET quantity     = quantity - v_debit,
            last_updated = NOW()
        WHERE product_variation_id = v_pvid
          AND stock_location_id    = v_online_loc.location_id;

        INSERT INTO stock_movements (
          product_variation_id, product_id, type, quantity,
          previous_stock, new_stock, unit_cost, reference_id, company_id,
          source_location_id, movement_type, reference_type, created_by
        )
        SELECT
          v_pvid, pv.product_id,
          'sale', -v_debit,
          v_loc_qty, v_loc_qty - v_debit,
          v_unit_cost, v_sale_id::text, v_company_id,
          v_online_loc.location_id, 'sale', 'online_order', p_system_user_id
        FROM product_variations pv WHERE pv.id = v_pvid;

      END LOOP;

      IF v_remaining > 0 THEN
        RAISE EXCEPTION
          'Erro interno: não foi possível debitar % unidades restantes da variação #%.',
          v_remaining, v_pvid
          USING ERRCODE = 'P0001';
      END IF;

    END IF;

  END LOOP;

  IF v_total > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'sale', 'Venda ' || v_sale_number,
      v_total, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method     := (v_pmt->>'method')::payment_method;
      v_pmt_tendered   := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change     := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net        := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install    := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand      := v_pmt->>'card_brand';
      v_pmt_acquirer   := v_pmt->>'acquirer';
      v_pmt_fee        := COALESCE((v_pmt->>'fee_amount')::numeric, ROUND(v_pmt_net * v_card_fee / 100, 2));

      INSERT INTO sale_payments (
        sale_id, company_id, method,
        amount_tendered, change_amount, change_method,
        net_amount, installments, card_brand, acquirer, fee_amount
      )
      VALUES (
        v_sale_id, v_company_id, v_pmt_method,
        v_pmt_tendered, v_pmt_change,
        v_pmt_change_mth::payment_method,
        v_pmt_net, v_pmt_install, v_pmt_brand, v_pmt_acquirer, v_pmt_fee
      );
    END LOOP;
  END IF;

  IF COALESCE(p_earn_cashback, true) AND COALESCE(p_cashback_used, 0) = 0 AND p_customer_id IS NOT NULL THEN
    SELECT is_anonymous INTO v_is_anon
    FROM customers WHERE id = p_customer_id;

    IF NOT COALESCE(v_is_anon, false) THEN
      SELECT rate_pct, release_days, expiry_days, min_order_value
      INTO v_rate_pct, v_release_days, v_expiry_days, v_min_order
      FROM cashback_config
      WHERE company_id = v_company_id AND active = true
      LIMIT 1;

      IF FOUND AND v_total >= COALESCE(v_min_order, 0) THEN
        v_earn_amount  := ROUND(v_total * v_rate_pct / 100.0, 2);

        IF v_earn_amount > 0 THEN
          v_release_days := COALESCE(v_release_days, 0);
          v_expiry_days  := COALESCE(v_expiry_days, 0);
          v_earn_release := v_brazil_date + v_release_days;
          v_earn_status  := CASE WHEN v_release_days = 0
                                 THEN 'available'::cashback_status
                                 ELSE 'pending'::cashback_status END;
          v_earn_expiry  := CASE WHEN v_expiry_days > 0
                                 THEN v_earn_release + v_expiry_days
                                 ELSE NULL END;

          INSERT INTO cashback_transactions (
            customer_id, company_id, sale_id,
            type, amount, status,
            release_date, expiry_date
          )
          VALUES (
            p_customer_id, v_company_id, v_sale_id,
            'earn', v_earn_amount, v_earn_status,
            v_earn_release, v_earn_expiry
          );
        END IF;
      END IF;
    END IF;
  END IF;

  IF p_delivery_recipient IS NOT NULL THEN
    v_recip_source_addr_id := NULLIF(p_delivery_recipient->>'customer_address_id', '')::int;

    IF v_recip_source_addr_id IS NOT NULL THEN
      SELECT cep, street, number, complement, neighborhood, city, state, municipio_ibge, ibge_source
      INTO v_recip_addr
      FROM customer_addresses
      WHERE id = v_recip_source_addr_id
        AND customer_id = p_customer_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Endereço de entrega selecionado não encontrado para este cliente.' USING ERRCODE = 'P0001';
      END IF;

      v_recip_cep            := v_recip_addr.cep;
      v_recip_logradouro     := v_recip_addr.street;
      v_recip_numero         := v_recip_addr.number;
      v_recip_complemento    := v_recip_addr.complement;
      v_recip_bairro         := v_recip_addr.neighborhood;
      v_recip_municipio      := v_recip_addr.city;
      v_recip_uf              := v_recip_addr.state;
      v_recip_municipio_ibge  := v_recip_addr.municipio_ibge;
      v_recip_ibge_source     := v_recip_addr.ibge_source;

    ELSE
      v_recip_cep            := p_delivery_recipient->>'cep';
      v_recip_logradouro     := p_delivery_recipient->>'logradouro';
      v_recip_numero         := p_delivery_recipient->>'numero';
      v_recip_complemento    := p_delivery_recipient->>'complemento';
      v_recip_bairro         := p_delivery_recipient->>'bairro';
      v_recip_municipio      := p_delivery_recipient->>'municipio';
      v_recip_uf              := UPPER(p_delivery_recipient->>'uf');
      v_recip_municipio_ibge  := NULLIF(p_delivery_recipient->>'municipio_ibge', '');
      v_recip_ibge_source     := NULLIF(p_delivery_recipient->>'ibge_source', '');

      IF COALESCE((p_delivery_recipient->>'save_as_customer_address')::boolean, false) THEN
        IF p_customer_id IS NULL THEN
          RAISE EXCEPTION 'Não é possível salvar endereço reutilizável sem cliente identificado.' USING ERRCODE = 'P0001';
        END IF;

        INSERT INTO customer_addresses (
          customer_id, cep, street, number, complement, neighborhood, city, state,
          municipio_ibge, ibge_source
        )
        VALUES (
          p_customer_id, v_recip_cep, v_recip_logradouro, v_recip_numero, v_recip_complemento,
          v_recip_bairro, v_recip_municipio, v_recip_uf, v_recip_municipio_ibge, v_recip_ibge_source
        )
        RETURNING id INTO v_recip_source_addr_id;
      END IF;
    END IF;

    INSERT INTO sale_recipients (
      sale_id, company_id, source_address_id,
      nome, cpf, cnpj, telefone,
      cep, logradouro, numero, complemento, bairro, municipio, municipio_ibge, uf, ibge_source
    )
    VALUES (
      v_sale_id, v_company_id, v_recip_source_addr_id,
      p_delivery_recipient->>'nome',
      NULLIF(p_delivery_recipient->>'cpf', ''),
      NULLIF(p_delivery_recipient->>'cnpj', ''),
      NULLIF(p_delivery_recipient->>'telefone', ''),
      v_recip_cep, v_recip_logradouro, v_recip_numero, v_recip_complemento,
      v_recip_bairro, v_recip_municipio, v_recip_municipio_ibge, v_recip_uf, v_recip_ibge_source
    );
  END IF;

  -- ─── Evento de domínio (Fase 2 — Integration Foundation) ─────────────────
  -- ÚNICA mudança funcional deste bloco em relação à versão vigente: o
  -- payload ganha sale_type/sales_channel — consumidores futuros (fiscal,
  -- BI, integrações) precisam saber a modalidade/canal sem consultar a
  -- tabela sales de novo. Retrocompatível: apenas 2 chaves novas somadas
  -- ao objeto JSON existente, nenhuma removida/renomeada.
  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_company_id,
    'sale:' || v_sale_id || ':completed',
    'sale.completed',
    'sale',
    v_sale_id::text,
    jsonb_build_object(
      'sale_id',         v_sale_id,
      'sale_number',     v_sale_number,
      'customer_id',     p_customer_id,
      'total',           ROUND(v_total, 2),
      'payment_method',  COALESCE(v_dominant_method, p_payment_method),
      'sale_date',       v_brazil_date,
      'sale_type',       p_sale_type,
      'sales_channel',   p_sales_channel
    )
  );

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb, text, text, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb, text, text, boolean
) TO service_role;

-- ─── 6. Importação transacional ────────────────────────────────────────────

-- Cliente do marketplace: 1 cliente por comprador externo (external_entity_links
-- tipo 'buyer'); sem comprador identificável → 1 cliente genérico por
-- integração. Advisory lock evita 2 clientes para o mesmo comprador em
-- pedidos importados ao mesmo tempo.
CREATE OR REPLACE FUNCTION public._resolve_channel_customer(
  p_company_id     int,
  p_integration_id bigint,
  p_provider       text,
  p_buyer_id       text,
  p_display_name   text,
  p_user_id        uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type  text := CASE WHEN COALESCE(p_buyer_id, '') = '' THEN 'marketplace_generic' ELSE 'buyer' END;
  v_ext   text := COALESCE(NULLIF(p_buyer_id, ''), 'generic');
  v_label text := CASE p_provider WHEN 'mercadolivre' THEN 'Mercado Livre' ELSE p_provider END;
  v_id    int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('channel_customer:' || p_integration_id || ':' || v_type || ':' || v_ext));

  SELECT l.entity_id::int INTO v_id
  FROM external_entity_links l
  JOIN customers c ON c.id = l.entity_id::int AND c.company_id = p_company_id
  WHERE l.integration_id = p_integration_id AND l.company_id = p_company_id
    AND l.entity_type = 'customer' AND l.external_entity_type = v_type
    AND l.external_id = v_ext AND l.active
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO customers (name, origin, company_id, notes, created_by)
  VALUES (
    left(CASE WHEN v_type = 'buyer'
              THEN 'Comprador ' || v_label || ' ' || COALESCE(NULLIF(p_display_name, ''), v_ext)
              ELSE 'Cliente ' || v_label END, 120),
    'other', p_company_id,
    'Cliente criado automaticamente pela integração ' || v_label || ' (id externo ' || v_ext || ').',
    p_user_id
  )
  RETURNING id INTO v_id;

  INSERT INTO external_entity_links (company_id, integration_id, provider, entity_type, entity_id, external_entity_type, external_id, metadata)
  VALUES (p_company_id, p_integration_id, p_provider, 'customer', v_id::text, v_type, v_ext,
          jsonb_build_object('nickname', NULLIF(p_display_name, '')));
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_provider_label(p_provider text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE p_provider WHEN 'mercadolivre' THEN 'Mercado Livre' WHEN 'nuvemshop' THEN 'Nuvemshop' ELSE p_provider END $$;

/**
 * Importa UM pedido de canal como venda — tudo na MESMA transação:
 * lock do channel_order → NO-OP se já tem venda → valida itens → cliente →
 * rpc_create_sale (itens, pagamento, baixa online com prioridade de locais,
 * kits via core, outbox sale.completed; SEM cashback) → id externo do
 * pagamento → tarifa/frete do vendedor no financeiro → sale_id no pedido.
 *
 * Regra de negócio violada (estoque insuficiente, item inativo…) → o bloco
 * da venda é desfeito (subtransação) e o pedido vai para needs_attention
 * com o motivo: sem venda parcial, sem saldo negativo, sem erro eterno.
 */
CREATE OR REPLACE FUNCTION public.rpc_import_channel_order(
  p_company_id       int,
  p_channel_order_id bigint,
  p_system_user_id   uuid,
  p_payments         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co        record;
  v_total     int;
  v_bad       int;
  v_bad_list  text;
  v_items     jsonb;
  v_customer  int;
  v_sale      jsonb;
  v_sale_id   int;
  v_sum_pay   numeric;
  v_method    text;
  v_core_pmts jsonb;
  v_pmt       jsonb;
  v_idx       bigint;
  v_fee       numeric;
  v_ship      numeric;
  v_date      date;
  v_label     text;
  v_code      text;
BEGIN
  SELECT * INTO v_co FROM channel_orders
  WHERE id = p_channel_order_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido de canal não encontrado.' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotência: já virou venda → nada a fazer (webhook repetido, reprocesso).
  IF v_co.sale_id IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'already_imported', 'sale_id', v_co.sale_id);
  END IF;
  IF v_co.processing_state IN ('cancelled', 'ignored') THEN
    RETURN jsonb_build_object('result', 'not_importable', 'processing_state', v_co.processing_state);
  END IF;

  v_label := public.fn_provider_label(v_co.provider);

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_system_user_id AND company_id = p_company_id) THEN
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = 'no_operator',
      attention_reason = 'Usuário operador da integração não pertence mais à empresa — reconecte a conta.'
    WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'no_operator');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE mapping_status <> 'mapped' OR product_variation_id IS NULL),
         string_agg(CASE WHEN mapping_status <> 'mapped' OR product_variation_id IS NULL
                         THEN COALESCE(seller_sku, external_item_id) END, ', ')
  INTO v_total, v_bad, v_bad_list
  FROM channel_order_items WHERE channel_order_id = v_co.id;

  IF v_total = 0 THEN
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = 'no_items',
      attention_reason = 'Pedido sem itens.' WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'no_items');
  END IF;
  IF v_bad > 0 THEN
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = 'unmapped_items',
      attention_reason = left('Item(ns) sem vínculo com variação do Qarvon: ' || v_bad_list, 1000) WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'unmapped_items');
  END IF;

  -- Pagamento precisa fechar EXATAMENTE com o valor comercial da venda.
  SELECT COALESCE(SUM((value->>'net_amount')::numeric), 0) INTO v_sum_pay
  FROM jsonb_array_elements(COALESCE(p_payments, '[]'::jsonb));
  IF jsonb_array_length(COALESCE(p_payments, '[]'::jsonb)) = 0
     OR ROUND(v_sum_pay, 2) <> ROUND(COALESCE(v_co.gross_amount, -1), 2) THEN
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = 'payment_mismatch',
      attention_reason = format('Pagamentos (%s) não fecham com o valor bruto do pedido (%s).', v_sum_pay, v_co.gross_amount)
    WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'payment_mismatch');
  END IF;

  -- Itens: preço do canal; custo AUTORITATIVO do Qarvon (cost_override → base_cost),
  -- nunca do payload. Kits: o core recalcula o custo pelos componentes.
  SELECT jsonb_agg(jsonb_build_object(
           'product_variation_id', i.product_variation_id,
           'quantity',             i.quantity,
           'unit_price',           i.unit_price,
           'unit_cost',            ROUND(COALESCE(pv.cost_override, p.base_cost, 0), 2),
           'discount_amount',      0
         ) ORDER BY i.line_no)
  INTO v_items
  FROM channel_order_items i
  JOIN product_variations pv ON pv.id = i.product_variation_id
  JOIN products p            ON p.id  = pv.product_id AND p.company_id = p_company_id
  WHERE i.channel_order_id = v_co.id;

  IF jsonb_array_length(COALESCE(v_items, '[]'::jsonb)) <> v_total THEN
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = 'unmapped_items',
      attention_reason = 'Variação vinculada não pertence mais à empresa.' WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'unmapped_items');
  END IF;

  v_customer := public._resolve_channel_customer(
    p_company_id, v_co.integration_id, v_co.provider, v_co.buyer_external_id, v_co.buyer_nickname, p_system_user_id);

  -- Pagamentos no formato do core (método genérico; original em metadata depois).
  SELECT jsonb_agg(jsonb_build_object(
           'method',          value->>'method',
           'amount_tendered', (value->>'net_amount')::numeric,
           'net_amount',      (value->>'net_amount')::numeric,
           'installments',    COALESCE((value->>'installments')::int, 1),
           'card_brand',      NULLIF(value->>'card_brand', ''),
           'acquirer',        v_co.provider,
           'fee_amount',      0
         ) ORDER BY ord)
  INTO v_core_pmts
  FROM jsonb_array_elements(p_payments) WITH ORDINALITY AS t(value, ord);

  SELECT value->>'method' INTO v_method
  FROM jsonb_array_elements(p_payments) AS t(value)
  ORDER BY (value->>'net_amount')::numeric DESC
  LIMIT 1;

  BEGIN
    v_sale := public.rpc_create_sale(
      p_customer_id          => v_customer,
      p_seller_id            => p_system_user_id,
      p_payment_method       => v_method::payment_method,
      p_sale_origin          => NULL,
      p_discount_amount      => 0,
      p_cashback_used        => 0,
      -- Frete do comprador não é receita do vendedor no marketplace
      -- (fica em channel_orders.shipping_cost_buyer, informativo).
      p_shipping_charged     => 0,
      p_notes                => 'Pedido ' || v_label || ' #' || v_co.external_order_id,
      p_items                => v_items,
      p_system_user_id       => p_system_user_id,
      p_payments             => v_core_pmts,
      p_stock_mode           => 'online_priority',
      p_sale_type            => 'retail',
      p_sales_channel        => v_co.provider,
      p_earn_cashback        => false
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_code := CASE WHEN SQLERRM ILIKE '%insuficiente%' THEN 'insufficient_stock' ELSE 'sale_rejected' END;
    UPDATE channel_orders SET processing_state = 'needs_attention', attention_code = v_code,
      attention_reason = left(SQLERRM, 1000), customer_id = v_customer
    WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', v_code, 'reason', left(SQLERRM, 500));
  END;

  v_sale_id := (v_sale->>'id')::int;
  SELECT sale_date INTO v_date FROM sales WHERE id = v_sale_id;

  -- Id externo + método ORIGINAL do canal em cada linha de pagamento
  -- (mesma ordem em que o core inseriu).
  FOR v_pmt, v_idx IN SELECT value, ord FROM jsonb_array_elements(p_payments) WITH ORDINALITY AS t(value, ord) LOOP
    UPDATE sale_payments
    SET external_payment_id = NULLIF(v_pmt->>'external_payment_id', ''),
        metadata            = COALESCE(v_pmt->'metadata', '{}'::jsonb)
    WHERE id = (SELECT id FROM sale_payments WHERE sale_id = v_sale_id ORDER BY id OFFSET v_idx - 1 LIMIT 1);
  END LOOP;

  -- Custos REAIS do canal, separados do faturamento (a venda fica pelo bruto).
  v_fee  := ROUND(COALESCE(v_co.marketplace_fees, 0), 2);
  v_ship := ROUND(COALESCE(v_co.shipping_cost_seller, 0), 2);
  IF v_fee > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('expense', 'marketplace_fee', 'Tarifa ' || v_label || ' — pedido ' || v_co.external_order_id,
            v_fee, v_date, v_sale_id, p_system_user_id, p_company_id);
  END IF;
  IF v_ship > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('expense', 'freight_cost', 'Frete ' || v_label || ' (vendedor) — pedido ' || v_co.external_order_id,
            v_ship, v_date, v_sale_id, p_system_user_id, p_company_id);
  END IF;

  UPDATE channel_orders
  SET sale_id = v_sale_id, customer_id = v_customer, processing_state = 'imported',
      attention_code = NULL, attention_reason = NULL, imported_at = NOW(),
      fees_posted = v_fee, shipping_posted = v_ship
  WHERE id = v_co.id;

  RETURN jsonb_build_object('result', 'imported', 'sale_id', v_sale_id,
                            'sale_number', v_sale->>'sale_number', 'total', (v_sale->>'total')::numeric);
END;
$$;

-- ─── 7. Custos que mudam depois (posta só a diferença) ────────────────────

CREATE OR REPLACE FUNCTION public.rpc_sync_channel_order_costs(
  p_company_id       int,
  p_channel_order_id bigint,
  p_system_user_id   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co    record;
  v_label text;
  v_date  date;
  v_df    numeric;
  v_ds    numeric;
BEGIN
  SELECT * INTO v_co FROM channel_orders
  WHERE id = p_channel_order_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido de canal não encontrado.' USING ERRCODE = 'P0001'; END IF;
  IF v_co.processing_state <> 'imported' OR v_co.sale_id IS NULL THEN
    RETURN jsonb_build_object('result', 'noop');
  END IF;

  v_label := public.fn_provider_label(v_co.provider);
  v_date  := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_df    := ROUND(COALESCE(v_co.marketplace_fees, 0) - v_co.fees_posted, 2);
  v_ds    := ROUND(COALESCE(v_co.shipping_cost_seller, 0) - v_co.shipping_posted, 2);

  IF v_df <> 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES (CASE WHEN v_df > 0 THEN 'expense' ELSE 'income' END::finance_entry_type, 'marketplace_fee',
            'Ajuste tarifa ' || v_label || ' — pedido ' || v_co.external_order_id,
            ABS(v_df), v_date, v_co.sale_id, p_system_user_id, p_company_id);
  END IF;
  IF v_ds <> 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES (CASE WHEN v_ds > 0 THEN 'expense' ELSE 'income' END::finance_entry_type, 'freight_cost',
            'Ajuste frete ' || v_label || ' (vendedor) — pedido ' || v_co.external_order_id,
            ABS(v_ds), v_date, v_co.sale_id, p_system_user_id, p_company_id);
  END IF;

  IF v_df <> 0 OR v_ds <> 0 THEN
    UPDATE channel_orders
    SET fees_posted = fees_posted + v_df, shipping_posted = shipping_posted + v_ds
    WHERE id = v_co.id;
  END IF;
  RETURN jsonb_build_object('result', CASE WHEN v_df <> 0 OR v_ds <> 0 THEN 'adjusted' ELSE 'noop' END,
                            'fee_delta', v_df, 'shipping_delta', v_ds);
END;
$$;

-- ─── 8. Cancelamento idempotente ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_cancel_channel_order(
  p_company_id       int,
  p_channel_order_id bigint,
  p_system_user_id   uuid,
  p_reason           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_co     record;
  v_status text;
  v_label  text;
  v_date   date;
BEGIN
  SELECT * INTO v_co FROM channel_orders
  WHERE id = p_channel_order_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido de canal não encontrado.' USING ERRCODE = 'P0001'; END IF;

  IF v_co.processing_state = 'cancelled' THEN
    RETURN jsonb_build_object('result', 'already_cancelled', 'sale_id', v_co.sale_id);
  END IF;

  IF v_co.sale_id IS NULL THEN
    UPDATE channel_orders SET processing_state = 'cancelled', cancelled_at = NOW(),
      attention_code = NULL, attention_reason = NULL
    WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'cancelled_without_sale');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_system_user_id AND company_id = p_company_id) THEN
    UPDATE channel_orders SET attention_code = 'no_operator',
      attention_reason = 'Cancelado no canal, mas sem usuário operador válido para cancelar a venda.'
    WHERE id = v_co.id;
    RETURN jsonb_build_object('result', 'needs_attention', 'code', 'no_operator');
  END IF;

  v_label := public.fn_provider_label(v_co.provider);
  v_date  := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT status::text INTO v_status FROM sales WHERE id = v_co.sale_id AND company_id = p_company_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'cancelled' THEN
    BEGIN
      -- Core: devolve estoque (kits pelos componentes do snapshot), estorna cashback.
      PERFORM public.rpc_cancel_sale(v_co.sale_id, p_system_user_id);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      UPDATE channel_orders SET attention_code = 'cancel_blocked',
        attention_reason = left('Cancelado no canal, mas a venda não pôde ser cancelada: ' || SQLERRM, 1000)
      WHERE id = v_co.id;
      RETURN jsonb_build_object('result', 'needs_attention', 'code', 'cancel_blocked', 'reason', left(SQLERRM, 500));
    END;
  END IF;

  -- Estorno dos custos lançados (histórico preservado: lançamento inverso).
  IF v_co.fees_posted > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('income', 'marketplace_fee', 'Estorno tarifa ' || v_label || ' — pedido cancelado ' || v_co.external_order_id,
            v_co.fees_posted, v_date, v_co.sale_id, p_system_user_id, p_company_id);
  END IF;
  IF v_co.shipping_posted > 0 THEN
    INSERT INTO finance_entries (type, category, description, amount, reference_date, sale_id, created_by, company_id)
    VALUES ('income', 'freight_cost', 'Estorno frete ' || v_label || ' (vendedor) — pedido cancelado ' || v_co.external_order_id,
            v_co.shipping_posted, v_date, v_co.sale_id, p_system_user_id, p_company_id);
  END IF;

  UPDATE channel_orders
  SET processing_state = 'cancelled', cancelled_at = NOW(), fees_posted = 0, shipping_posted = 0,
      attention_code = NULL, attention_reason = NULL,
      metadata = metadata || jsonb_build_object('cancel_reason', left(COALESCE(p_reason, ''), 300))
  WHERE id = v_co.id;

  RETURN jsonb_build_object('result', 'cancelled', 'sale_id', v_co.sale_id);
END;
$$;

-- ─── 9. DRE: tarifas de marketplace ────────────────────────────────────────
-- Recria a view de 20260725 com: tarifas_marketplace (nova, no fim; entra em
-- total_opex) e frete líquido de estornos. Demais fórmulas idênticas.

DROP VIEW IF EXISTS public.vw_dre_mensal;

CREATE VIEW public.vw_dre_mensal AS
WITH cmv_por_venda AS (
  -- Agrega CMV por venda — evita fan-out no JOIN com sales (inalterado)
  SELECT
    sale_id,
    SUM(COALESCE(unit_cost, 0) * COALESCE(quantity, 0)) AS cmv
  FROM public.sale_items
  GROUP BY sale_id
),
vendas_original AS (
  -- Reconhecimento original: TODA venda, por mês de sale_date, sem filtro
  -- de status. Um mês, uma vez reportado, não é reescrito por um
  -- cancelamento/devolução posterior de uma venda daquele mês.
  SELECT
    DATE_TRUNC('month', s.sale_date)::DATE AS mes,
    s.company_id,
    SUM(s.subtotal)                                                    AS receita_bruta,
    SUM(s.discount_amount + COALESCE(s.cashback_used, 0))              AS descontos,
    SUM(s.subtotal - s.discount_amount - COALESCE(s.cashback_used, 0)) AS receita_liquida,
    SUM(COALESCE(c.cmv, 0))                                            AS cmv
  FROM public.sales s
  LEFT JOIN cmv_por_venda c ON c.sale_id = s.id
  GROUP BY DATE_TRUNC('month', s.sale_date), s.company_id
),
vendas_reversao AS (
  -- Reversão: data determinada pelo status da venda, nunca por COALESCE
  -- entre os dois campos — evita usar a data errada se uma linha
  -- inconsistente tiver os dois timestamps preenchidos.
  SELECT
    DATE_TRUNC(
      'month',
      CASE
        WHEN s.status = 'cancelled' THEN s.cancelled_at
        WHEN s.status = 'returned'  THEN s.returned_at
      END
    )::DATE AS mes,
    s.company_id,
    SUM(s.subtotal)                                                    AS receita_bruta,
    SUM(s.discount_amount + COALESCE(s.cashback_used, 0))              AS descontos,
    SUM(s.subtotal - s.discount_amount - COALESCE(s.cashback_used, 0)) AS receita_liquida,
    SUM(COALESCE(c.cmv, 0))                                            AS cmv
  FROM public.sales s
  LEFT JOIN cmv_por_venda c ON c.sale_id = s.id
  WHERE (s.status = 'cancelled' AND s.cancelled_at IS NOT NULL)
     OR (s.status = 'returned'  AND s.returned_at  IS NOT NULL)
  GROUP BY 1, s.company_id
),
vendas AS (
  -- Líquido: original menos reversão, por mês/empresa. FULL OUTER JOIN
  -- garante que um mês só com reversão (sem venda nova) não desaparece.
  SELECT
    COALESCE(o.mes, r.mes)                 AS mes,
    COALESCE(o.company_id, r.company_id)   AS company_id,
    COALESCE(o.receita_bruta, 0)   - COALESCE(r.receita_bruta, 0)   AS receita_bruta,
    COALESCE(o.descontos, 0)       - COALESCE(r.descontos, 0)       AS descontos,
    COALESCE(o.receita_liquida, 0) - COALESCE(r.receita_liquida, 0) AS receita_liquida,
    COALESCE(o.cmv, 0)             - COALESCE(r.cmv, 0)             AS cmv
  FROM vendas_original o
  FULL OUTER JOIN vendas_reversao r ON r.mes = o.mes AND r.company_id = o.company_id
),
lancamentos AS (
  -- Despesas operacionais e saída de caixa para estoque, por mês/empresa.
  -- outras_despesas exclui as 15 finance_entries automáticas de
  -- cancelamento/devolução sem evidência de reembolso (ver migration
  -- 20260724) — todas as outras categorias permanecem exatamente iguais.
  SELECT
    DATE_TRUNC('month', reference_date)::DATE AS mes,
    company_id,
    SUM(CASE WHEN category = 'other_income'  AND type = 'income'  THEN amount ELSE 0 END) AS outras_receitas,
    SUM(CASE WHEN category = 'marketing'     AND type = 'expense' THEN amount ELSE 0 END) AS marketing,
    SUM(CASE WHEN category = 'rent'          AND type = 'expense' THEN amount ELSE 0 END) AS aluguel,
    SUM(CASE WHEN category = 'salaries'      AND type = 'expense' THEN amount ELSE 0 END) AS salarios,
    SUM(CASE WHEN category = 'operational'   AND type = 'expense' THEN amount ELSE 0 END) AS operacional,
    SUM(CASE WHEN category = 'taxes'         AND type = 'expense' THEN amount ELSE 0 END) AS impostos,
    -- Frete e tarifas de marketplace LÍQUIDOS de estornos (lançamento
    -- inverso 'income' da mesma categoria ao cancelar um pedido de canal).
    SUM(CASE WHEN category = 'freight_cost'  AND type = 'expense' THEN amount
             WHEN category = 'freight_cost'  AND type = 'income'  THEN -amount ELSE 0 END) AS frete,
    SUM(CASE WHEN category = 'marketplace_fee' AND type = 'expense' THEN amount
             WHEN category = 'marketplace_fee' AND type = 'income'  THEN -amount ELSE 0 END) AS tarifas_marketplace,
    SUM(
      CASE
        WHEN category = 'other_expense' AND type = 'expense'
         AND NOT (
           sale_id IS NOT NULL
           AND (description LIKE 'Cancelamento —%' OR description LIKE 'Devolução —%')
         )
        THEN amount ELSE 0
      END
    ) AS outras_despesas,
    SUM(CASE WHEN category = 'stock_purchase' AND type = 'expense' THEN amount ELSE 0 END) AS saida_caixa_estoque
  FROM public.finance_entries
  GROUP BY DATE_TRUNC('month', reference_date), company_id
),
base AS (
  SELECT
    COALESCE(v.mes,        l.mes)        AS mes,
    COALESCE(v.company_id, l.company_id) AS company_id,
    COALESCE(v.receita_bruta,   0)       AS receita_bruta,
    COALESCE(v.descontos,       0)       AS descontos,
    COALESCE(v.receita_liquida, 0)       AS receita_liquida,
    COALESCE(v.cmv,             0)       AS cmv,
    COALESCE(l.outras_receitas, 0)       AS outras_receitas,
    COALESCE(l.marketing,       0)       AS marketing,
    COALESCE(l.aluguel,         0)       AS aluguel,
    COALESCE(l.salarios,        0)       AS salarios,
    COALESCE(l.operacional,     0)       AS operacional,
    COALESCE(l.impostos,        0)       AS impostos,
    COALESCE(l.frete,           0)       AS frete,
    COALESCE(l.tarifas_marketplace, 0)   AS tarifas_marketplace,
    COALESCE(l.outras_despesas, 0)       AS outras_despesas,
    COALESCE(l.saida_caixa_estoque, 0)   AS saida_caixa_estoque
  FROM vendas v
  FULL OUTER JOIN lancamentos l ON l.mes = v.mes AND l.company_id = v.company_id
),
calculado AS (
  SELECT
    mes, company_id, receita_bruta, descontos, receita_liquida, cmv,
    receita_liquida - cmv AS lucro_bruto,
    outras_receitas,
    marketing, aluguel, salarios, operacional, impostos, frete, outras_despesas, tarifas_marketplace,
    marketing + aluguel + salarios + operacional + impostos + frete + outras_despesas + tarifas_marketplace AS total_opex,
    saida_caixa_estoque
  FROM base
)
SELECT
  mes,
  company_id,
  receita_bruta,
  descontos,
  receita_liquida,
  cmv,
  lucro_bruto,
  ROUND(CASE WHEN receita_liquida > 0 THEN lucro_bruto / receita_liquida * 100 ELSE 0 END, 2) AS margem_bruta_pct,
  marketing, aluguel, salarios, operacional, impostos, frete, outras_despesas,
  total_opex,
  lucro_bruto - total_opex AS resultado_operacional,
  ROUND(
    CASE WHEN receita_liquida > 0
      THEN (lucro_bruto - total_opex) / receita_liquida * 100
      ELSE 0
    END, 2
  ) AS margem_operacional_pct,
  outras_receitas,
  lucro_bruto - total_opex + outras_receitas AS lucro_liquido_gerencial,
  ROUND(
    CASE WHEN receita_liquida > 0
      THEN (lucro_bruto - total_opex + outras_receitas) / receita_liquida * 100
      ELSE 0
    END, 2
  ) AS margem_liquida_pct,
  saida_caixa_estoque,
  -- Fase 3 (2026-09-26): despesa VARIÁVEL de marketplace (tarifas reais do
  -- canal), já incluída em total_opex. Coluna nova no fim — consumidores
  -- existentes não mudam.
  tarifas_marketplace
FROM calculado
ORDER BY mes DESC;

COMMENT ON VIEW public.vw_dre_mensal IS
  'DRE gerencial mensal por regime de competência (v3 — revenue reversal). '
  'receita_bruta/descontos/receita_liquida/cmv reconhecidos por sale_date e '
  'revertidos por cancelled_at/returned_at (nunca por finance_entries). '
  'Esta view impede a reescrita retroativa de um mês causada por mudança de '
  'status ou cancelamento/devolução tardios de uma venda antiga — mas sales/'
  'sale_items continuam sendo a fonte dos fatos comerciais, e uma edição '
  'direta nesses dados ainda pode alterar o resultado de um mês já reportado. '
  'outras_despesas exclui as finance_entries automáticas de cancelamento/'
  'devolução sem evidência de reembolso real (other_expense, sale_id '
  'preenchido, descrição padrão) — os registros permanecem intactos na '
  'tabela, só não entram mais no Opex desta view. margem_bruta_pct, '
  'margem_operacional_pct e margem_liquida_pct são as únicas fontes de '
  'percentual da DRE — a página não recalcula nenhum. Atualizado em 20260725; tarifas_marketplace (despesa variável de marketplace, líquida de estornos) e frete líquido de estornos em 20260926.';

GRANT SELECT ON public.vw_dre_mensal TO authenticated, service_role;



-- ─── 10. Estoque → canais ──────────────────────────────────────────────────
-- Corpo IDÊNTICO ao de 202609231000, exceto: acumula as variações cuja
-- disponibilidade mudou, marca channel_listings.stock_sync_pending e as
-- devolve em changed_variation_ids (chave nova, retrocompatível).

ALTER TABLE public.channel_listings ADD COLUMN IF NOT EXISTS stock_sync_pending BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_channel_listings_stock_sync_pending
  ON public.channel_listings (company_id, integration_id)
  WHERE stock_sync_pending;

CREATE OR REPLACE FUNCTION public.rpc_process_stock_availability_changes(
  p_limit     int  DEFAULT 200,
  p_worker_id text DEFAULT 'unknown'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed      int := 0;
  v_variations   int := 0;
  v_changed      int := 0;
  v_became_on    int := 0;
  v_became_off   int := 0;
  v_row          record;
  v_prev         record;
  v_online       int;
  v_main         int;
  v_manual       boolean;
  v_sellable     boolean;
  v_ids          bigint[];
  v_companies    int[];
  v_pvids        int[];
  v_changed_ids  int[] := '{}';
BEGIN
  WITH claimed AS (
    UPDATE stock_availability_changes
    SET status = 'processing', locked_at = NOW(), locked_by = p_worker_id, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM stock_availability_changes
      WHERE status = 'pending'
         OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
      ORDER BY created_at, id
      LIMIT GREATEST(p_limit, 1)
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, company_id, product_variation_id
  )
  SELECT COALESCE(array_agg(id), '{}'), COALESCE(array_agg(company_id), '{}'), COALESCE(array_agg(product_variation_id), '{}')
  INTO v_ids, v_companies, v_pvids
  FROM claimed;

  v_claimed := COALESCE(array_length(v_ids, 1), 0);

  FOR v_row IN
    SELECT DISTINCT u.company_id, u.product_variation_id
    FROM unnest(v_companies, v_pvids) AS u(company_id, product_variation_id)
    ORDER BY u.product_variation_id
  LOOP
    SELECT p.product_kind, (pv.active AND p.active) AS manual, p.company_id AS real_company
    INTO v_prev
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_row.product_variation_id;

    -- Variação apagada, ou evento com empresa divergente → só descarta.
    IF NOT FOUND OR v_prev.real_company IS DISTINCT FROM v_row.company_id THEN
      CONTINUE;
    END IF;

    v_variations := v_variations + 1;
    v_manual   := v_prev.manual;
    v_online   := public.fn_variation_sellable_quantity(v_row.company_id, v_row.product_variation_id, 'online_priority');
    v_main     := public.fn_variation_sellable_quantity(v_row.company_id, v_row.product_variation_id, 'main_store');
    v_sellable := v_manual AND v_online > 0;

    SELECT is_sellable, online_quantity, main_store_quantity, manual_enabled
    INTO v_prev
    FROM variation_availability
    WHERE product_variation_id = v_row.product_variation_id;

    IF NOT FOUND THEN
      INSERT INTO variation_availability (
        product_variation_id, company_id, product_kind, manual_enabled,
        online_quantity, main_store_quantity, inventory_available, is_sellable
      )
      SELECT v_row.product_variation_id, v_row.company_id, p.product_kind, v_manual,
             v_online, v_main, v_online > 0, v_sellable
      FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_row.product_variation_id;
      v_changed := v_changed + 1;
      v_changed_ids := v_changed_ids || v_row.product_variation_id;
      IF v_sellable THEN v_became_on := v_became_on + 1; END IF;
    ELSIF v_prev.online_quantity IS DISTINCT FROM v_online
       OR v_prev.main_store_quantity IS DISTINCT FROM v_main
       OR v_prev.manual_enabled IS DISTINCT FROM v_manual THEN
      UPDATE variation_availability
      SET manual_enabled      = v_manual,
          online_quantity     = v_online,
          main_store_quantity = v_main,
          inventory_available = v_online > 0,
          is_sellable         = v_sellable,
          computed_at         = NOW(),
          changed_at          = NOW(),
          sellable_changed_at = CASE WHEN v_prev.is_sellable IS DISTINCT FROM v_sellable THEN NOW() ELSE sellable_changed_at END
      WHERE product_variation_id = v_row.product_variation_id;
      v_changed := v_changed + 1;
      v_changed_ids := v_changed_ids || v_row.product_variation_id;
      IF v_prev.is_sellable AND NOT v_sellable THEN v_became_off := v_became_off + 1; END IF;
      IF NOT v_prev.is_sellable AND v_sellable THEN v_became_on := v_became_on + 1; END IF;
    ELSE
      UPDATE variation_availability SET computed_at = NOW()
      WHERE product_variation_id = v_row.product_variation_id;
    END IF;
  END LOOP;

  -- Marketplace Hub (Fase 3): anúncios das variações cuja disponibilidade
  -- mudou precisam reenviar a quantidade — marcado AQUI, na mesma transação
  -- (durável: um push que falhar continua pendente). Kits dependentes já
  -- entraram na fila por fn_enqueue_availability_change.
  IF array_length(v_changed_ids, 1) > 0 THEN
    UPDATE channel_listings
    SET stock_sync_pending = true
    WHERE product_variation_id = ANY(v_changed_ids)
      AND external_listing_id IS NOT NULL
      AND local_status IN ('active', 'paused');
  END IF;

  UPDATE stock_availability_changes
  SET status = 'processed', processed_at = NOW(), locked_at = NULL, locked_by = NULL
  WHERE id = ANY(v_ids);

  -- Retenção: a fila não é histórico (o histórico é stock_movements). Apaga
  -- processados com mais de 7 dias, em lote limitado por execução.
  DELETE FROM stock_availability_changes
  WHERE id IN (
    SELECT id FROM stock_availability_changes
    WHERE status = 'processed' AND processed_at < NOW() - INTERVAL '7 days'
    ORDER BY id
    LIMIT 5000
  );

  RETURN jsonb_build_object(
    'claimed',          v_claimed,
    'variations',       v_variations,
    'changed',          v_changed,
    'became_sellable',  v_became_on,
    'became_unavailable', v_became_off,
    'changed_variation_ids', to_jsonb(v_changed_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_process_stock_availability_changes(int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_process_stock_availability_changes(int, text) TO service_role;

-- ─── 11. RLS / grants: deny-by-default, só service_role ───────────────────

ALTER TABLE public.inbound_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_order_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_events, public.channel_orders, public.channel_order_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inbound_events, public.channel_orders, public.channel_order_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.inbound_events_id_seq, public.channel_orders_id_seq, public.channel_order_items_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.rpc_enqueue_inbound_event(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_claim_inbound_events(text, int, text, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_finish_inbound_event(bigint, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_upsert_channel_order(int, bigint, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_set_channel_order_state(int, bigint, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._resolve_channel_customer(int, bigint, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_import_channel_order(int, bigint, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_sync_channel_order_costs(int, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_cancel_channel_order(int, bigint, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_enqueue_inbound_event(text, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_claim_inbound_events(text, int, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_finish_inbound_event(bigint, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_channel_order(int, bigint, text, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_channel_order_state(int, bigint, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_import_channel_order(int, bigint, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_sync_channel_order_costs(int, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_channel_order(int, bigint, uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
