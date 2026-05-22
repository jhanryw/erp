-- =============================================================================
-- Migration 20260522: rpc_create_sale — suporte a múltiplos pagamentos
--
-- DEPENDE DE: 20260522_sale_payments.sql + 20260522_sale_payments_table.sql
--   (enum credit_card/debit_card e tabela sale_payments já devem existir)
--
-- O QUE MUDA:
--   1. Adiciona parâmetro p_payments jsonb DEFAULT NULL à função principal
--   2. Path legado (p_payments IS NULL) — comportamento 100% idêntico ao atual
--      + insere automaticamente 1 linha em sale_payments para uniformidade
--   3. Path novo (p_payments IS NOT NULL) — valida, calcula taxa, insere
--      sale_payments e finance_entries de taxa de cartão
--   4. Atualiza wrapper de compatibilidade para passar NULL explicitamente
--
-- O QUE NÃO MUDA:
--   Estoque, cashback, finance_entry de receita, pré-lock anti-deadlock,
--   cálculo de totais, validação de empresa/variação.
--
-- ROLLBACK:
--   Recriar a versão anterior (12 params) a partir do 000_schema_completo.sql
-- =============================================================================

-- =============================================================================
-- PARTE 1 — Drop da versão atual de 12 parâmetros
-- (a nova terá 13 — assinatura diferente, não é substituição direta)
-- =============================================================================

DROP FUNCTION IF EXISTS public.rpc_create_sale(
  int, uuid, text, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric
);

-- =============================================================================
-- PARTE 2 — Nova função principal: rpc_create_sale (13 parâmetros)
-- =============================================================================

