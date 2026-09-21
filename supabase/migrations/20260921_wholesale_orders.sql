-- =============================================================================
-- 20260921_wholesale_orders.sql
--
-- Pedido (intenção de compra) do catálogo de atacado. O cliente fecha no
-- WhatsApp; aqui fica o REGISTRO confiável do que foi enviado, com código
-- legível (AT-000184) para a equipe.
--
-- NÃO é venda: não cria linha em `sales`, não baixa nem reserva estoque. A
-- venda real é registrada depois pela equipe (sale_id, nullable, já prepara
-- essa ligação futura).
--
-- Snapshot: nome, SKU, atributos, quantidade e preço de cada item são
-- COPIADOS no momento da criação (histórico transacional — não é um segundo
-- PIM). Alterar produto/SKU/preço depois não muda um pedido já criado. Por
-- isso os itens guardam variation_id/product_id sem depender de FK rígida
-- (ON DELETE SET NULL): excluir um produto não apaga o histórico.
--
-- Não depende de 20260920_products_wholesale_enabled.sql (não lê essa coluna;
-- a vendabilidade é validada pela aplicação antes de chamar a RPC).
--
-- Tabela antiga `wholesale_checkout_idempotency` (checkout com venda,
-- removido) NÃO é reaproveitada: idempotência agora é UNIQUE(company_id,
-- idempotency_key) no próprio pedido. A tabela antiga fica intocada.
-- =============================================================================

-- ─── Contador de código por empresa ─────────────────────────────────────────
-- Uma linha por empresa; a RPC incrementa com UPDATE atômico (o lock da linha
-- serializa criações concorrentes). Nunca SELECT max()+1.
CREATE TABLE IF NOT EXISTS public.wholesale_order_counters (
  company_id   INT     PRIMARY KEY REFERENCES public.companies(id),
  last_number  BIGINT  NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

-- ─── Pedido ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wholesale_orders (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            INT           NOT NULL REFERENCES public.companies(id),
  order_number          BIGINT        NOT NULL,
  code                  TEXT          NOT NULL,
  -- pending = aguardando contato/fechamento; finalized = fechado; cancelled.
  status                TEXT          NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'finalized', 'cancelled')),
  customer_name         TEXT          NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 2 AND 120),
  -- E.164 normalizado pela aplicação (ex.: +5584999999999). Telefone do
  -- COMPRADOR — distinto do WhatsApp da empresa (wholesale_site_settings).
  customer_phone        TEXT          NOT NULL CHECK (customer_phone ~ '^\+55[0-9]{10,11}$'),
  total_items           INT           NOT NULL CHECK (total_items > 0),
  subtotal              NUMERIC(10,2) NOT NULL CHECK (subtotal > 0),
  -- Pedido mínimo vigente NO MOMENTO da criação (a config pode mudar depois).
  minimum_order_amount  NUMERIC(10,2) NOT NULL CHECK (minimum_order_amount >= 0),
  idempotency_key       UUID          NOT NULL,
  -- HMAC do IP de origem (nunca o IP cru) — só para limitar spam.
  request_ip_hash       TEXT,
  -- Ligação FUTURA com a venda real (conversão manual). Nunca preenchida aqui.
  sale_id               INT           REFERENCES public.sales(id),
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_wholesale_orders_company_code UNIQUE (company_id, code),
  CONSTRAINT uq_wholesale_orders_company_number UNIQUE (company_id, order_number),
  CONSTRAINT uq_wholesale_orders_company_idempotency UNIQUE (company_id, idempotency_key),
  CONSTRAINT chk_wholesale_orders_subtotal_covers_minimum CHECK (subtotal >= minimum_order_amount)
);

