-- =============================================================================
-- 20260614_rpc_create_sale_main_store_only.sql
--
-- PARTE 1 — Corrige vw_stock_live_multi
--   PROBLEMA: versão anterior mesclava JOIN de stock_balances com
--             product_variation_attributes na mesma agregação, multiplicando
--             SUM(quantity) pelo número de atributos por variação.
--   CORREÇÃO: dois CTEs separados — stock_summary (saldos) e attr_summary
--             (cor/tamanho) — unidos apenas no SELECT final. Nenhum cross-join.
--   ADIÇÃO:   coluna total_stock_value_at_price (stat cards do /estoque).
--
-- PARTE 2 — Reverte rpc_create_sale para Estoque Loja exclusivo
--   CONTEXTO: 20260612_remove_transfer_requirement.sql adicionou fallback para
--             qualquer local ativo com saldo ao vender presencialmente.
--   REVERSÃO: venda presencial exige saldo no Estoque Loja. Se não tiver,
--             bloqueia com "Produto sem saldo no Estoque Loja. Transfira antes
--             de vender."
--   NÃO ALTERA: rpc_decrease_online_sale_stock, rpc_transfer_stock,
--               rpc_stock_adjust, rpc_stock_entry, fn_main_store_id,
--               stock_balances (nenhuma linha inserida/alterada), Nuvemshop.
--
-- VALIDAÇÃO DA VIEW (rodar no SQL Editor após aplicar):
--   SELECT 'stock_balances direto' AS fonte, SUM(quantity) AS total_unidades
--   FROM stock_balances
--   UNION ALL
--   SELECT 'vw_stock_live_multi' AS fonte, SUM(total_qty) AS total_unidades
--   FROM vw_stock_live_multi;
--   -- Esperado: os dois totais idênticos .
--
-- ROLLBACK PARTE 1: DROP VIEW + recriar com definição de 20260610 (pv.size/pv.color)
-- ROLLBACK PARTE 2: reaplicar 20260612_remove_transfer_requirement.sql
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — vw_stock_live_multi corrigida (CTEs separados, sem multiplicação)
-- ═══════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.vw_stock_live_multi CASCADE;

CREATE VIEW public.vw_stock_live_multi AS
WITH

-- CTE 1: saldos por variação — sem qualquer join a tabelas de atributos
stock_summary AS (
  SELECT
    sb.product_variation_id,

    -- Soma de todos os locais ativos
    COALESCE(SUM(sb.quantity), 0)::int                                        AS total_qty,

    -- Saldo só no Estoque Loja (para bloqueio de venda presencial)
    COALESCE(
      MAX(sb.quantity) FILTER (WHERE loc.is_main_store = true),
      0
    )::int                                                                    AS main_store_qty,

    -- Valor em custo: soma de (qty × avg_cost) em todos os locais ativos
    ROUND(COALESCE(SUM(sb.quantity * sb.avg_cost), 0), 2)                    AS total_stock_value_at_cost,

    -- Saldos por local (JSON ordenado por priority) — sem atributos aqui
    jsonb_agg(
      jsonb_build_object(
        'location_id',   loc.id,
        'location_name', loc.name,
        'slug',          loc.slug,
        'is_main_store', loc.is_main_store,
        'priority',      loc.priority,
        'quantity',      COALESCE(sb.quantity, 0)
      )
      ORDER BY loc.priority ASC, loc.id ASC
    )                                                                         AS balances_by_location

  FROM stock_balances sb
  JOIN stock_locations loc
    ON loc.id     = sb.stock_location_id
   AND loc.active = true

  GROUP BY sb.product_variation_id
),

-- CTE 2: atributos por variação — sem qualquer join a stock_balances
attr_summary AS (
  SELECT
    pva.product_variation_id,
    MAX(vv.value) FILTER (WHERE vt.slug = 'cor')     AS cor,
    MAX(vv.value) FILTER (WHERE vt.slug = 'tamanho') AS tamanho
  FROM product_variation_attributes pva
  JOIN variation_types  vt ON vt.id = pva.variation_type_id
  JOIN variation_values vv ON vv.id = pva.variation_value_id
  GROUP BY pva.product_variation_id
)

