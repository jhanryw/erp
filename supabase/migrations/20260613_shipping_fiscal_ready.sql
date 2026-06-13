-- =============================================================================
-- 20260613_shipping_fiscal_ready.sql
--
-- OBJETIVO: Preparar módulo de frete para futura emissão NFC-e/NF-e.
--
-- PARTE 1 — Remove trg_auto_freight_expense
--   Antes: a cada INSERT em sales com shipping_charged > 0, um trigger criava
--          automaticamente finance_entries(expense, freight_cost) pelo valor
--          total do frete. Isso assumia repasse 100% ao motoboy imediatamente.
--   Depois: nenhuma despesa é lançada na hora da venda. O lançamento ocorre
--           apenas quando o repasse ao motoboy for explicitamente marcado como
--           pago via POST /api/shipping/shipments/[id]/repasse/pagar.
--   Registros históricos de freight_cost em finance_entries: preservados.
--
-- PARTE 2 — sales.products_total (novo campo)
--   Valor líquido dos produtos antes de frete, surcharge e cashback.
--   Cálculo: subtotal - discount_amount
--   Mapeamento fiscal NF-e: vProd (com vDesc separado para SEFAZ granular)
--   Nota: surcharge_amount → vOutro; shipping_charged → vFrete; total → vNF.
--
-- PARTE 3 — shipments: novos campos
--   mod_frete                  → <modFrete> no bloco <transp> da NF-e (0=CIF)
--   internal_cost_real         → custo real pago ao motoboy (vs. internal_cost
--                                 que é a estimativa da regra de frete)
--   repasse_status             → pending / paid / not_applicable
--   repasse_amount             → valor a repassar (usa real se disponível)
--   repasse_paid_at            → timestamp do pagamento
--   repasse_finance_entry_id   → FK para finance_entries (idempotência)
--
-- PARTE 4 — View vw_sale_shipping_summary (gerencial)
-- PARTE 5 — rpc_create_sale atualizado para gravar products_total
--
-- IMPACTO FISCAL CONFIRMADO:
--   ✓ shipping_charged em sales é campo separado → vFrete na NF-e
--   ✓ products_total em sales → vProd (aproximado; vDesc por item no momento fiscal)
--   ✓ total em sales → vNF
--   ✓ mod_frete em shipments → <modFrete> no XML
--   ✓ internal_cost / internal_cost_real → NUNCA vão para a NF-e
--   ✓ cashback_used → não reduz vNF (tratado como forma de pagamento no fiscal)
--
-- ROLLBACK: ver seção ao final deste arquivo.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — Remover trigger de despesa automática de frete
-- ═══════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_auto_freight_expense ON public.sales;
DROP FUNCTION IF EXISTS public.trg_fn_auto_freight_expense();

-- Nota: registros históricos em finance_entries WHERE category = 'freight_cost'
-- NÃO são removidos. Para vendas anteriores a esta migration, o repasse já
-- estava registrado como despesa. O campo repasse_status nessas shipments
-- deve ser marcado como 'paid' manualmente ou via script de backfill.


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — Adicionar products_total à tabela sales
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS products_total NUMERIC(10,2);

-- Backfill: preenche para todas as vendas existentes.
-- products_total = subtotal - discount_amount (valor líquido dos produtos, sem frete).
UPDATE public.sales
SET products_total = ROUND(
  COALESCE(subtotal, 0) - COALESCE(discount_amount, 0),
  2
)
WHERE products_total IS NULL;

COMMENT ON COLUMN public.sales.products_total IS
  'Valor líquido dos produtos (subtotal - discount_amount), sem frete/surcharge. Mapeamento NF-e: vProd - vDesc.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — Novos campos em shipments
-- ═══════════════════════════════════════════════════════════════════════════════

-- 3a. Modalidade de frete para NF-e
--     0 = Emitente paga (CIF — padrão: loja paga motoboy)
--     1 = Destinatário paga (FOB)
--     9 = Sem frete
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS mod_frete SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.shipments.mod_frete IS
  'Modalidade de frete NF-e: 0=CIF(emitente paga), 1=FOB(destinatário), 9=sem frete.';

-- 3b. Custo real ao motoboy (confirmado após entrega)
--     A estimativa já existe como internal_cost (da shipping_rule ou manual).
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS internal_cost_real NUMERIC(10,2);

COMMENT ON COLUMN public.shipments.internal_cost_real IS
  'Custo real pago ao motoboy após confirmação da entrega. Null = ainda não confirmado. Referência: internal_cost = estimativa.';

