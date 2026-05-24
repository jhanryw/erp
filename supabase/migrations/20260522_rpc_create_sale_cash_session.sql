-- =============================================================================
-- Migration 20260522 — Módulo de Caixa (Parte 3/3): Atualização rpc_create_sale
--
-- DEPENDE DE:
--   20260522_cash_register.sql (tabela cash_register_sessions já existe)
--   20260522_rpc_create_sale_payments.sql (função 13-param já existe)
--
-- O QUE MUDA:
--   Adiciona parâmetro p_cash_session_id bigint DEFAULT NULL à função principal
--   Valida a sessão antes do INSERT em sales
--   Grava cash_session_id em sales quando fornecido
--
-- O QUE NÃO MUDA:
--   Assinatura do wrapper de compatibilidade (p_accumulate_cashback)
--   Toda a lógica de estoque, cashback, sale_payments, finance_entries
--   Webhook Nuvemshop → wrapper chama a nova função → p_cash_session_id = NULL implícito
--
-- ESTRATÉGIA:
--   PostgreSQL não permite CREATE OR REPLACE quando o número de parâmetros muda.
--   Portanto: DROP da versão 13-param + CREATE OR REPLACE da versão 14-param.
--   CREATE OR REPLACE torna a migration idempotente: funciona na primeira execução
--   e em re-execuções (sem erro 42723 por função duplicada).
--   O wrapper (12-param com p_accumulate_cashback) não muda — chama a nova função
--   sem passar p_cash_session_id → assume DEFAULT NULL automaticamente.
--
-- ROLLBACK:
--   Recriar a versão 13-param a partir de 20260522_rpc_create_sale_payments.sql
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Drop da versão 13-parâmetros
-- =============================================================================

DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric,
  text, jsonb, uuid, numeric, numeric, jsonb
);

