-- =============================================================================
-- 20260613_rpc_pagar_repasse_lote.sql
--
-- DEPENDÊNCIA: executar APÓS 20260613_rpc_pagar_repasse.sql
--
-- PARTE 1 — Tabela repasse_batches
--   Agrupa repasses pagos no mesmo fechamento de período.
--   Cada chamada ao RPC lote cria 1 batch com N finance_entries + N shipments.
--
-- PARTE 2 — repasse_batch_id em shipments
--   Liga cada envio ao seu lote de fechamento.
--   NULL = pago individualmente (via rpc_pagar_repasse_motoboy).
--
-- PARTE 3 — rpc_pagar_repasse_lote
--   Valida todos → detecta sem motoboy → cria batch → cria N finance_entries
--   → atualiza N shipments. Rollback total se qualquer validação falhar.
--
-- LÓGICA DE CONFIRMAÇÃO DE MOTOBOY AUSENTE:
--   A função NÃO usa RAISE EXCEPTION para o caso "sem motoboy".
--   Retorna JSON { needs_confirmation: true, shipments_without_motoboy: [...] }.
--   O endpoint detecta isso, devolve 409, o frontend pede confirmação ao usuário
--   e chama novamente com p_force_no_motoboy = true.
--   Dessa forma não há rollback desnecessário na primeira chamada.
-- =============================================================================


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1 — Tabela repasse_batches
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.repasse_batches (
  id              serial        PRIMARY KEY,
  company_id      int           NOT NULL REFERENCES public.companies(id),
  total_amount    numeric(10,2) NOT NULL,
  shipment_count  int           NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT NOW(),
  created_by      uuid          REFERENCES public.users(id),
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_repasse_batches_company
  ON public.repasse_batches(company_id, created_at DESC);

COMMENT ON TABLE public.repasse_batches IS
  'Cada linha representa um fechamento de repasse ao motoboy (pagar vários de uma vez).';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2 — repasse_batch_id em shipments
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS repasse_batch_id int REFERENCES public.repasse_batches(id);

COMMENT ON COLUMN public.shipments.repasse_batch_id IS
  'Lote de fechamento ao qual este repasse pertence. NULL = pago individualmente.';


-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 3 — rpc_pagar_repasse_lote
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.rpc_pagar_repasse_lote(
  p_shipment_ids     int[],
  p_system_user_id   uuid,
  p_force_no_motoboy boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id       int;
  v_today            date;
  v_batch_id         int;
  v_total_amount     numeric  := 0;
  v_count            int      := 0;
  v_no_motoboy_ids   int[]    := ARRAY[]::int[];
  v_shipment         record;
  v_repasse_amt      numeric;
  v_sale_number      text;
  v_finance_id       int;
  v_entries          jsonb    := '[]'::jsonb;
BEGIN
  IF p_shipment_ids IS NULL OR array_length(p_shipment_ids, 1) = 0 THEN
    RAISE EXCEPTION 'Nenhum envio selecionado.' USING ERRCODE = 'P0001';
  END IF;

  v_today := (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;

  -- ─── Empresa do usuário ───────────────────────────────────────────────────────
  SELECT company_id INTO v_company_id
  FROM users WHERE id = p_system_user_id;

  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Usuário não associado a empresa.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Fase 1: validar + travar todos (ordem determinística anti-deadlock) ──────
  FOR v_shipment IN
    SELECT *
    FROM shipments
    WHERE id = ANY(p_shipment_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    v_count := v_count + 1;

    -- Cross-tenant
    IF v_shipment.company_id IS DISTINCT FROM v_company_id THEN
      RAISE EXCEPTION 'Envio #% não pertence à empresa.', v_shipment.id
        USING ERRCODE = 'P0001';
    END IF;

    -- Somente delivery
    IF v_shipment.delivery_mode <> 'delivery' THEN
      RAISE EXCEPTION 'Envio #% é retirada (pickup) — sem repasse ao motoboy.', v_shipment.id
        USING ERRCODE = 'P0001';
    END IF;

    -- Somente pending (idempotência dura)
    IF v_shipment.repasse_status <> 'pending' THEN
      RAISE EXCEPTION 'Envio #% tem repasse_status = %. Esperado: pending.', v_shipment.id, v_shipment.repasse_status
        USING ERRCODE = 'P0001';
    END IF;

    -- Sem finance_entry já lançado (dupla guarda)
    IF v_shipment.repasse_finance_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Envio #% já tem lançamento financeiro #%. Não é possível duplicar.',
        v_shipment.id, v_shipment.repasse_finance_entry_id
        USING ERRCODE = 'P0001';
    END IF;

    -- Valor do repasse (prioridade: real > manual > estimado)
    v_repasse_amt := COALESCE(
      v_shipment.internal_cost_real,
      v_shipment.repasse_amount,
      v_shipment.internal_cost
    );

    IF v_repasse_amt IS NULL OR v_repasse_amt <= 0 THEN
      RAISE EXCEPTION 'Envio #% sem valor de repasse válido. Informe o custo antes de fechar.',
        v_shipment.id USING ERRCODE = 'P0001';
    END IF;

    -- Coleta sem motoboy (soft check — só bloqueia se não confirmado)
    IF v_shipment.motoboy IS NULL OR TRIM(v_shipment.motoboy) = '' THEN
      v_no_motoboy_ids := array_append(v_no_motoboy_ids, v_shipment.id);
    END IF;

    v_total_amount := v_total_amount + v_repasse_amt;
  END LOOP;

  -- Garante que todos os IDs enviados existem e pertencem à empresa
  IF v_count <> array_length(p_shipment_ids, 1) THEN
    RAISE EXCEPTION 'Um ou mais envios não foram encontrados.' USING ERRCODE = 'P0001';
  END IF;

  -- ─── Confirmação de motoboy ausente (retorno suave, SEM rollback) ─────────────
  IF array_length(v_no_motoboy_ids, 1) > 0 AND NOT p_force_no_motoboy THEN
    RETURN jsonb_build_object(
      'needs_confirmation',        true,
      'shipments_without_motoboy', to_jsonb(v_no_motoboy_ids),
      'count_without_motoboy',     array_length(v_no_motoboy_ids, 1),
      'message',                   format(
        '%s entrega(s) sem motoboy informado. Confirme para prosseguir mesmo assim.',
        array_length(v_no_motoboy_ids, 1)
      )
    );
  END IF;

  -- ─── Fase 2: criar batch ──────────────────────────────────────────────────────
  INSERT INTO repasse_batches (company_id, total_amount, shipment_count, created_by)
  VALUES (v_company_id, ROUND(v_total_amount, 2), v_count, p_system_user_id)
  RETURNING id INTO v_batch_id;

  -- ─── Fase 3: processar cada envio (linhas já travadas na fase 1) ──────────────
  FOR v_shipment IN
    SELECT *
    FROM shipments
    WHERE id = ANY(p_shipment_ids)
    ORDER BY id
  LOOP
    v_repasse_amt := COALESCE(
      v_shipment.internal_cost_real,
      v_shipment.repasse_amount,
      v_shipment.internal_cost
    );

    -- sale_number para descrição legível
    SELECT sale_number INTO v_sale_number
    FROM sales WHERE id = v_shipment.order_id;

    INSERT INTO finance_entries (
      type, category, description,
      amount, reference_date,
      sale_id, created_by, company_id
    )
    VALUES (
      'expense',
      'freight_cost',
      'Repasse motoboy — Venda '
        || COALESCE(v_sale_number, '#' || v_shipment.order_id::text)
        || CASE
             WHEN v_shipment.motoboy IS NOT NULL AND TRIM(v_shipment.motoboy) <> ''
             THEN ' (' || v_shipment.motoboy || ')'
             ELSE ''
           END,
      v_repasse_amt,
      v_today,
      v_shipment.order_id,
      p_system_user_id,
      v_company_id
    )
    RETURNING id INTO v_finance_id;

    UPDATE shipments
    SET
      repasse_status           = 'paid',
      repasse_paid_at          = NOW(),
      repasse_finance_entry_id = v_finance_id,
      repasse_amount           = v_repasse_amt,
      repasse_batch_id         = v_batch_id,
      updated_at               = NOW()
    WHERE id = v_shipment.id;

    v_entries := v_entries || jsonb_build_object(
      'shipment_id',      v_shipment.id,
      'finance_entry_id', v_finance_id,
      'amount',           v_repasse_amt,
      'sale_number',      v_sale_number,
      'motoboy',          v_shipment.motoboy
    );
  END LOOP;

  RETURN jsonb_build_object(
    'needs_confirmation', false,
    'batch_id',           v_batch_id,
    'total_amount',       ROUND(v_total_amount, 2),
    'shipment_count',     v_count,
    'entries',            v_entries
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_pagar_repasse_lote(int[], uuid, boolean)
  TO service_role, authenticated;


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- =============================================================================
/*
DROP FUNCTION  IF EXISTS public.rpc_pagar_repasse_lote(int[], uuid, boolean);
ALTER TABLE public.shipments DROP COLUMN IF EXISTS repasse_batch_id;
DROP TABLE  IF EXISTS public.repasse_batches CASCADE;
*/
