-- =============================================================================
-- 20260811_fix_rpc_identity_grants_tenant.sql
--
-- Auditoria de acesso da role `usuario` (seller) — correção de vulnerabilidade
-- estrutural (Prioridade 1 da correção): RPCs SECURITY DEFINER que aceitam a
-- identidade do usuário (p_user_id / p_system_user_id) como PARÂMETRO comum,
-- em vez de derivá-la de auth.uid(), e que estavam GRANTed para `authenticated`.
--
-- RISCO ENCONTRADO:
--   Todas as funções abaixo são SECURITY DEFINER (bypassam RLS) e recebem a
--   identidade do executor como parâmetro comum, sem checar auth.uid(). Como
--   estavam GRANT EXECUTE ... TO authenticated, qualquer usuário logado podia,
--   em tese, chamar a RPC diretamente via `supabase.rpc(...)` do navegador
--   (sem passar pela API Next.js) informando o UUID de outro usuário
--   (ex.: um gerente/admin) e herdar o role/empresa dele para aquela chamada,
--   contornando totalmente o requireRole() da API.
--
-- POR QUE NÃO REESCREVEMOS PARA auth.uid() AQUI:
--   Todas essas RPCs são chamadas EXCLUSIVAMENTE pelo backend (Next.js API
--   routes / services) usando o client admin (service_role) — nunca por
--   código client-side (`grep -rn ".rpc(" src` confirma). Sob o service_role,
--   auth.uid() é sempre NULL (a service_role key não carrega um `sub` de
--   usuário), então adicionar `p_user_id = auth.uid()` quebraria 100% das
--   chamadas legítimas atuais. O padrão correto (auth.uid()) já existe no
--   código para RPCs chamadas via client de SESSÃO — ver
--   rpc_regularizar_despesa_caixa (20260719) — mas migrar estas RPCs para
--   esse padrão exige trocar o client de chamada (admin → sessão) em vários
--   arquivos de serviço, uma mudança arquitetural maior que fica documentada
--   como pendência separada (ver relatório de entrega, item "não corrigido").
--
-- CORREÇÃO APLICADA AQUI (2 partes):
--
--   1. REVOKE EXECUTE ... FROM authenticated nas RPCs que só são chamadas
--      server-side. Isso fecha o vetor de chamada direta pelo navegador sem
--      alterar nenhum comportamento legítimo — o app continua funcionando
--      100% igual, pois sempre usou service_role para essas chamadas. Mesmo
--      padrão já usado em rpc_import_products_batch e fn_verify_user_password.
--
--   2. Validação de tenant dentro da própria função (defense-in-depth) nas
--      RPCs que manipulavam um registro por ID sem checar se ele pertence à
--      empresa do usuário que a está chamando:
--        - rpc_cancel_sale / rpc_return_sale: não validavam company_id da
--          venda contra a empresa do usuário (o check hoje só existe na
--          camada de serviço, cancelSale()/returnSale() em vendas.service.ts
--          — fica reforçado aqui também dentro do banco).
--        - rpc_stock_entry / rpc_stock_adjust: derivavam company_id do
--          PRODUTO sendo manipulado, sem checar se esse produto pertence à
--          empresa do usuário que fez a chamada — nenhuma camada checava
--          isso antes.
--      As demais RPCs da família (rpc_create_sale, rpc_process_exchange,
--      rpc_close_cash_session, rpc_add_cash_movement) já validam tenant
--      corretamente e não foram alteradas nesta parte.
--
-- NÃO ALTERADO: nenhuma lógica de negócio, cálculo, coluna ou comportamento
--   de sucesso existente. Todas as chamadas legítimas (via service_role, para
--   registros da própria empresa) continuam funcionando exatamente igual.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. rpc_cancel_sale — + validação de tenant
-- Base: 20260722_rpc_cancel_return_sale_no_finance_entry.sql
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
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. rpc_return_sale — + validação de tenant
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
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. rpc_stock_entry — + validação de tenant (produto vs. empresa do chamador)
-- Base: 20260615_fix_rpc_stock_entry_total_lot_cost.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_entry(
  p_product_variation_id int,
  p_supplier_id          int,
  p_entry_type           text,
  p_quantity_original    int,
  p_unit_cost            numeric,
  p_freight_cost         numeric,
  p_tax_cost             numeric,
  p_entry_date           date,
  p_notes                text,
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja da empresa
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_lot_cost  numeric;
  v_cost_per_unit   numeric;
  v_lot_id          int;
  v_prev_qty        numeric := 0;
  v_prev_avg_cost   numeric := 0;
  v_new_qty         numeric;
  v_new_avg_cost    numeric;
  v_company_id      int;
  v_location_id     int;
  v_caller_company  int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  -- ─── Validação de tenant (novo) ─────────────────────────────────────────────
  -- Antes desta correção, v_company_id vinha só do produto, sem checar se o
  -- produto pertence à empresa de quem está chamando a RPC.
  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Produto não pertence à empresa do usuário.' USING ERRCODE = 'P0001';
  END IF;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  v_total_lot_cost := p_unit_cost * p_quantity_original
    + COALESCE(p_freight_cost, 0)
    + COALESCE(p_tax_cost, 0);
  v_cost_per_unit  := v_total_lot_cost / p_quantity_original;

  -- Lote (imutável, sem FK para location — rastreabilidade por nota fiscal)
  INSERT INTO stock_lots (
    product_variation_id, supplier_id, entry_type,
    quantity_original, quantity_remaining,
    unit_cost, freight_cost, tax_cost,
    total_lot_cost, cost_per_unit,
    entry_date, notes, created_by
  )
  VALUES (
    p_product_variation_id, p_supplier_id, p_entry_type::stock_entry_type,
    p_quantity_original, p_quantity_original,
    p_unit_cost, COALESCE(p_freight_cost, 0), COALESCE(p_tax_cost, 0),
    ROUND(v_total_lot_cost, 2), ROUND(v_cost_per_unit, 6),
    p_entry_date, p_notes, p_system_user_id
  )
  RETURNING id INTO v_lot_id;

  -- Saldo anterior no local escolhido (lock para concorrência)
  SELECT quantity, avg_cost INTO v_prev_qty, v_prev_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = v_location_id
  FOR UPDATE;

  IF v_prev_qty      IS NULL THEN v_prev_qty      := 0; END IF;
  IF v_prev_avg_cost IS NULL THEN v_prev_avg_cost := 0; END IF;

  v_new_qty := v_prev_qty + p_quantity_original;
  v_new_avg_cost := CASE
    WHEN v_new_qty > 0
      THEN (v_prev_qty * v_prev_avg_cost + p_quantity_original * v_cost_per_unit) / v_new_qty
    ELSE v_cost_per_unit
  END;

  -- Upsert em stock_balances (fonte de verdade)
  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (
    p_product_variation_id, v_location_id,
    v_new_qty, ROUND(v_new_avg_cost, 6), NOW()
  )
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = v_new_qty,
        avg_cost     = ROUND(v_new_avg_cost, 6),
        last_updated = NOW();

  -- Ledger
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    destination_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    'entry', p_quantity_original,
    v_prev_qty::int, v_new_qty::int,
    v_cost_per_unit, v_lot_id::text, v_company_id,
    v_location_id, 'entry', 'lot',
    p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  -- Finance entry (compra de estoque)
  INSERT INTO finance_entries (
    type, category, description, amount, reference_date, stock_lot_id, created_by, company_id
  )
  VALUES (
    'expense', 'stock_purchase',
    'Entrada de estoque — Lote #' || v_lot_id::text,
    ROUND(v_total_lot_cost, 2), p_entry_date, v_lot_id, p_system_user_id, v_company_id
  );

  RETURN jsonb_build_object(
    'lot_id',          v_lot_id,
    'new_quantity',    v_new_qty,
    'new_avg_cost',    ROUND(v_new_avg_cost, 6),
    'total_lot_cost',  ROUND(v_total_lot_cost, 2),
    'cost_per_unit',   ROUND(v_cost_per_unit, 6),
    'location_id',     v_location_id
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. rpc_stock_adjust — + validação de tenant (produto vs. empresa do chamador)
-- Base: 20260610_multi_estoque.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_stock_adjust(
  p_product_variation_id int,
  p_delta                int,
  p_reason               text,
  p_notes                text,
  p_system_user_id       uuid,
  p_stock_location_id    int  DEFAULT NULL  -- NULL = Estoque Loja
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty      int     := 0;
  v_current_avg_cost numeric := 0;
  v_new_qty          int;
  v_company_id       int;
  v_location_id      int;
  v_caller_company   int;
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT p.company_id INTO v_company_id
  FROM product_variations pv
  JOIN products p ON p.id = pv.product_id
  WHERE pv.id = p_product_variation_id;

  -- ─── Validação de tenant (novo) ─────────────────────────────────────────────
  SELECT company_id INTO v_caller_company FROM users WHERE id = p_system_user_id;
  IF v_caller_company IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a uma empresa.' USING ERRCODE = 'P0001';
  END IF;
  IF v_company_id IS DISTINCT FROM v_caller_company THEN
    RAISE EXCEPTION 'Produto não pertence à empresa do usuário.' USING ERRCODE = 'P0001';
  END IF;

  v_location_id := COALESCE(
    p_stock_location_id,
    public.fn_main_store_id(v_company_id)
  );

  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Estoque Loja não configurado para esta empresa.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM stock_locations
    WHERE id = v_location_id AND company_id = v_company_id AND active = true
  ) THEN
    RAISE EXCEPTION 'Local de estoque #% inválido ou inativo.', v_location_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Lock na linha de saldo
  SELECT quantity, avg_cost INTO v_current_qty, v_current_avg_cost
  FROM stock_balances
  WHERE product_variation_id = p_product_variation_id
    AND stock_location_id    = v_location_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente em "%". Atual: %, ajuste: %.',
      (SELECT name FROM stock_locations WHERE id = v_location_id),
      v_current_qty, p_delta USING ERRCODE = 'P0001';
  END IF;

  -- Upsert stock_balances
  INSERT INTO stock_balances (
    product_variation_id, stock_location_id, quantity, avg_cost, last_updated
  )
  VALUES (p_product_variation_id, v_location_id, v_new_qty, v_current_avg_cost, NOW())
  ON CONFLICT (product_variation_id, stock_location_id) DO UPDATE
    SET quantity     = v_new_qty,
        last_updated = NOW();

  -- Ledger
  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id,
    source_location_id, movement_type, reference_type, notes, created_by
  )
  SELECT
    p_product_variation_id, pv.product_id,
    'adjust', p_delta,
    v_current_qty, v_new_qty,
    v_current_avg_cost, p_reason, v_company_id,
    v_location_id, 'adjustment', 'manual',
    p_notes, p_system_user_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta,
    'location_id',       v_location_id
  );
