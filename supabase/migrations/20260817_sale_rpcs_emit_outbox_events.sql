-- FASE 2 (Integration Foundation) — emissão transacional de eventos de
-- domínio nas 4 RPCs canônicas de venda.
--
-- REGRA NÃO-NEGOCIÁVEL (seção 21 do pedido): o evento nasce DENTRO da mesma
-- transação Postgres do domínio, nunca depois do COMMIT via API route. As
-- 4 funções abaixo são `CREATE OR REPLACE FUNCTION` com o corpo VIGENTE
-- (confirmado nesta sessão, ver relatório da Fase 2 seção I) copiado
-- verbatim + exatamente 1 bloco `INSERT INTO integration_outbox` cada,
-- sempre como a ÚLTIMA operação de escrita antes do fim da função (depois
-- de todo efeito comercial já ter acontecido — estoque, financeiro,
-- pagamento, cashback). Se o INSERT falhar, a função inteira falha e a
-- transação inteira dá ROLLBACK (nenhuma venda "sem evento") — desejado,
-- não um bug: o INSERT é local, sem rede, sem HTTP, risco de falha
-- praticamente nulo.
--
-- IMPORTANTE — GRANT/REVOKE: nenhuma das 4 funções abaixo teve seu GRANT
-- alterado por esta migration, DE PROPÓSITO. As 4 já foram revogadas de
-- `authenticated` em 20260811_fix_rpc_identity_grants_tenant.sql (Fase 0)
-- e `rpc_create_sale`/`rpc_process_exchange` especificamente em suas
-- migrations originais também listavam `GRANT ... TO authenticated` — essa
-- linha NÃO foi copiada aqui. `CREATE OR REPLACE FUNCTION` preserva
-- ownership/permissions existentes (documentado no manual do Postgres) —
-- copiar aquele GRANT antigo teria REABERTO a vulnerabilidade de
-- personificação cross-tenant corrigida na Fase 0. Confirme com
-- `has_function_privilege('authenticated', ...)` = false depois de aplicar,
-- mesmo padrão de verificação já usado nas fases anteriores.
--
-- event_id determinístico (idempotência): `sale:<sale_id>:<evento>` — cada
-- uma das 4 RPCs só consegue gerar o evento dela UMA vez por venda, porque
-- as guardas de estado terminal já existentes (bloqueiam recancelar/
-- redevolver/retrocar) impedem a mesma RPC rodar 2x pra mesma venda no
-- mesmo estado. A constraint UNIQUE(event_id) em integration_outbox é a
-- rede de segurança final, não a única linha de defesa.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. rpc_create_sale → sale.completed
-- Base copiada verbatim de 20260704_fix_cashback_expiry_and_earn.sql (v5,
-- confirmada como vigente nesta sessão — nenhuma migration posterior
-- redefine esta função). ÚNICA mudança funcional: o bloco
-- "Evento de domínio" logo antes do RETURN. Nada mais foi tocado.
-- =============================================================================

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
  p_responsible_seller_id int      DEFAULT NULL
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

  -- Cashback earn (restaurado de 20260612, ausente em v4)
  v_is_anon         boolean;
  v_rate_pct        numeric;
  v_release_days    int;
  v_expiry_days     int;
  v_min_order       numeric;
  v_earn_amount     numeric;
  v_earn_status     cashback_status;
  v_earn_release    date;
  v_earn_expiry     date;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_stock_mode NOT IN ('main_store', 'online_priority') THEN
    RAISE EXCEPTION 'p_stock_mode inválido: %. Aceitos: main_store, online_priority.', p_stock_mode
      USING ERRCODE = 'P0001';
  END IF;

  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
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
    v_pvid       := (v_item->>'product_variation_id')::int;
    v_qty        := (v_item->>'quantity')::int;
    v_unit_price := (v_item->>'unit_price')::numeric;
    v_discount   := COALESCE((v_item->>'discount_amount')::numeric, 0);

    SELECT p.company_id INTO v_item_company
    FROM product_variations pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = v_pvid;

    IF v_item_company IS DISTINCT FROM v_company_id THEN
      RAISE EXCEPTION 'Produto não pertence à empresa.' USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount, 2);
  END LOOP;

  v_card_fee     := COALESCE(p_card_fee, 0);
  v_surcharge    := COALESCE(p_surcharge_amount, 0);
  v_eff_cashback := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_gross        := ROUND(v_subtotal - COALESCE(p_discount_amount, 0) + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total        := ROUND(v_gross - v_eff_cashback, 2);

  -- ─── Validar saldo de crédito ─────────────────────────────────────────────
  -- CORREÇÃO v5: filtra expiry_date E company_id.
  -- Cashback vencido ou de outra empresa não conta, mesmo sem o job rodar.
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

  IF p_stock_mode = 'main_store' THEN
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
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id,
    responsible_seller_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id,
    p_responsible_seller_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Registrar consumo de crédito ────────────────────────────────────────
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

  -- ─── Finance entries ──────────────────────────────────────────────────────
  IF v_total > 0 THEN
    INSERT INTO finance_entries (
      type, category, description, amount, reference_date, sale_id, created_by, company_id
    )
    VALUES (
      'income', 'sale', 'Venda ' || v_sale_number,
      v_total, v_brazil_date, v_sale_id, p_system_user_id, v_company_id
    );
  END IF;

  -- ─── Pagamentos ──────────────────────────────────────────────────────────
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

  -- ─── Gerar cashback earn (restaurado, ausente em v4) ─────────────────────
  -- Só gera se o cliente NÃO usou cashback nesta venda (cashback_action='accumulate').
  -- Condições: cliente identificado, não anônimo, config ativa, total >= mínimo.
  IF COALESCE(p_cashback_used, 0) = 0 AND p_customer_id IS NOT NULL THEN
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

  -- ─── Evento de domínio (Fase 2 — Integration Foundation) ─────────────────
  -- ÚNICA mudança funcional desta migration em relação ao corpo vigente
  -- (20260704_fix_cashback_expiry_and_earn.sql). Nasce depois de todo
  -- efeito comercial, mesma transação, event_id determinístico.
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
      'sale_date',       v_brazil_date
    )
  );

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;

