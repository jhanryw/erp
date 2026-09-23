-- =============================================================================
-- 202609231200_rpc_cancel_return_exchange_kits.sql
--
-- KITS — cancelamento, devolução e troca (Fase F).
--
-- Assinaturas INALTERADAS (CREATE OR REPLACE seguro, grants preservados).
-- Corpo copiado das versões vigentes:
--   rpc_cancel_sale / rpc_return_sale → 20260915b_guard_cancel_return_against_exchanged_sales.sql
--   rpc_process_exchange              → 20260915_fix_rpc_process_exchange_no_returned_status.sql
--
-- Itens standard: caminho IDÊNTICO ao vigente (continuam voltando para o
-- Estoque Loja — débito técnico pré-existente, documentado, NÃO alterado
-- aqui para não mudar o comportamento de produtos normais).
--
-- Itens de kit (sale_item_components existe para o item):
--   - NUNCA cria saldo para o SKU do kit (o trigger
--     trg_block_kit_stock_balances também impediria).
--   - Usa SEMPRE o snapshot da venda (composição + custo + local), nunca a
--     composição atual do kit — editar o kit depois não muda a reversão.
--   - Cancelamento → cada unidade volta ao LOCAL DE ORIGEM de onde saiu
--     (mercadoria nunca deixou a empresa). Não amplia o problema de
--     "cancelamento sempre volta para o Estoque Loja".
--   - Devolução total e troca → Estoque Loja (mesma regra física já adotada
--     para itens standard: a mercadoria devolvida é recebida na loja).
--   - Troca opera em UNIDADES INTEIRAS do item comercial (kits inteiros):
--     devolver "1 das 3 calcinhas" de um kit é impossível por construção
--     (exchange_items.quantity_returned conta kits) — política de devolução
--     parcial de componente interno fica explicitamente fora da V1.
--   - Idempotência: guards de status existentes (venda já cancelada/
--     devolvida → RAISE) + limite de quantidade já trocada por item.
-- =============================================================================


