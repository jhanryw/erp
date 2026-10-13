-- Pedido de atacado SEM nome/telefone digitados: contato opcional (NULL) em vez de dados fictícios.
--
-- Contexto: o carrinho não pede mais nome/WhatsApp (o cliente é identificado pela conversa no WhatsApp).
-- Antes desta migration o app gravava 'Cliente do site' + telefone reservado '+5500…' para satisfazer NOT NULL.
-- Aqui o contato passa a ser genuinamente opcional.
--
-- Compatível com pedidos antigos e com o código anterior:
--   * linhas existentes continuam válidas (nenhuma é alterada, exceto o backfill dos marcadores fictícios, abaixo);
--   * os CHECKs de formato já aceitam NULL (CHECK com NULL é satisfeito) — só o NOT NULL cai;
--   * a RPC mantém EXATAMENTE a mesma assinatura (nenhum overload novo → sem ambiguidade para o PostgREST).
--
-- Anti-spam inalterado: limite por IP (hash) e teto por empresa continuam; o limite por telefone só se aplica
-- quando há telefone (NULL nunca "agrupa" visitantes anônimos). Reaplicável.

ALTER TABLE public.wholesale_orders ALTER COLUMN customer_name  DROP NOT NULL;
ALTER TABLE public.wholesale_orders ALTER COLUMN customer_phone DROP NOT NULL;

-- Nome e telefone andam juntos: ou o pedido tem contato completo, ou não tem nenhum.
ALTER TABLE public.wholesale_orders DROP CONSTRAINT IF EXISTS chk_wholesale_orders_contact_pair;
ALTER TABLE public.wholesale_orders ADD CONSTRAINT chk_wholesale_orders_contact_pair
  CHECK ((customer_name IS NULL) = (customer_phone IS NULL));

-- Backfill: pedidos gravados com a identidade fictícia da estratégia anterior viram "sem contato".
-- Só casa com o marcador exato (nome fixo + prefixo reservado +5500, DDD inexistente).
UPDATE public.wholesale_orders
   SET customer_name = NULL, customer_phone = NULL
 WHERE customer_name = 'Cliente do site' AND customer_phone ~ '^\+5500[0-9]{8}$';

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

  -- Contato completo ou nenhum (nunca só um dos dois).
  IF (p_customer_name IS NULL) <> (p_customer_phone IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_contact');
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

  -- (2) Limites anti-spam (compartilhados entre instâncias — vivem no banco).
  IF p_request_ip_hash IS NOT NULL AND (
       SELECT count(*) FROM public.wholesale_orders
       WHERE company_id = p_company_id AND request_ip_hash = p_request_ip_hash
         AND created_at > NOW() - INTERVAL '1 hour') >= p_max_per_ip_hour THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  -- Por telefone: só quando há telefone. (Pedido anônimo é limitado por IP e pelo teto da empresa.)
  IF p_customer_phone IS NOT NULL AND (
       SELECT count(*) FROM public.wholesale_orders
       WHERE company_id = p_company_id AND customer_phone = p_customer_phone
         AND created_at > NOW() - INTERVAL '1 hour') >= p_max_per_phone_hour THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  -- Teto GLOBAL por empresa: não depende de confiar no IP (X-Forwarded-For) nem no telefone.
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

-- =============================================================================
-- ROLLBACK (só é possível se NÃO houver pedidos com contato NULL — o rollback do NOT NULL falharia)
-- =============================================================================
/*
-- 1) Restaurar a identidade fictícia nos pedidos sem contato:
UPDATE public.wholesale_orders
   SET customer_name = 'Cliente do site',
       customer_phone = '+5500' || LPAD((abs(hashtext(id::text)) % 100000000)::TEXT, 8, '0')
 WHERE customer_name IS NULL;
-- 2) Reativar NOT NULL e remover o CHECK de par:
ALTER TABLE public.wholesale_orders DROP CONSTRAINT IF EXISTS chk_wholesale_orders_contact_pair;
ALTER TABLE public.wholesale_orders ALTER COLUMN customer_name  SET NOT NULL;
ALTER TABLE public.wholesale_orders ALTER COLUMN customer_phone SET NOT NULL;
-- 3) Reaplicar a função de 20260921_wholesale_orders.sql.
*/