-- Nenhum GRANT aqui — ver nota no cabeçalho do arquivo.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. rpc_cancel_sale → sale.cancelled
-- Base copiada verbatim de 20260811_fix_rpc_identity_grants_tenant.sql
-- (vigente, confirmada nesta sessão). ÚNICA mudança funcional: o bloco
-- "Evento de domínio" no fim da função.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_cancel_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale            record;
  v_item            record;
  v_main_store_id   int;
  v_prev_qty        numeric := 0;
  v_brazil_date     date;
  v_caller_company  int;
BEGIN
  -- Permite escrita em stock_balances (bypass do trigger de proteção)
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  -- ─── Lock + leitura da venda ───────────────────────────────────────────────
  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  -- ─── Validação de tenant (novo — defense-in-depth) ─────────────────────────
  -- Reforça, dentro do banco, o que já era checado em vendas.service.ts
  -- (cancelSale). Nunca confiar apenas na camada de serviço.
  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% já foi cancelada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida e não pode ser cancelada.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ─── Cancelar venda ────────────────────────────────────────────────────────
  UPDATE sales
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_system_user_id, updated_at = NOW()
  WHERE id = p_sale_id;

  -- ─── Identificar local de estoque principal ────────────────────────────────
  v_main_store_id := public.fn_main_store_id(v_sale.company_id);

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Empresa % sem local de estoque principal configurado.', v_sale.company_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ─── Restaurar estoque em stock_balances ───────────────────────────────────
  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    -- Upsert: cria linha se não existir (produto nunca teve estoque nesta loja)
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_item.product_variation_id, v_main_store_id, v_item.quantity, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_item.quantity,
          last_updated = NOW();

    -- Ledger de movimentação
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text,
      v_sale.company_id, v_main_store_id, 'cancel', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  -- ─── Cashback: cancelar earn gerado por esta venda ─────────────────────────
  -- Transações pending/available viram 'reversed' → saem do saldo do cliente
  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Cancelamento da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

  -- ─── Cashback: restituir valor usado pelo cliente nesta venda ──────────────
  -- Se o cliente pagou parte com cashback, devolvemos o valor como crédito imediato
  IF COALESCE(v_sale.cashback_used, 0) > 0 AND v_sale.customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      release_date, expiry_date, reverse_reason
    )
    VALUES (
      v_sale.customer_id, v_sale.company_id, p_sale_id,
      'earn', v_sale.cashback_used, 'available',
      v_brazil_date, NULL,
      'Restituição de cashback — cancelamento da venda ' || v_sale.sale_number
    );
  END IF;

  -- Financeiro 2.1: nenhuma finance_entries é criada aqui. A competência do
  -- cancelamento passa a ser sales.status/cancelled_at/cancelled_by, consumida
  -- por vw_dre_mensal. Uma devolução financeira real é escopo da Financeiro 2.2.

  -- ─── Evento de domínio (Fase 2 — Integration Foundation) ─────────────────
  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_sale.company_id,
    'sale:' || p_sale_id || ':cancelled',
    'sale.cancelled',
    'sale',
    p_sale_id::text,
    jsonb_build_object(
      'sale_id',       p_sale_id,
      'sale_number',   v_sale.sale_number,
      'customer_id',   v_sale.customer_id,
      'total',         v_sale.total,
      'cancelled_by',  p_system_user_id
    )
  );
