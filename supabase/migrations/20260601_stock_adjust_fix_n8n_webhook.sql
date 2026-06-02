-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  20260601 — ajuste de estoque sem impacto financeiro + webhook log n8n      ║
-- ║  Idempotente: pode rodar mais de uma vez sem efeito colateral               ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ─── 1. Corrigir rpc_stock_adjust ─────────────────────────────────────────────
--  Removido: INSERT INTO finance_entries quando delta < 0.
--  Ajuste de estoque corrige apenas quantidade física; sem impacto financeiro.

CREATE OR REPLACE FUNCTION public.rpc_stock_adjust(
  p_product_variation_id int,
  p_delta                int,
  p_reason               text,
  p_notes                text,
  p_system_user_id       uuid
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
BEGIN
  PERFORM set_config('app.stock_rpc', '1', true);

  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Delta não pode ser zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.quantity, s.avg_cost, s.company_id
  INTO v_current_qty, v_current_avg_cost, v_company_id
  FROM stock s WHERE product_variation_id = p_product_variation_id
  FOR UPDATE;

  IF v_current_qty      IS NULL THEN v_current_qty      := 0; END IF;
  IF v_current_avg_cost IS NULL THEN v_current_avg_cost := 0; END IF;

  v_new_qty := v_current_qty + p_delta;

  IF v_new_qty < 0 THEN
    RAISE EXCEPTION 'Estoque insuficiente. Atual: %, ajuste: %.',
      v_current_qty, p_delta USING ERRCODE = 'P0001';
  END IF;

  UPDATE stock SET quantity = v_new_qty, last_updated = NOW()
  WHERE product_variation_id = p_product_variation_id;

  INSERT INTO stock_movements (
    product_variation_id, product_id, type, quantity,
    previous_stock, new_stock, unit_cost, reference_id, company_id
  )
  SELECT p_product_variation_id, pv.product_id, 'adjust', p_delta,
         v_current_qty, v_new_qty,
         v_current_avg_cost, p_reason, v_company_id
  FROM product_variations pv WHERE pv.id = p_product_variation_id;

  RETURN jsonb_build_object(
    'new_quantity',      v_new_qty,
    'previous_quantity', v_current_qty,
    'delta',             p_delta
  );
END;
$$;

-- ─── 2. Remover finance_entries antigas geradas por ajuste de estoque ──────────
--  Identificadas com segurança pela combinação:
--    description LIKE 'Ajuste de estoque (%'
--    category = 'other_expense'
--    sale_id IS NULL  (ajuste nunca gera venda)
--    stock_lot_id IS NULL  (ajuste nunca gera lote)
--  Essas entradas são incorretas e podem ser deletadas com segurança.

DELETE FROM public.finance_entries
WHERE category    = 'other_expense'
  AND sale_id     IS NULL
  AND stock_lot_id IS NULL
  AND description  LIKE 'Ajuste de estoque (%';

-- ─── 3. Criar tabela webhook_log ───────────────────────────────────────────────
--  Rastreia webhooks enviados ao n8n (e outros destinos futuros).
--  O índice único previne envio duplicado por venda+evento.

CREATE TABLE IF NOT EXISTS public.webhook_log (
  id            BIGSERIAL         PRIMARY KEY,
  event_type    TEXT              NOT NULL,
  sale_id       INT               REFERENCES public.sales(id) ON DELETE SET NULL,
  company_id    INT               REFERENCES public.companies(id),
  payload       JSONB             NOT NULL,
  webhook_url   TEXT              NOT NULL,
  status        TEXT              NOT NULL DEFAULT 'sent'
                                  CHECK (status IN ('sent', 'failed')),
  http_status   INT,
  error_message TEXT,
  sent_at       TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Índice de idempotência: impede dois registros 'sent' para a mesma venda+evento
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_log_sale_event_sent
  ON public.webhook_log (sale_id, event_type)
  WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS idx_webhook_log_company_sent
  ON public.webhook_log (company_id, sent_at DESC);

-- RLS: mesma política de company_id do restante do schema
ALTER TABLE public.webhook_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_log_company" ON public.webhook_log;
CREATE POLICY "webhook_log_company" ON public.webhook_log
  FOR SELECT TO authenticated
  USING (company_id = (
    SELECT company_id FROM public.users WHERE id = auth.uid()
  ));

GRANT SELECT ON public.webhook_log TO authenticated;
GRANT ALL    ON public.webhook_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.webhook_log_id_seq TO service_role;