-- =============================================================================
-- PARTE 2 — Nova função principal: rpc_create_sale (14 parâmetros)
--
-- Único diff em relação à versão 13-param:
--   + p_cash_session_id bigint DEFAULT NULL       (novo parâmetro, final)
--   + DECLARE v_session_status text; v_session_company int;
--   + Bloco de validação da sessão antes do pré-lock de estoque
--   + cash_session_id = p_cash_session_id no INSERT em sales
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    payment_method,
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric  DEFAULT 0,
  p_surcharge_amount  numeric  DEFAULT 0,
  p_payments          jsonb    DEFAULT NULL,
  p_cash_session_id   bigint   DEFAULT NULL   -- novo: ID da sessão de caixa física
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Variáveis originais (inalteradas)
  v_sale_id         int;
  v_sale_number     text;
  v_subtotal        numeric := 0;
  v_gross           numeric;
  v_total           numeric;
  v_eff_cashback    numeric;
  v_item            jsonb;
  v_pvid            int;
  v_qty             int;
  v_unit_price      numeric;
  v_unit_cost       numeric;
  v_discount        numeric;
  v_current_qty     int;
  v_item_total      numeric;
  v_company_id      int;
  v_item_company    int;
  v_card_fee        numeric;
  v_surcharge       numeric;
  v_brazil_date     date;

  -- Variáveis de multi-pagamento (inalteradas)
  v_pmt             jsonb;
  v_pmt_method      payment_method;
  v_pmt_tendered    numeric;
  v_pmt_change      numeric;
  v_pmt_change_mth  text;
  v_pmt_net         numeric;
  v_pmt_install     int;
  v_pmt_brand       text;
  v_pmt_acquirer    text;
  v_pmt_metadata    jsonb;
  v_payments_total  numeric := 0;
  v_dominant_method payment_method;
  v_max_net         numeric := -1;
  v_fee_pct         numeric;
  v_fee_amt         numeric;

  -- Novas variáveis para validação da sessão de caixa
  v_session_status  text;
  v_session_company int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;
  v_card_fee    := GREATEST(0, COALESCE(p_card_fee, 0));
  v_surcharge   := GREATEST(0, COALESCE(p_surcharge_amount, 0));

  -- Empresa do vendedor
  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor nao esta associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Validação de empresa + cálculo de subtotal (inalterado) ───────────────
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid := (v_item->>'product_variation_id')::int;
    SELECT p.company_id INTO v_item_company
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;
    IF v_item_company IS NULL THEN
      RAISE EXCEPTION 'Variacao #% nao encontrada.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    IF v_item_company != v_company_id THEN
      RAISE EXCEPTION 'Variacao #% nao pertence a empresa do vendedor.', v_pvid USING ERRCODE = 'P0001';
    END IF;
    v_subtotal := v_subtotal
      + (v_item->>'unit_price')::numeric * (v_item->>'quantity')::int
      - COALESCE((v_item->>'discount_amount')::numeric, 0);
  END LOOP;

  v_gross        := GREATEST(0, ROUND(v_subtotal - p_discount_amount + p_shipping_charged + v_surcharge, 2));
  v_total        := GREATEST(0, v_gross - p_cashback_used);
  v_eff_cashback := v_gross - v_total;

  -- ─── Validação e pré-processamento de p_payments (inalterado) ──────────────
  IF p_payments IS NOT NULL THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method   := (v_pmt->>'method')::payment_method;
      v_pmt_net      := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_tendered := COALESCE((v_pmt->>'amount_tendered')::numeric, v_pmt_net);
      v_pmt_change   := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_install  := COALESCE((v_pmt->>'installments')::int, 1);

      IF v_pmt_method NOT IN ('pix', 'cash', 'credit_card', 'debit_card') THEN
        RAISE EXCEPTION 'Metodo de pagamento invalido: %. Use pix, cash, credit_card ou debit_card.',
          v_pmt->>'method' USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_net <= 0 THEN
        RAISE EXCEPTION 'net_amount deve ser positivo. Recebido: %.', v_pmt_net USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_tendered < v_pmt_net THEN
        RAISE EXCEPTION 'amount_tendered (%) deve ser maior ou igual a net_amount (%).',
          v_pmt_tendered, v_pmt_net USING ERRCODE = 'P0001';
      END IF;
      IF ABS(v_pmt_net - (v_pmt_tendered - v_pmt_change)) > 0.01 THEN
        RAISE EXCEPTION 'net_amount (%) incoerente: amount_tendered (%) - change_amount (%) = %.',
          v_pmt_net, v_pmt_tendered, v_pmt_change, v_pmt_tendered - v_pmt_change
          USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_change > 0 AND v_pmt_method != 'cash' THEN
        RAISE EXCEPTION 'Troco so e permitido em pagamentos em dinheiro (metodo: %).',
          v_pmt_method USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_change > 0 AND (v_pmt->>'change_method') IS NULL THEN
        RAISE EXCEPTION 'change_method e obrigatorio quando ha troco.' USING ERRCODE = 'P0001';
      END IF;
      IF v_pmt_install > 1 AND v_pmt_method != 'credit_card' THEN
        RAISE EXCEPTION 'Parcelamento (%) so e permitido em cartao de credito (metodo: %).',
          v_pmt_install, v_pmt_method USING ERRCODE = 'P0001';
      END IF;

      v_payments_total := v_payments_total + v_pmt_net;
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := v_pmt_method;
      END IF;
    END LOOP;

    IF ABS(v_payments_total - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Soma dos pagamentos (%) difere do total da venda (%). Diferenca: %.',
        ROUND(v_payments_total, 2), ROUND(v_total, 2),
        ROUND(ABS(v_payments_total - v_total), 2)
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ─── Novo: validação da sessão de caixa ───────────────────────────────────
  -- Executada antes do pré-lock de estoque para abortar sem efeito colateral.
  -- NULL = venda sem caixa (delivery, Nuvemshop, vendas antigas) → passa direto.
  IF p_cash_session_id IS NOT NULL THEN
    SELECT status, company_id
    INTO   v_session_status, v_session_company
    FROM   cash_register_sessions
    WHERE  id = p_cash_session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sessao de caixa #% nao encontrada.', p_cash_session_id
        USING ERRCODE = 'P0001';
    END IF;
    IF v_session_status = 'closed' THEN
      RAISE EXCEPTION 'Caixa fechado. Abra um novo caixa para registrar vendas.'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_session_company != v_company_id THEN
      RAISE EXCEPTION 'Acesso negado a sessao de caixa.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- ─── Pré-lock ordenado por pvid (anti-deadlock, inalterado) ───────────────
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  -- ─── INSERT em sales (com cash_session_id) ─────────────────────────────────
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id,
    cash_session_id   -- novo: vincula ao caixa físico (NULL para delivery/online)
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id,
    p_cash_session_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Itens + estoque (inalterado) ──────────────────────────────────────────
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_pvid       := (v_item->>'product_variation_id')::int;
    v_qty        := (v_item->>'quantity')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_unit_cost  := (v_item->>'unit_cost')::numeric;
    v_discount   := COALESCE((v_item->>'discount_amount')::numeric, 0);
    v_item_total := ROUND(v_unit_price * v_qty - v_discount, 2);

    INSERT INTO sale_items (
      sale_id, product_variation_id, quantity,
      unit_price, unit_cost, discount_amount, total_price
    )
    VALUES (v_sale_id, v_pvid, v_qty, v_unit_price, v_unit_cost, v_discount, v_item_total);

    SELECT quantity INTO v_current_qty FROM stock WHERE product_variation_id = v_pvid;
    IF v_current_qty IS NULL OR v_current_qty < v_qty THEN
      RAISE EXCEPTION 'Estoque insuficiente para variacao #%. Disponivel: %, solicitado: %.',
        v_pvid, COALESCE(v_current_qty, 0), v_qty USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock SET quantity = quantity - v_qty, last_updated = NOW()
    WHERE product_variation_id = v_pvid;

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id, company_id
    )
    SELECT v_pvid, pv.product_id, 'sale', -v_qty,
           v_current_qty, v_current_qty - v_qty,
           v_unit_cost, v_sale_id::text, v_company_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- ─── Finance entries (inalterado) ──────────────────────────────────────────
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, sale_id, created_by, company_id
  )
  VALUES (
    'income', 'sale', 'Venda ' || v_sale_number,
    v_gross, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
  );

  IF v_eff_cashback > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'cashback_used', 'Cashback — Venda ' || v_sale_number,
      v_eff_cashback, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- ─── sale_payments (inalterado) ────────────────────────────────────────────
  IF p_payments IS NOT NULL THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method     := (v_pmt->>'method')::payment_method;
      v_pmt_tendered   := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change     := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net        := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install    := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand      := v_pmt->>'card_brand';
      v_pmt_acquirer   := v_pmt->>'acquirer';
      v_pmt_metadata   := COALESCE((v_pmt->'metadata'), '{}');
      v_fee_pct        := 0;
      v_fee_amt        := 0;

      IF v_pmt_method IN ('credit_card', 'debit_card') THEN
        SELECT fee_percentage INTO v_fee_pct
        FROM payment_fee_settings
        WHERE company_id     = v_company_id
          AND payment_method = 'card'
          AND installments   = v_pmt_install;

        IF NOT FOUND THEN
          RAISE WARNING 'Taxa nao encontrada: company_id=%, metodo=%, parcelas=%. Usando 0.',
            v_company_id, v_pmt_method, v_pmt_install;
          v_fee_pct := 0;
        END IF;

        v_fee_pct := COALESCE(v_fee_pct, 0);
        v_fee_amt := ROUND(v_pmt_net * v_fee_pct / 100.0, 2);

        IF v_fee_amt > 0 THEN
          INSERT INTO finance_entries (
            type, category, description, amount,
            reference_date, sale_id, created_by, company_id
          )
          VALUES (
            'expense', 'operational',
            'Taxa ' || v_pmt_method || ' ' || v_pmt_install || 'x — Venda ' || v_sale_number,
            v_fee_amt, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
          );
        END IF;
      END IF;

      INSERT INTO sale_payments (
        sale_id, company_id, method,
        amount_tendered, change_amount, change_method, net_amount,
        installments, card_brand, acquirer,
        fee_percentage, fee_amount, metadata, created_by
      )
      VALUES (
        v_sale_id, v_company_id, v_pmt_method,
        v_pmt_tendered, v_pmt_change, v_pmt_change_mth, v_pmt_net,
        v_pmt_install, v_pmt_brand, v_pmt_acquirer,
        v_fee_pct, v_fee_amt, v_pmt_metadata, p_system_user_id
      );
    END LOOP;

  ELSE
    -- Path legado
    IF v_card_fee > 0 THEN
      INSERT INTO finance_entries (
        type, category, description, amount, reference_date, sale_id, created_by, company_id
      )
      VALUES (
        'expense', 'operational', 'Taxa de cartao — Venda ' || v_sale_number,
        v_card_fee, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
      );
    END IF;

    INSERT INTO sale_payments (
      sale_id, company_id, method,
      amount_tendered, change_amount, net_amount,
      installments, fee_percentage, fee_amount,
      metadata, created_by
    )
    VALUES (
      v_sale_id, v_company_id, p_payment_method,
      ROUND(v_total, 2), 0, ROUND(v_total, 2),
      1,
      ROUND(v_card_fee / NULLIF(ROUND(v_total, 2), 0) * 100.0, 4),
      v_card_fee,
      '{}', p_system_user_id
    );
  END IF;

  RETURN jsonb_build_object('id', v_sale_id, 'sale_number', v_sale_number);