-- 3c. Controle de repasse ao motoboy
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS repasse_status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_repasse_status CHECK (repasse_status IN ('pending', 'paid', 'not_applicable'));

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS repasse_amount NUMERIC(10,2);

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS repasse_paid_at TIMESTAMPTZ;

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS repasse_finance_entry_id INT
    REFERENCES public.finance_entries(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.shipments.repasse_status IS
  'pending = aguardando pagamento ao motoboy; paid = repasse realizado; not_applicable = retirada ou sem motoboy.';
COMMENT ON COLUMN public.shipments.repasse_amount IS
  'Valor a repassar ao motoboy. Usa internal_cost_real se disponível, senão internal_cost.';
COMMENT ON COLUMN public.shipments.repasse_finance_entry_id IS
  'FK para finance_entries criado no momento do repasse. Garante idempotência: não duplica o lançamento.';

-- 3d. Ajustar repasse_status para envios de retirada (pickup nunca tem motoboy)
UPDATE public.shipments
SET repasse_status = 'not_applicable'
WHERE delivery_mode = 'pickup'
  AND repasse_status = 'pending';

-- 3e. Inicializar repasse_amount com internal_cost (estimativa)
UPDATE public.shipments
SET repasse_amount = internal_cost
WHERE repasse_amount IS NULL
  AND internal_cost IS NOT NULL
  AND repasse_status = 'pending';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 4 — View gerencial vw_sale_shipping_summary
-- ═══════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS public.vw_sale_shipping_summary;

CREATE VIEW public.vw_sale_shipping_summary AS
SELECT
  s.id                                                          AS sale_id,
  s.sale_number,
  s.sale_date,
  s.company_id,
  s.products_total,
  s.shipping_charged,
  s.surcharge_amount,
  s.cashback_used,
  s.total                                                       AS total_sale,

  sh.id                                                         AS shipment_id,
  sh.delivery_mode,
  sh.status                                                     AS shipment_status,
  sh.mod_frete,
  sh.motoboy,
  sh.internal_cost                                              AS internal_cost_estimated,
  sh.internal_cost_real,
  COALESCE(sh.internal_cost_real, sh.internal_cost)             AS repasse_amount_effective,
  ROUND(
    s.shipping_charged
    - COALESCE(sh.internal_cost_real, sh.internal_cost, 0),
    2
  )                                                             AS shipping_admin_fee,
  sh.repasse_status,
  sh.repasse_amount,
  sh.repasse_paid_at,
  sh.repasse_finance_entry_id

FROM public.sales s
LEFT JOIN public.shipments sh ON sh.order_id = s.id;

GRANT SELECT ON public.vw_sale_shipping_summary TO authenticated, service_role;

COMMENT ON VIEW public.vw_sale_shipping_summary IS
  'Relatório gerencial de frete: valores fiscais, custo motoboy e status do repasse por venda.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 5 — rpc_create_sale: adiciona products_total ao INSERT em sales
--
-- Base: 20260612_fix_cashback_earn.sql (última versão com cashback earn e
-- company_id lookup corrigido via users.company_id).
--
-- ÚNICO DIFF vs. versão anterior:
--   + products_total no INSERT de sales
--   + v_products_total na seção DECLARE
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
  v_products_total  numeric;   -- novo: líquido dos produtos antes de frete/surcharge
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
  v_debit_location  int;

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

  -- cashback earn
  v_is_anon         boolean;
  v_rate_pct        numeric;
  v_release_days    int;
  v_expiry_days     int;
  v_min_order       numeric;
  v_earn_amount     numeric;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  -- ─── Empresa e data ──────────────────────────────────────────────────────────
  SELECT company_id INTO v_company_id FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_main_store_id := public.fn_main_store_id(v_company_id);

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

  v_card_fee       := COALESCE(p_card_fee, 0);
  v_surcharge      := COALESCE(p_surcharge_amount, 0);
  v_eff_cashback   := LEAST(COALESCE(p_cashback_used, 0), v_subtotal - COALESCE(p_discount_amount, 0));
  v_products_total := ROUND(v_subtotal - COALESCE(p_discount_amount, 0), 2);
  v_gross          := ROUND(v_products_total + v_surcharge + COALESCE(p_shipping_charged, 0), 2);
  v_total          := ROUND(v_gross - v_eff_cashback, 2);

  -- ─── Método dominante ────────────────────────────────────────────────────────
  IF p_payments IS NOT NULL AND jsonb_array_length(p_payments) > 0 THEN
    FOR v_pmt IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
      v_pmt_net := COALESCE((v_pmt->>'net_amount')::numeric, 0);
      IF v_pmt_net > v_max_net THEN
        v_max_net := v_pmt_net;
        v_dominant_method := (v_pmt->>'method')::payment_method;
      END IF;
    END LOOP;
  END IF;

  -- ─── Lock pessimista ─────────────────────────────────────────────────────────
  FOR v_pvid IN
    SELECT DISTINCT (value->>'product_variation_id')::int AS pvid
    FROM jsonb_array_elements(p_items) ORDER BY pvid
  LOOP
    PERFORM 1
    FROM stock_balances
    WHERE product_variation_id = v_pvid
    FOR UPDATE;
  END LOOP;

  -- ─── INSERT sales ────────────────────────────────────────────────────────────
  INSERT INTO sales (
    customer_id, seller_id, status,
    subtotal, products_total,
    discount_amount, surcharge_amount, cashback_used, shipping_charged, total,
    payment_method, sale_origin, notes, sale_date, company_id, cash_session_id
  )
  VALUES (
    p_customer_id, p_seller_id, 'paid',
    ROUND(v_subtotal, 2), v_products_total,
    p_discount_amount, v_surcharge, p_cashback_used,
    p_shipping_charged, ROUND(v_total, 2),
    COALESCE(v_dominant_method, p_payment_method),
    NULLIF(p_sale_origin, '')::customer_origin,
    p_notes, v_brazil_date, v_company_id, p_cash_session_id
  )
  RETURNING id, sale_number INTO v_sale_id, v_sale_number;

  -- ─── Itens: debita do primeiro local com saldo suficiente ───────────────────
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

    -- Preferência: Estoque Loja. Fallback: qualquer local com saldo.
    SELECT id INTO v_debit_location
    FROM stock_locations
    WHERE company_id = v_company_id AND active = true
      AND id IN (
        SELECT stock_location_id FROM stock_balances
        WHERE product_variation_id = v_pvid AND quantity >= v_qty
      )
    ORDER BY (id = v_main_store_id) DESC, priority ASC
    LIMIT 1;

    IF v_debit_location IS NULL THEN
      SELECT COALESCE(SUM(quantity), 0) INTO v_current_qty
      FROM stock_balances WHERE product_variation_id = v_pvid;

      RAISE EXCEPTION
        'Estoque insuficiente para variação #%. Total disponível: %, solicitado: %.',
        v_pvid, v_current_qty, v_qty USING ERRCODE = 'P0001';
    END IF;

    SELECT quantity INTO v_current_qty
    FROM stock_balances
    WHERE product_variation_id = v_pvid AND stock_location_id = v_debit_location;

    UPDATE stock_balances
    SET quantity     = quantity - v_qty,
        last_updated = NOW()
    WHERE product_variation_id = v_pvid
      AND stock_location_id    = v_debit_location;

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
      v_debit_location, 'sale', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_pvid;
  END LOOP;

  -- ─── Finance entries ─────────────────────────────────────────────────────────
  -- income/sale registra v_gross (inclui shipping_charged como receita).
  -- NÃO há mais despesa automática de frete — somente no repasse manual.
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

  -- ─── Cashback earn ───────────────────────────────────────────────────────────
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
        v_earn_amount := ROUND(v_total * v_rate_pct / 100.0, 2);

        IF v_earn_amount > 0 THEN
          INSERT INTO cashback_transactions (
            customer_id, company_id, sale_id,
            type, amount, status,
            release_date, expiry_date
          )
          VALUES (
            p_customer_id, v_company_id, v_sale_id,
            'earn', v_earn_amount, 'pending',
            v_brazil_date + v_release_days,
            v_brazil_date + v_release_days + v_expiry_days
          );
        END IF;
      END IF;
    END IF;
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
-- ROLLBACK
--
-- Execute no Supabase SQL Editor para reverter esta migration.
-- =============================================================================
/*

-- ── 1. Restaurar trigger de despesa automática de frete ───────────────────────
--    Re-executar o arquivo: supabase/migrations/20260606_auto_freight_expense.sql

-- ── 2. Remover products_total de sales ───────────────────────────────────────
ALTER TABLE public.sales DROP COLUMN IF EXISTS products_total;

-- ── 3. Remover novos campos de shipments ─────────────────────────────────────
ALTER TABLE public.shipments
  DROP COLUMN IF EXISTS mod_frete,
  DROP COLUMN IF EXISTS internal_cost_real,
  DROP COLUMN IF EXISTS repasse_status,
  DROP COLUMN IF EXISTS repasse_amount,
  DROP COLUMN IF EXISTS repasse_paid_at,
  DROP COLUMN IF EXISTS repasse_finance_entry_id;

-- ── 4. Remover view ───────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.vw_sale_shipping_summary;

-- ── 5. Restaurar rpc_create_sale sem products_total ──────────────────────────
--    Re-executar o arquivo: supabase/migrations/20260612_fix_cashback_earn.sql

*/
-- =============================================================================