-- SELECT final: une os dois CTEs via product_variations + products
-- Nenhum cross-join possível: stock_summary e attr_summary têm chave pv.id
SELECT
  pv.id                                                                       AS product_variation_id,
  p.id                                                                        AS product_id,
  p.name                                                                      AS product_name,
  pv.sku_variation,
  p.sku                                                                       AS sku_parent,
  p.company_id,

  -- Atributos (do CTE separado — não influi nas agregações de saldo)
  attrs.cor,
  attrs.tamanho,

  -- Saldos (do CTE separado — sem contaminação de atributos)
  COALESCE(ss.total_qty, 0)::int                                              AS total_qty,
  COALESCE(ss.main_store_qty, 0)::int                                         AS main_store_qty,

  -- Alerta: tem estoque total mas nada no Estoque Loja → precisa transferir
  (
    COALESCE(ss.total_qty, 0) > 0
    AND COALESCE(ss.main_store_qty, 0) = 0
  )                                                                           AS needs_transfer,

  COALESCE(ss.total_stock_value_at_cost, 0)                                  AS total_stock_value_at_cost,

  -- Valor em venda: calculado aqui (price não vem do stock_balances)
  ROUND(
    COALESCE(ss.total_qty, 0) * COALESCE(pv.price_override, p.base_price),
    2
  )                                                                           AS total_stock_value_at_price,

  -- Última entrada de lote
  (
    SELECT MAX(sl2.entry_date)
    FROM stock_lots sl2
    WHERE sl2.product_variation_id = pv.id
  )                                                                           AS last_entry_date,

  COALESCE(ss.balances_by_location, '[]'::jsonb)                             AS balances_by_location

FROM product_variations pv
JOIN products           p     ON p.id  = pv.product_id
-- stock_summary: LEFT JOIN porque variação pode não ter linha em stock_balances ainda
LEFT JOIN stock_summary ss    ON ss.product_variation_id = pv.id
-- attr_summary: LEFT JOIN porque variação pode não ter atributos
LEFT JOIN attr_summary  attrs ON attrs.product_variation_id = pv.id;

GRANT SELECT ON public.vw_stock_live_multi TO authenticated, service_role;

COMMENT ON VIEW public.vw_stock_live_multi IS
  'Saldo de estoque por variação, todos os locais ativos. '
  'CTEs separados para saldos e atributos — sem multiplicação de linhas. '
  'needs_transfer=true: produto com estoque fora do Estoque Loja.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — rpc_create_sale: Estoque Loja exclusivo para vendas presenciais
--
-- DIFERENÇAS vs 20260612_remove_transfer_requirement.sql:
--   1. Pré-lock restrito ao Estoque Loja (stock_location_id = v_main_store_id)
--   2. Verificação de saldo: apenas stock_balances no Estoque Loja
--   3. Débito: sempre em v_main_store_id, sem fallback
--   4. Mensagem de erro: "Transfira antes de vender."
--   Todo o resto (pagamentos, finance entries, cashback, caixa) é idêntico
--   à versão de 20260612.
--
-- NÃO ALTERADO: rpc_decrease_online_sale_stock (online continua multilocal),
--   fn_main_store_id, rpc_transfer_stock, rpc_stock_adjust, rpc_stock_entry,
--   stock_balances (nenhum INSERT/UPDATE nesta migration).
-- ═══════════════════════════════════════════════════════════════════════════════

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
  p_cash_session_id   bigint   DEFAULT NULL
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- ─── Empresa e data ──────────────────────────────────────────────────────────
  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  -- Estoque Loja desta empresa — obrigatório para vendas presenciais
  v_main_store_id := public.fn_main_store_id(v_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      v_company_id USING ERRCODE = 'P0001';
  END IF;

  -- ─── Validação de itens ──────────────────────────────────────────────────────
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Nenhum item na venda.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Cálculo de totais ───────────────────────────────────────────────────────
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

  -- ─── Método dominante ────────────────────────────────────────────────────────
  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net         := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  -- ─── Pré-lock anti-deadlock: apenas Estoque Loja, em ordem de pvid ───────────
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

  -- ─── INSERT sales ────────────────────────────────────────────────────────────
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Itens: debita EXCLUSIVAMENTE do Estoque Loja ───────────────────────────
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

    -- Verificar saldo no Estoque Loja — única fonte para venda presencial
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

    -- Debitar do Estoque Loja
    UPDATE stock_balances
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_main_store_id;

    -- Ledger
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
  END LOOP;

  -- ─── Finance entries ─────────────────────────────────────────────────────────
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

  -- ─── Pagamentos ──────────────────────────────────────────────────────────────
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

  RETURN jsonb_build_object(
    'id',          v_sale_id,
    'sale_number', v_sale_number,
    'total',       ROUND(v_total, 2)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint
) TO service_role, authenticated;

-- =============================================================================
-- FIM — 20260614_rpc_create_sale_main_store_only.sql
-- O que esta migration altera:
--   ✅ vw_stock_live_multi (DROP + CREATE corrigido)
--   ✅ rpc_create_sale (CREATE OR REPLACE — 14 parâmetros)
--   ❌ stock_balances — nenhuma linha inserida/alterada
--   ❌ stock_locations — não tocado
--   ❌ rpc_decrease_online_sale_stock — não tocado
--   ❌ rpc_transfer_stock — não tocado
--   ❌ fn_main_store_id — não tocado
--   ❌ Nuvemshop sync — não tocado
-- =============================================================================