END;
$$;

-- Nenhum GRANT aqui — ver nota no cabeçalho do arquivo.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. rpc_return_sale → sale.refunded
-- Base copiada verbatim de 20260811_fix_rpc_identity_grants_tenant.sql
-- (vigente, confirmada nesta sessão). ÚNICA mudança funcional: o bloco
-- "Evento de domínio" no fim da função.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_return_sale(
  p_sale_id        int,
  p_system_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale            record;
  v_item            record;
  v_main_store_id   int;
  v_prev_qty        numeric := 0;
  v_brazil_date     date;
  v_caller_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

  -- ─── Validação de tenant (novo — defense-in-depth) ─────────────────────────
  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda #% já foi devolvida.', p_sale_id USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda #% está cancelada e não pode ser devolvida.', p_sale_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status = 'returned', returned_at = NOW(), returned_by = p_system_user_id, updated_at = NOW()
  WHERE id = p_sale_id;

  v_main_store_id := public.fn_main_store_id(v_sale.company_id);

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Empresa % sem local de estoque principal configurado.', v_sale.company_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN
    SELECT product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_item.product_variation_id, v_main_store_id, v_item.quantity, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_item.quantity,
          last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_item.product_variation_id, pv.product_id,
      'return', v_item.quantity,
      v_prev_qty, v_prev_qty + v_item.quantity,
      v_item.unit_cost, p_sale_id::text,
      v_sale.company_id, v_main_store_id, 'return', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  -- Cashback earn gerado pela venda → reverter
  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Devolução da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

  -- Cashback que o cliente usou → restituir como crédito imediato
  IF COALESCE(v_sale.cashback_used, 0) > 0 AND v_sale.customer_id IS NOT NULL THEN
    INSERT INTO cashback_transactions (
      customer_id, company_id, sale_id,
      type, amount, status,
      release_date, expiry_date, reverse_reason
    )
    VALUES (
      v_sale.customer_id, v_sale.company_id, p_sale_id,
      'earn', v_sale.cashback_used, 'available',
      v_brazil_date, NULL,
      'Restituição de cashback — devolução da venda ' || v_sale.sale_number
    );
  END IF;

  -- Financeiro 2.1: nenhuma finance_entries é criada aqui. A competência da
  -- devolução passa a ser sales.status/returned_at/returned_by, consumida
  -- por vw_dre_mensal. Uma devolução financeira real é escopo da Financeiro 2.2.

  -- ─── Evento de domínio (Fase 2 — Integration Foundation) ─────────────────
  INSERT INTO integration_outbox (
    company_id, event_id, event_type, aggregate_type, aggregate_id, payload
  )
  VALUES (
    v_sale.company_id,
    'sale:' || p_sale_id || ':refunded',
    'sale.refunded',
    'sale',
    p_sale_id::text,
    jsonb_build_object(
      'sale_id',      p_sale_id,
      'sale_number',  v_sale.sale_number,
      'customer_id',  v_sale.customer_id,
      'total',        v_sale.total,
      'returned_by',  p_system_user_id,
      'source',       'rpc_return_sale'
    )
  );
END;
$$;

-- Nenhum GRANT aqui — ver nota no cabeçalho do arquivo.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. rpc_process_exchange → sale.refunded (só quando 100% dos itens
-- trocados — troca parcial NÃO emite evento nesta fase, ver seção 26 do
-- pedido da Fase 2 / seção E do relatório).
-- Base copiada verbatim de 20260726_fix_rpc_process_exchange_guards.sql
-- (vigente, confirmada nesta sessão). ÚNICA mudança funcional: o INSERT em
-- integration_outbox DENTRO do `IF v_total_exch_qty >= v_total_orig_qty`
-- já existente — mesmo event_id (`sale:<id>:refunded`) que rpc_return_sale
-- usaria pra essa venda, o que é seguro e intencional: as guardas de status
-- terminal (`cancelled`/`returned`) já impedem as duas RPCs gerarem esse
-- evento pra mesma venda — e mesmo que isso um dia falhasse, o UNIQUE em
-- event_id barra a duplicata.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_process_exchange(
  p_company_id  int,
  p_sale_id     int,
  p_customer_id int,
  p_items       jsonb,  -- [{sale_item_id, quantity_returned}]
  p_notes       text,
  p_user_id     uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale           record;
  v_sale_item      record;
  v_el             jsonb;
  v_qty_ret        int;
  v_already_ret    int;
  v_prev_qty       int;
  v_total_credit   numeric(10,2) := 0;
  v_exchange_id    int;
  v_total_orig_qty int;
  v_total_exch_qty int;
  v_main_store_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- Travar e validar a venda
  SELECT id, company_id, customer_id, status
  INTO v_sale
  FROM sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.company_id <> p_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'Cliente não corresponde à venda.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'cancelled' THEN
    RAISE EXCEPTION 'Venda cancelada não pode ser trocada.' USING ERRCODE = 'P0001';
  END IF;
  IF v_sale.status = 'returned' THEN
    RAISE EXCEPTION 'Venda já foi devolvida e não pode ser trocada novamente.' USING ERRCODE = 'P0001';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Selecione ao menos um item para trocar.' USING ERRCODE = 'P0001';
  END IF;

  -- Resolver Estoque Loja da empresa (fonte de verdade pós-20260610)
  v_main_store_id := public.fn_main_store_id(p_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      p_company_id USING ERRCODE = 'P0001';
  END IF;

  -- Validar itens e somar crédito
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.sale_id, si.quantity, si.unit_price,
           si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int
      AND si.sale_id = p_sale_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % não pertence à venda.', (v_el->>'sale_item_id')
        USING ERRCODE = 'P0001';
    END IF;
    IF v_qty_ret <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero.' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(SUM(ei.quantity_returned), 0)
    INTO v_already_ret
    FROM exchange_items ei
    JOIN exchanges ex ON ex.id = ei.exchange_id
    WHERE ei.sale_item_id = v_sale_item.id
      AND ex.status = 'completed';

    IF v_qty_ret > (v_sale_item.quantity - v_already_ret) THEN
      RAISE EXCEPTION
        'Quantidade (%) excede o disponível para troca (%) no item %.',
        v_qty_ret, (v_sale_item.quantity - v_already_ret), v_sale_item.id
        USING ERRCODE = 'P0001';
    END IF;

    v_total_credit := v_total_credit + (v_qty_ret * v_sale_item.unit_price);
  END LOOP;

  -- Criar registro da troca
  INSERT INTO exchanges (
    company_id, original_sale_id, customer_id,
    returned_amount, credit_issued, notes, created_by
  )
  VALUES (
    p_company_id, p_sale_id, p_customer_id,
    v_total_credit, v_total_credit, p_notes, p_user_id
  )
  RETURNING id INTO v_exchange_id;

  -- Criar itens, restaurar estoque em stock_balances (Estoque Loja) e ledger
  FOR v_el IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty_ret := (v_el->>'quantity_returned')::int;

    SELECT si.id, si.quantity, si.unit_price, si.product_variation_id, si.unit_cost
    INTO v_sale_item
    FROM sale_items si
    WHERE si.id = (v_el->>'sale_item_id')::int;

    INSERT INTO exchange_items (
      exchange_id, sale_item_id, product_variation_id,
      quantity_returned, unit_price, total_returned
    )
    VALUES (
      v_exchange_id, v_sale_item.id, v_sale_item.product_variation_id,
      v_qty_ret, v_sale_item.unit_price, v_qty_ret * v_sale_item.unit_price
    );

    -- Ler saldo atual no Estoque Loja com lock anti-concorrência
    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_sale_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    -- Upsert: cria linha se nunca houve estoque neste local
    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_sale_item.product_variation_id, v_main_store_id, v_qty_ret, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_qty_ret,
          last_updated = NOW();

    -- Ledger de movimentação (padrão do rpc_return_sale)
    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by
    )
    SELECT
      v_sale_item.product_variation_id, pv.product_id,
      'return', v_qty_ret,
      v_prev_qty, v_prev_qty + v_qty_ret,
      v_sale_item.unit_cost, p_sale_id::text,
      p_company_id, v_main_store_id, 'exchange', 'sale', p_user_id
    FROM product_variations pv
    WHERE pv.id = v_sale_item.product_variation_id;
  END LOOP;

  -- Gerar crédito imediato (entra direto no available_balance da view)
  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id,
    type, amount, status, release_date, exchange_id
  )
  VALUES (
    p_customer_id, p_company_id, p_sale_id,
    'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id
  );

  -- Marcar venda como devolvida se todos os itens foram trocados
  SELECT SUM(quantity) INTO v_total_orig_qty
  FROM sale_items
  WHERE sale_id = p_sale_id;

  SELECT COALESCE(SUM(ei.quantity_returned), 0) INTO v_total_exch_qty
  FROM exchange_items ei
  JOIN exchanges ex ON ex.id = ei.exchange_id
  WHERE ex.original_sale_id = p_sale_id
    AND ex.status = 'completed';

  IF v_total_exch_qty >= v_total_orig_qty THEN
    UPDATE sales
    SET status = 'returned', returned_at = NOW(), returned_by = p_user_id, updated_at = NOW()
    WHERE id = p_sale_id;

    -- ─── Evento de domínio (Fase 2 — Integration Foundation) ───────────────
    -- Só aqui dentro — troca parcial (v_total_exch_qty < v_total_orig_qty)
    -- não emite evento nenhum nesta fase, de propósito (seção 26 do pedido).
    INSERT INTO integration_outbox (
      company_id, event_id, event_type, aggregate_type, aggregate_id, payload
    )
    VALUES (
      p_company_id,
      'sale:' || p_sale_id || ':refunded',
      'sale.refunded',
      'sale',
      p_sale_id::text,
      jsonb_build_object(
        'sale_id',      p_sale_id,
        'customer_id',  p_customer_id,
        'returned_by',  p_user_id,
        'source',       'rpc_process_exchange',
        'exchange_id',  v_exchange_id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'exchange_id',   v_exchange_id,
    'credit_amount', v_total_credit
  );
END;
$$;

-- Nenhum GRANT aqui — ver nota no cabeçalho do arquivo.