END;
$$;

-- =============================================================================
-- PARTE 3 — Wrapper de compatibilidade (inalterado)
--
-- Assinatura idêntica à versão anterior — todas as chamadas existentes continuam
-- funcionando. Chama a nova função principal sem passar p_cash_session_id →
-- assume DEFAULT NULL (venda sem caixa = delivery/Nuvemshop).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_sale(
  p_accumulate_cashback boolean,
  p_cashback_used       numeric,
  p_customer_id         int,
  p_discount_amount     numeric,
  p_items               jsonb,
  p_notes               text,
  p_payment_method      text,
  p_sale_origin         text,
  p_seller_id           uuid,
  p_shipping_charged    numeric,
  p_surcharge_amount    numeric,
  p_system_user_id      uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.rpc_create_sale(
    p_customer_id,
    p_seller_id,
    p_payment_method::payment_method,
    p_sale_origin,
    p_discount_amount,
    p_cashback_used,
    p_shipping_charged,
    p_notes,
    p_items,
    p_system_user_id,
    0,     -- p_card_fee
    p_surcharge_amount,
    NULL,  -- p_payments: legado sem multi-pagamento
    NULL   -- p_cash_session_id: legado sem caixa
  );
END;
$$;

-- =============================================================================
-- PARTE 4 — Grants
-- =============================================================================

-- Grant para a nova assinatura de 14 parâmetros
GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric,
  text, jsonb, uuid, numeric, numeric, jsonb, bigint
) TO service_role, authenticated;

-- Grant do wrapper (inalterado, mas recriado para garantia)
GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid
) TO service_role, authenticated;

-- =============================================================================
-- Smoke test inline
-- =============================================================================

-- Confirmar que a nova assinatura existe (14 parâmetros)
SELECT pg_get_function_arguments(p.oid) AS args
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname    = 'public'
  AND  p.proname    = 'rpc_create_sale'
ORDER  BY pg_get_function_arguments(p.oid);
-- Esperado: 2 linhas (14-param principal + 12-param wrapper)

-- =============================================================================
-- FIM DA MIGRATION 20260522 — PARTE 3/3 (rpc_create_sale + cash_session_id)
-- =============================================================================