CREATE FUNCTION public.rpc_create_sale(
  p_customer_id       int,
  p_seller_id         uuid,
  p_payment_method    payment_method,       -- legado: mantido para compatibilidade
  p_sale_origin       text,
  p_discount_amount   numeric,
  p_cashback_used     numeric,
  p_shipping_charged  numeric,
  p_notes             text,
  p_items             jsonb,
  p_system_user_id    uuid,
  p_card_fee          numeric  DEFAULT 0,
  p_surcharge_amount  numeric  DEFAULT 0,
  p_payments          jsonb    DEFAULT NULL  -- novo: array de pagamentos
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- variáveis originais (inalteradas)
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

  -- variáveis novas para o path p_payments
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Data no fuso de Fortaleza (UTC-3, sem DST)
  v_brazil_date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Fortaleza')::date;
  v_card_fee    := GREATEST(0, COALESCE(p_card_fee, 0));
  v_surcharge   := GREATEST(0, COALESCE(p_surcharge_amount, 0));

  SELECT company_id INTO v_company_id FROM users WHERE id = p_seller_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Vendedor nao esta associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- Validação de empresa + cálculo de subtotal (inalterado)
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

  -- ─── Validação e pré-processamento do novo path (p_payments) ──────────────
  -- Executado ANTES do INSERT em sales para poder abortar sem efeito colateral.

  IF p_payments IS NOT NULL THEN

    -- Passo 1: validar cada payment e encontrar o dominante
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method   := (v_pmt->>'method')::payment_method;
      v_pmt_net      := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_tendered := COALESCE((v_pmt->>'amount_tendered')::numeric, v_pmt_net);
      v_pmt_change   := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_install  := COALESCE((v_pmt->>'installments')::int, 1);

      -- Método deve ser um dos valores do novo fluxo
      IF v_pmt_method NOT IN ('pix', 'cash', 'credit_card', 'debit_card') THEN
        RAISE EXCEPTION 'Metodo de pagamento invalido: %. Use pix, cash, credit_card ou debit_card.',
          v_pmt->>'method' USING ERRCODE = 'P0001';
      END IF;

      -- Valor líquido deve ser positivo
      IF v_pmt_net <= 0 THEN
        RAISE EXCEPTION 'net_amount deve ser positivo. Recebido: %.', v_pmt_net
          USING ERRCODE = 'P0001';
      END IF;

      -- Valor entregue >= valor cobrado
      IF v_pmt_tendered < v_pmt_net THEN
        RAISE EXCEPTION 'amount_tendered (%) deve ser maior ou igual a net_amount (%).',
          v_pmt_tendered, v_pmt_net USING ERRCODE = 'P0001';
      END IF;

      -- Invariante matemática do troco
      IF ABS(v_pmt_net - (v_pmt_tendered - v_pmt_change)) > 0.01 THEN
        RAISE EXCEPTION 'net_amount (%) incoerente: amount_tendered (%) - change_amount (%) = %.',
          v_pmt_net, v_pmt_tendered, v_pmt_change, v_pmt_tendered - v_pmt_change
          USING ERRCODE = 'P0001';
      END IF;

      -- Troco só em dinheiro
      IF v_pmt_change > 0 AND v_pmt_method != 'cash' THEN
        RAISE EXCEPTION 'Troco so e permitido em pagamentos em dinheiro (metodo: %).',
          v_pmt_method USING ERRCODE = 'P0001';
      END IF;

      -- change_method obrigatório quando há troco
      IF v_pmt_change > 0 AND (v_pmt->>'change_method') IS NULL THEN
        RAISE EXCEPTION 'change_method e obrigatorio quando ha troco.'
          USING ERRCODE = 'P0001';
      END IF;

      -- Parcelamento só em crédito
      IF v_pmt_install > 1 AND v_pmt_method != 'credit_card' THEN
        RAISE EXCEPTION 'Parcelamento (%) so e permitido em cartao de credito (metodo: %).',
          v_pmt_install, v_pmt_method USING ERRCODE = 'P0001';
      END IF;

      v_payments_total := v_payments_total + v_pmt_net;

      -- Método dominante = maior net_amount
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := v_pmt_method;
      END IF;
    END LOOP;

    -- Passo 2: fechar o total
    IF ABS(v_payments_total - v_total) > 0.01 THEN
      RAISE EXCEPTION 'Soma dos pagamentos (%) difere do total da venda (%). Diferenca: %.',
        ROUND(v_payments_total, 2), ROUND(v_total, 2),
        ROUND(ABS(v_payments_total - v_total), 2)
        USING ERRCODE = 'P0001';
    END IF;

  END IF;

  -- ─── Pré-lock ordenado por pvid (elimina deadlock entre vendas concorrentes) ─

  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1 FROM stock WHERE product_variation_id = v_pvid FOR UPDATE;
  END LOOP;

  -- ─── INSERT em sales ───────────────────────────────────────────────────────
  -- payment_method: usa dominante (novo path) ou p_payment_method (legado)

  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Itens + estoque (inalterado) ─────────────────────────────────────────

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

  -- ─── Finance entries de receita e cashback (inalteradas) ──────────────────

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

  -- ─── sale_payments ────────────────────────────────────────────────────────

  IF p_payments IS NOT NULL THEN

    -- Novo path: inserir cada payment, calcular taxa de cartão
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_method   := (v_pmt->>'method')::payment_method;
      v_pmt_tendered := COALESCE((v_pmt->>'amount_tendered')::numeric, 0);
      v_pmt_change   := COALESCE((v_pmt->>'change_amount')::numeric, 0);
      v_pmt_change_mth := v_pmt->>'change_method';
      v_pmt_net      := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      v_pmt_install  := COALESCE((v_pmt->>'installments')::int, 1);
      v_pmt_brand    := v_pmt->>'card_brand';
      v_pmt_acquirer := v_pmt->>'acquirer';
      v_pmt_metadata := COALESCE((v_pmt->'metadata'), '{}');
      v_fee_pct      := 0;
      v_fee_amt      := 0;

      -- Buscar taxa para cartões
      IF v_pmt_method IN ('credit_card', 'debit_card') THEN
        SELECT fee_percentage INTO v_fee_pct
        FROM payment_fee_settings
        WHERE company_id     = v_company_id
          AND payment_method = 'card'
          AND installments   = v_pmt_install;

        IF NOT FOUND THEN
          RAISE WARNING
            'Taxa nao encontrada: company_id=%, metodo=%, parcelas=%. Usando 0.',
            v_company_id, v_pmt_method, v_pmt_install;
          v_fee_pct := 0;
        END IF;

        v_fee_pct := COALESCE(v_fee_pct, 0);
        v_fee_amt := ROUND(v_pmt_net * v_fee_pct / 100.0, 2);

        -- Finance entry de taxa apenas quando há taxa configurada
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

    -- Path legado: comportamento original de finance_entry de cartão
    IF v_card_fee > 0 THEN
      INSERT INTO finance_entries (
        type, category, description, amount, reference_date, sale_id, created_by, company_id
      )
      VALUES (
        'expense', 'operational', 'Taxa de cartao — Venda ' || v_sale_number,
        v_card_fee, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
      );
    END IF;

    -- Inserir linha única em sale_payments para uniformidade de relatórios
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
-- PARTE 3 — Wrapper de compatibilidade (atualizado para passar NULL explícito)
--
-- Assinatura idêntica à versão anterior — nenhuma chamada existente quebra.
-- Redireciona para a nova função principal com p_payments = NULL.
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
    0,                   -- p_card_fee
    p_surcharge_amount,
    NULL                 -- p_payments: legado sempre usa NULL
  );
END;
$$;

-- =============================================================================
-- PARTE 4 — Grants
-- =============================================================================

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric,
  text, jsonb, uuid, numeric, numeric, jsonb
) TO service_role, authenticated;

-- =============================================================================
-- FIM DA MIGRATION 20260522_rpc_create_sale_payments
-- =============================================================================