END;
$$;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. GRANT EXECUTE — revogar `authenticated`, manter apenas `service_role`
--
-- Todas as funções abaixo são chamadas EXCLUSIVAMENTE pelo backend via
-- createAdminClient() (service_role). Nenhum código client-side as chama
-- (confirmado por grep em todo src/). Revogar `authenticated` fecha o vetor
-- de chamada direta pelo navegador com fabricação de identidade, sem
-- nenhuma mudança de comportamento para o app.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_cancel_sale(int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_cancel_sale(int, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_return_sale(int, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_return_sale(int, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_process_exchange(int, int, int, jsonb, text, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_process_exchange(int, int, int, jsonb, text, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_open_cash_session(uuid, numeric, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_open_cash_session(uuid, numeric, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_add_cash_movement(bigint, uuid, text, numeric, text, text, bigint, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_add_cash_movement(bigint, uuid, text, numeric, text, text, bigint, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_close_cash_session(bigint, uuid, numeric, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_cancel_cash_movement(bigint, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_cancel_cash_movement(bigint, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_reopen_cash_session(bigint, uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_reopen_cash_session(bigint, uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_stock_entry(int, int, text, int, numeric, numeric, numeric, date, text, uuid, int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_stock_entry(int, int, text, int, numeric, numeric, numeric, date, text, uuid, int) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_stock_adjust(int, int, text, text, uuid, int) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_stock_adjust(int, int, text, text, uuid, int) TO service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_pagar_repasse_lote(int[], uuid, boolean) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_pagar_repasse_lote(int[], uuid, boolean) TO service_role;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
/*
-- Para reverter os GRANTs (não recomendado — reabre a vulnerabilidade):
--   GRANT EXECUTE ON FUNCTION public.rpc_create_sale(...) TO authenticated;
--   (repetir para cada função acima)
--
-- Para reverter a validação de tenant em rpc_cancel_sale/rpc_return_sale/
-- rpc_stock_entry/rpc_stock_adjust, reaplique as versões anteriores:
--   rpc_cancel_sale/rpc_return_sale: 20260722_rpc_cancel_return_sale_no_finance_entry.sql
--   rpc_stock_entry: 20260615_fix_rpc_stock_entry_total_lot_cost.sql
--   rpc_stock_adjust: 20260610_multi_estoque.sql
-- Não há rollback de dados: esta migration não altera nenhuma linha
-- existente, só valida chamadas futuras.
*/
-- =============================================================================
-- FIM DA MIGRATION 20260811 (Prioridade 1)
-- =============================================================================