CREATE INDEX IF NOT EXISTS idx_wholesale_orders_company_created  ON public.wholesale_orders (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_company_status   ON public.wholesale_orders (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_company_phone    ON public.wholesale_orders (company_id, customer_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wholesale_orders_company_ip       ON public.wholesale_orders (company_id, request_ip_hash, created_at DESC) WHERE request_ip_hash IS NOT NULL;

-- ─── Itens (snapshot) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wholesale_order_items (
  id             BIGSERIAL     PRIMARY KEY,
  order_id       UUID          NOT NULL REFERENCES public.wholesale_orders(id) ON DELETE CASCADE,
  company_id     INT           NOT NULL REFERENCES public.companies(id),
  position       INT           NOT NULL CHECK (position > 0),
  -- Referências informativas (podem virar NULL se o produto for excluído).
  variation_id   INT           REFERENCES public.product_variations(id) ON DELETE SET NULL,
  product_id     INT           REFERENCES public.products(id) ON DELETE SET NULL,
  -- Snapshot no momento do pedido:
  product_name   TEXT          NOT NULL,
  sku            TEXT          NOT NULL,
  attributes     JSONB         NOT NULL DEFAULT '[]'::jsonb,   -- [{type, value}]
  quantity       INT           NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(10,2) NOT NULL CHECK (unit_price > 0),
  subtotal       NUMERIC(10,2) NOT NULL,

  CONSTRAINT uq_wholesale_order_items_position UNIQUE (order_id, position),
  CONSTRAINT chk_wholesale_order_items_subtotal CHECK (subtotal = quantity * unit_price)
);

CREATE INDEX IF NOT EXISTS idx_wholesale_order_items_company_sku ON public.wholesale_order_items (company_id, sku);
CREATE INDEX IF NOT EXISTS idx_wholesale_order_items_variation   ON public.wholesale_order_items (variation_id) WHERE variation_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_wholesale_orders_touch_updated_at ON public.wholesale_orders;
CREATE TRIGGER trg_wholesale_orders_touch_updated_at
  BEFORE UPDATE ON public.wholesale_orders
  FOR EACH ROW EXECUTE FUNCTION public.company_integrations_touch_updated_at();

-- ─── RLS: deny-by-default. Só service_role (rotas do servidor). ─────────────
ALTER TABLE public.wholesale_order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesale_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wholesale_order_items    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wholesale_order_counters, public.wholesale_orders, public.wholesale_order_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wholesale_order_counters, public.wholesale_orders, public.wholesale_order_items TO service_role;
-- Supabase concede ALL em objetos novos de `public` a anon/authenticated via default
-- privileges — revogar também da SEQUENCE (senão anon poderia chamar nextval).
REVOKE ALL ON SEQUENCE public.wholesale_order_items_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.wholesale_order_items_id_seq TO service_role;

-- ─── RPC atômica de criação ─────────────────────────────────────────────────
-- Uma transação: (1) idempotência, (2) limite de spam, (3) código, (4) pedido,
-- (5) itens. Qualquer falha desfaz TUDO (inclusive o incremento do contador).
--
-- Os itens chegam já validados/precificados pela aplicação (preço/estoque/
-- vendabilidade vêm do banco lá); aqui os TOTAIS são recalculados a partir dos
-- itens (nunca aceitos de fora) e o pedido mínimo é conferido de novo.
--
-- p_items: [{variation_id, product_id, product_name, sku, attributes, quantity, unit_price}]
-- Retorno: {ok:true, order_id, code, replay} | {ok:false, error:'rate_limited'|'below_minimum'|'invalid_items'}
CREATE OR REPLACE FUNCTION public.rpc_create_wholesale_order(
  p_company_id           INT,
  p_idempotency_key      UUID,
  p_customer_name        TEXT,
  p_customer_phone       TEXT,
  p_minimum_order_amount NUMERIC,
  p_request_ip_hash      TEXT,
  p_items                JSONB,
  p_max_per_ip_hour      INT DEFAULT 30,
  p_max_per_phone_hour   INT DEFAULT 10,
  p_max_per_company_hour INT DEFAULT 200
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing   RECORD;
  v_number     BIGINT;
  v_code       TEXT;
  v_order_id   UUID;
  v_total_items INT;
  v_subtotal   NUMERIC(10,2);
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_items');
  END IF;

  -- Serializa requisições com a MESMA chave (duplo clique/retry concorrente).
  PERFORM pg_advisory_xact_lock(hashtextextended('wholesale_order:' || p_company_id || ':' || p_idempotency_key::text, 0));

  -- (1) Idempotência: mesma empresa + mesma chave → devolve o pedido já criado.
  SELECT id, code INTO v_existing
  FROM public.wholesale_orders
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'order_id', v_existing.id, 'code', v_existing.code, 'replay', true);
  END IF;

  -- (2) Limite anti-spam (compartilhado entre instâncias — vive no banco).
  IF p_request_ip_hash IS NOT NULL AND (
       SELECT count(*) FROM public.wholesale_orders
       WHERE company_id = p_company_id AND request_ip_hash = p_request_ip_hash
         AND created_at > NOW() - INTERVAL '1 hour') >= p_max_per_ip_hour THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  IF (SELECT count(*) FROM public.wholesale_orders
      WHERE company_id = p_company_id AND customer_phone = p_customer_phone
        AND created_at > NOW() - INTERVAL '1 hour') >= p_max_per_phone_hour THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  -- Teto GLOBAL por empresa: rede de proteção que NÃO depende de confiar no IP
  -- (X-Forwarded-For) nem no telefone informado — limita inundação mesmo com IP/telefone rotativos.
  IF (SELECT count(*) FROM public.wholesale_orders
      WHERE company_id = p_company_id
        AND created_at > NOW() - INTERVAL '1 hour') >= p_max_per_company_hour THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  -- Totais recalculados dos itens (nunca aceitos de fora).
  SELECT COALESCE(SUM(i.quantity), 0), COALESCE(SUM(i.quantity * i.unit_price), 0)
    INTO v_total_items, v_subtotal
  FROM jsonb_to_recordset(p_items) AS i(quantity INT, unit_price NUMERIC);

  IF v_total_items <= 0 OR v_subtotal <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_items');
  END IF;
  IF v_subtotal < p_minimum_order_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'below_minimum');
  END IF;

  -- (3) Código: incremento atômico por empresa (o lock da linha serializa).
  INSERT INTO public.wholesale_order_counters (company_id, last_number)
  VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE SET last_number = public.wholesale_order_counters.last_number + 1
  RETURNING last_number INTO v_number;
  v_code := 'AT-' || LPAD(v_number::TEXT, 6, '0');

  -- (4) Pedido
  INSERT INTO public.wholesale_orders (
    company_id, order_number, code, customer_name, customer_phone,
    total_items, subtotal, minimum_order_amount, idempotency_key, request_ip_hash
  ) VALUES (
    p_company_id, v_number, v_code, btrim(p_customer_name), p_customer_phone,
    v_total_items, v_subtotal, p_minimum_order_amount, p_idempotency_key, p_request_ip_hash
  ) RETURNING id INTO v_order_id;

  -- (5) Itens (snapshot). Falha aqui desfaz pedido e contador.
  INSERT INTO public.wholesale_order_items (
    order_id, company_id, position, variation_id, product_id,
    product_name, sku, attributes, quantity, unit_price, subtotal
  )
  SELECT v_order_id, p_company_id, e.ord, t.variation_id, t.product_id,
         t.product_name, t.sku, COALESCE(t.attributes, '[]'::jsonb), t.quantity, t.unit_price,
         t.quantity * t.unit_price
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(elem, ord),
       LATERAL jsonb_to_record(e.elem) AS t(
         variation_id INT, product_id INT, product_name TEXT, sku TEXT,
         attributes JSONB, quantity INT, unit_price NUMERIC
       );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order_id, 'code', v_code, 'replay', false);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_wholesale_order(INT, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, INT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_wholesale_order(INT, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, INT, INT, INT) TO service_role;

COMMENT ON TABLE public.wholesale_orders IS 'Intenção de compra do catálogo de atacado (fechamento no WhatsApp). NÃO é venda: não baixa estoque. sale_id liga à venda real, preenchido manualmente no futuro.';
COMMENT ON TABLE public.wholesale_order_items IS 'Snapshot dos itens no momento do pedido (nome/SKU/atributos/preço) — histórico transacional, não cadastro.';

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
DROP FUNCTION IF EXISTS public.rpc_create_wholesale_order(INT, UUID, TEXT, TEXT, NUMERIC, TEXT, JSONB, INT, INT, INT);
DROP TABLE IF EXISTS public.wholesale_order_items;
DROP TABLE IF EXISTS public.wholesale_orders;
DROP TABLE IF EXISTS public.wholesale_order_counters;
*/