CREATE OR REPLACE FUNCTION public._restore_kit_components(
  p_company_id     int,
  p_sale_id        int,
  p_sale_item_id   int,
  p_target         text,     -- 'origin' | 'main_store'
  p_kit_units      int,      -- NULL = todas as unidades vendidas do item
  p_main_store_id  int,
  p_movement_type  text,     -- 'cancel' | 'return' | 'exchange'
  p_user_id        uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_row       record;
  v_prev_qty  int;
  v_qty       int;
  v_loc       int;
BEGIN
  IF p_target NOT IN ('origin', 'main_store') THEN
    RAISE EXCEPTION 'Destino de reversão inválido: %.', p_target USING ERRCODE = 'P0001';
  END IF;

  IF p_target = 'origin' THEN
    FOR v_row IN
      SELECT sic.component_product_variation_id AS pvid,
             sic.stock_location_id               AS loc,
             sic.quantity                        AS qty,
             sic.unit_cost                       AS unit_cost,
             cpv.product_id                      AS product_id,
             kpv.sku_variation                   AS kit_sku
      FROM sale_item_components sic
      JOIN product_variations cpv ON cpv.id = sic.component_product_variation_id
      JOIN product_variations kpv ON kpv.id = sic.kit_product_variation_id
      WHERE sic.sale_item_id = p_sale_item_id
        AND sic.company_id   = p_company_id
      ORDER BY sic.component_product_variation_id, sic.stock_location_id
    LOOP
      SELECT quantity INTO v_prev_qty
      FROM stock_balances
      WHERE product_variation_id = v_row.pvid AND stock_location_id = v_row.loc
      FOR UPDATE;
      v_prev_qty := COALESCE(v_prev_qty, 0);

      INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
      VALUES (v_row.pvid, v_row.loc, v_row.qty, NOW())
      ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
        SET quantity = stock_balances.quantity + v_row.qty, last_updated = NOW();

      INSERT INTO stock_movements (
        product_variation_id, product_id, type, quantity,
        previous_stock, new_stock, unit_cost, reference_id,
        company_id, source_location_id, movement_type, reference_type, created_by, notes
      )
      VALUES (
        v_row.pvid, v_row.product_id, 'return', v_row.qty,
        v_prev_qty, v_prev_qty + v_row.qty, v_row.unit_cost, p_sale_id::text,
        p_company_id, v_row.loc, p_movement_type, 'sale', p_user_id,
        'Componente do kit ' || v_row.kit_sku
      );
    END LOOP;
    RETURN;
  END IF;

  -- main_store: agrega por componente (a composição congelada é a mesma em
  -- todas as linhas de local do componente).
  v_loc := p_main_store_id;
  FOR v_row IN
    SELECT sic.component_product_variation_id AS pvid,
           MAX(sic.quantity_per_kit)            AS qpk,
           MAX(sic.kit_quantity)                AS kit_qty,
           MAX(sic.unit_cost)                   AS unit_cost,
           MAX(cpv.product_id)                  AS product_id,
           MAX(kpv.sku_variation)               AS kit_sku
    FROM sale_item_components sic
    JOIN product_variations cpv ON cpv.id = sic.component_product_variation_id
    JOIN product_variations kpv ON kpv.id = sic.kit_product_variation_id
    WHERE sic.sale_item_id = p_sale_item_id
      AND sic.company_id   = p_company_id
    GROUP BY sic.component_product_variation_id
    ORDER BY sic.component_product_variation_id
  LOOP
    v_qty := v_row.qpk * COALESCE(p_kit_units, v_row.kit_qty);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT quantity INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_row.pvid AND stock_location_id = v_loc
    FOR UPDATE;
    v_prev_qty := COALESCE(v_prev_qty, 0);

    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_row.pvid, v_loc, v_qty, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity = stock_balances.quantity + v_qty, last_updated = NOW();

    INSERT INTO stock_movements (
      product_variation_id, product_id, type, quantity,
      previous_stock, new_stock, unit_cost, reference_id,
      company_id, source_location_id, movement_type, reference_type, created_by, notes
    )
    VALUES (
      v_row.pvid, v_row.product_id, 'return', v_qty,
      v_prev_qty, v_prev_qty + v_qty, v_row.unit_cost, p_sale_id::text,
      p_company_id, v_loc, p_movement_type, 'sale', p_user_id,
      'Componente do kit ' || v_row.kit_sku
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public._restore_kit_components(int, int, int, text, int, int, text, uuid) FROM PUBLIC, anon, authenticated;


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
  PERFORM set_config('app.stock_rpc', '1', true);

  v_brazil_date := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used, sale_type, sales_channel
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

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

  -- Prioridade 1 (2026-09-15) — venda com QUALQUER troca (parcial ou
  -- total) registrada não pode ser cancelada: parte (ou tudo) dela já
  -- não está mais com o cliente pelo caminho original, e cancelar
  -- restauraria estoque/reverteria efeitos que a troca já processou
  -- separadamente.
  IF EXISTS (
    SELECT 1 FROM exchanges WHERE original_sale_id = p_sale_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Venda #% (%) já teve item(ns) trocado(s) — não pode ser cancelada. A troca já é a operação registrada para essa mercadoria (ver exchanges).',
      p_sale_id, v_sale.sale_number USING ERRCODE = 'P0001';
  END IF;

  UPDATE sales
  SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = p_system_user_id, updated_at = NOW()
  WHERE id = p_sale_id;

  v_main_store_id := public.fn_main_store_id(v_sale.company_id);

  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Empresa % sem local de estoque principal configurado.', v_sale.company_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_item IN
    SELECT id, product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    -- Kits (202609231200): item de kit reverte os COMPONENTES a partir do
    -- snapshot da venda — nunca cria saldo para o SKU do kit.
    IF EXISTS (SELECT 1 FROM sale_item_components WHERE sale_item_id = v_item.id) THEN
      PERFORM public._restore_kit_components(
        v_sale.company_id, p_sale_id, v_item.id, 'origin', NULL,
        v_main_store_id, 'cancel', p_system_user_id
      );
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_item.product_variation_id AND p.product_kind = 'kit'
    ) THEN
      RAISE EXCEPTION 'Item de kit #% sem snapshot de componentes — reversão bloqueada.', v_item.id
        USING ERRCODE = 'P0001';
    END IF;

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
      v_sale.company_id, v_main_store_id, 'cancel', 'sale', p_system_user_id
    FROM product_variations pv WHERE pv.id = v_item.product_variation_id;
  END LOOP;

  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Cancelamento da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

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
      'cancelled_by',  p_system_user_id,
      'sale_type',     v_sale.sale_type,
      'sales_channel', v_sale.sales_channel
    )
  );
