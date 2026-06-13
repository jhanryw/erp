-- =============================================================================
-- 20260613_rpc_pagar_repasse.sql
--
-- DEPENDÊNCIA: executar APÓS 20260613_shipping_fiscal_ready.sql
--
-- PARTE 0 — courier_phone em shipments (campo solicitado junto ao PATCH estendido)
-- =============================================================================

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS courier_phone TEXT;

COMMENT ON COLUMN public.shipments.courier_phone IS
  'Telefone/WhatsApp do motoboy atribuído a este envio.';

-- =============================================================================
-- DEPENDÊNCIA: executar APÓS 20260613_shipping_fiscal_ready.sql
--
-- Cria rpc_pagar_repasse_motoboy — executa o repasse ao motoboy de forma
-- atômica e idempotente:
--   1. Tranca a linha em shipments (FOR UPDATE) para evitar race condition
--   2. Valida todas as regras de negócio dentro da transação
--   3. Insere finance_entries(expense, freight_cost)
--   4. Atualiza shipments (repasse_status, repasse_paid_at, repasse_finance_entry_id)
--
-- Garantia de idempotência:
--   - Se repasse_finance_entry_id já existir → RAISE EXCEPTION (duplicata bloqueada)
--   - Se repasse_status = 'paid' → RAISE EXCEPTION
--   - O FOR UPDATE garante que duas requisições simultâneas não criam duas entradas
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_pagar_repasse_motoboy(
  p_shipment_id    int,
  p_system_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_shipment        record;
  v_sale_number     text;
  v_company_id      int;
  v_repasse_amount  numeric;
  v_finance_id      int;
  v_today           date;
BEGIN
  v_today := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  -- ─── Empresa do usuário (cross-tenant guard) ──────────────────────────────────
  SELECT company_id INTO v_company_id
  FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Lock pessimista + leitura ────────────────────────────────────────────────
  SELECT *
  INTO v_shipment
  FROM shipments
  WHERE id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Envio #% não encontrado.', p_shipment_id USING ERRCODE = 'P0001';
  END IF;

  -- ─── Cross-tenant ─────────────────────────────────────────────────────────────
  IF v_shipment.company_id IS DISTINCT FROM v_company_id THEN
    RAISE EXCEPTION 'Acesso negado.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Regras de negócio ───────────────────────────────────────────────────────

  IF v_shipment.status = 'cancelado' THEN
    RAISE EXCEPTION 'Envio cancelado não pode ter repasse pago.' USING ERRCODE = 'P0001';
  END IF;

  IF v_shipment.repasse_status = 'not_applicable' THEN
    RAISE EXCEPTION 'Retirada (pickup) não tem repasse ao motoboy.' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotência primária: coluna FK
  IF v_shipment.repasse_finance_entry_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Repasse já lançado (finance_entry #%). Não é possível duplicar.',
      v_shipment.repasse_finance_entry_id USING ERRCODE = 'P0001';
  END IF;

  -- Idempotência secundária: status
  IF v_shipment.repasse_status = 'paid' THEN
    RAISE EXCEPTION
      'Repasse já marcado como pago em %.',
      v_shipment.repasse_paid_at USING ERRCODE = 'P0001';
  END IF;

  IF v_shipment.repasse_status <> 'pending' THEN
    RAISE EXCEPTION
      'Status de repasse inválido: %. Esperado: pending.',
      v_shipment.repasse_status USING ERRCODE = 'P0001';
  END IF;

  -- ─── Valor do repasse ─────────────────────────────────────────────────────────
  -- Prioridade: custo real > repasse_amount já preenchido > estimativa da regra
  v_repasse_amount := COALESCE(
    v_shipment.internal_cost_real,
    v_shipment.repasse_amount,
    v_shipment.internal_cost
  );

  IF v_repasse_amount IS NULL OR v_repasse_amount <= 0 THEN
    RAISE EXCEPTION
      'Valor do repasse inválido (%). Confirme o custo do frete antes de pagar.',
      v_repasse_amount USING ERRCODE = 'P0001';
  END IF;

  -- ─── sale_number para descrição ───────────────────────────────────────────────
  SELECT sale_number INTO v_sale_number
  FROM sales WHERE id = v_shipment.order_id;

  -- ─── INSERT finance_entries ───────────────────────────────────────────────────
  INSERT INTO finance_entries (
    type, category, description,
    amount, reference_date,
    sale_id, created_by, company_id
  )
  VALUES (
    'expense',
    'freight_cost',
    'Repasse motoboy — Venda ' || COALESCE(v_sale_number, v_shipment.order_id::text),
    v_repasse_amount,
    v_today,
    v_shipment.order_id,
    p_system_user_id,
    v_company_id
  )
  RETURNING id INTO v_finance_id;

  -- ─── UPDATE shipments ─────────────────────────────────────────────────────────
  UPDATE shipments
  SET
    repasse_status           = 'paid',
    repasse_paid_at          = NOW(),
    repasse_finance_entry_id = v_finance_id,
    repasse_amount           = v_repasse_amount,
    updated_at               = NOW()
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'shipment_id',        p_shipment_id,
    'finance_entry_id',   v_finance_id,
    'repasse_amount',     v_repasse_amount,
    'sale_number',        v_sale_number,
    'repasse_paid_at',    NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_pagar_repasse_motoboy(int, uuid)
  TO service_role, authenticated;