END;
$$;


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

  SELECT id, status, total, sale_number, company_id, customer_id, cashback_used, sale_type, sales_channel
  INTO v_sale
  FROM sales WHERE id = p_sale_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda #% não encontrada.', p_sale_id USING ERRCODE = 'P0001';
  END IF;

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

  -- Prioridade 1 (2026-09-15) — mesma proteção de rpc_cancel_sale: venda
  -- com QUALQUER troca (parcial ou total) já registrada não pode ser
  -- devolvida financeiramente. Devolução financeira parcial coexistindo
  -- com troca já processada exigiria reconciliar cashback/estoque/
  -- finance/fiscal entre a venda original e a(s) venda(s)-filha — fora de
  -- escopo (mesma decisão já tomada para "devolução financeira parcial").
  -- A UI já bloqueia isso via `!sale.hasExchanges`, independente de
  -- status — este guard só torna a mesma regra válida na API/RPC.
  IF EXISTS (
    SELECT 1 FROM exchanges WHERE original_sale_id = p_sale_id AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Venda #% (%) já teve item(ns) trocado(s) — não pode ser devolvida. A troca já é a operação registrada para essa mercadoria (ver exchanges).',
      p_sale_id, v_sale.sale_number USING ERRCODE = 'P0001';
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
    SELECT id, product_variation_id, quantity, unit_cost
    FROM sale_items WHERE sale_id = p_sale_id
  LOOP
    -- Kits (202609231200): item de kit reverte os COMPONENTES a partir do
    -- snapshot da venda — nunca cria saldo para o SKU do kit.
    IF EXISTS (SELECT 1 FROM sale_item_components WHERE sale_item_id = v_item.id) THEN
      PERFORM public._restore_kit_components(
        v_sale.company_id, p_sale_id, v_item.id, 'main_store', NULL,
        v_main_store_id, 'return', p_system_user_id
      );
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_item.product_variation_id AND p.product_kind = 'kit'
    ) THEN
      RAISE EXCEPTION 'Item de kit #% sem snapshot de componentes — reversão bloqueada.', v_item.id
        USING ERRCODE = 'P0001';
    END IF;

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

  UPDATE cashback_transactions
  SET status         = 'reversed',
      reverse_reason = 'Devolução da venda ' || v_sale.sale_number
  WHERE sale_id = p_sale_id
    AND type    = 'earn'
    AND status IN ('pending', 'available');

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
      'source',       'rpc_return_sale',
      'sale_type',     v_sale.sale_type,
      'sales_channel', v_sale.sales_channel
    )
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.rpc_process_exchange(
  p_company_id  int,
  p_sale_id     int,
  p_customer_id int,
  p_items       jsonb,
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
  v_main_store_id  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT id, company_id, customer_id, status, sale_number, sale_type, sales_channel
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

  v_main_store_id := public.fn_main_store_id(p_company_id);
  IF v_main_store_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa (company_id=%).',
      p_company_id USING ERRCODE = 'P0001';
  END IF;

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

  INSERT INTO exchanges (
    company_id, original_sale_id, customer_id,
    returned_amount, credit_issued, notes, created_by
  )
  VALUES (
    p_company_id, p_sale_id, p_customer_id,
    v_total_credit, v_total_credit, p_notes, p_user_id
  )
  RETURNING id INTO v_exchange_id;

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

    -- Kits (202609231200): troca de N kits inteiros devolve N × composição
    -- congelada da venda ao Estoque Loja — nunca o SKU do kit.
    IF EXISTS (SELECT 1 FROM sale_item_components WHERE sale_item_id = v_sale_item.id) THEN
      PERFORM public._restore_kit_components(
        p_company_id, p_sale_id, v_sale_item.id, 'main_store', v_qty_ret,
        v_main_store_id, 'exchange', p_user_id
      );
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM product_variations pv JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_sale_item.product_variation_id AND p.product_kind = 'kit'
    ) THEN
      RAISE EXCEPTION 'Item de kit #% sem snapshot de componentes — troca bloqueada.', v_sale_item.id
        USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(quantity, 0) INTO v_prev_qty
    FROM stock_balances
    WHERE product_variation_id = v_sale_item.product_variation_id
      AND stock_location_id    = v_main_store_id
    FOR UPDATE;

    INSERT INTO stock_balances (product_variation_id, stock_location_id, quantity, last_updated)
    VALUES (v_sale_item.product_variation_id, v_main_store_id, v_qty_ret, NOW())
    ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
      SET quantity     = stock_balances.quantity + v_qty_ret,
          last_updated = NOW();

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

  INSERT INTO cashback_transactions (
    customer_id, company_id, sale_id,
    type, amount, status, release_date, exchange_id
  )
  VALUES (
    p_customer_id, p_company_id, p_sale_id,
    'earn', v_total_credit, 'available', CURRENT_DATE, v_exchange_id
  );

  -- Fim — troca (parcial ou total) NUNCA altera sales.status/returned_at/
  -- returned_by da venda original. A venda continua com seu status
  -- comercial anterior; exchanges/exchange_items (já gravados acima) são
  -- a única fonte de verdade sobre a troca ter acontecido. Devolução
  -- financeira real permanece exclusiva de rpc_return_sale.

  RETURN jsonb_build_object(
    'exchange_id',   v_exchange_id,
    'credit_amount', v_total_credit
  );
END;
$$;
