-- =============================================================================
-- 20260704_post_sale_automation_events.sql
--
-- Tabela de eventos do fluxo de pós-venda v2 (N8N → ERP).
-- Separada de webhook_log (que rastreia o disparo ERP → N8N).
--
-- Cada linha representa uma ação no fluxo: mensagem enviada, etapa pulada,
-- erro, etc. O N8N registra cada passo; o ERP audita e controla idempotência.
--
-- Campos:
--   created_at — sempre preenchido (quando o evento foi registrado)
--   sent_at    — só preenchido para eventos de mensagem enviada
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.post_sale_automation_events (
  id               BIGSERIAL    PRIMARY KEY,
  sale_id          INT          REFERENCES public.sales(id) ON DELETE SET NULL,
  customer_id      INT          REFERENCES public.customers(id) ON DELETE SET NULL,
  company_id       INT          NOT NULL REFERENCES public.companies(id),
  event_type       TEXT         NOT NULL
                   CHECK (event_type IN (
                     'webhook_received',
                     'cashback_message_sent',
                     'csat_sent',
                     'expiry_reminder_sent',
                     'skipped_cashback_message',
                     'skipped_csat',
                     'skipped_expiry_reminder',
                     'flow_ended_no_expiry',
                     'error'
                   )),
  skip_reason      TEXT,
  n8n_execution_id TEXT,
  message          TEXT,
  context_snapshot JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ  NULL
);

-- Índices de consulta
CREATE INDEX IF NOT EXISTS idx_post_sale_events_sale
  ON public.post_sale_automation_events (sale_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_post_sale_events_company
  ON public.post_sale_automation_events (company_id, created_at DESC);

-- Idempotência: impede dois webhook_received para a mesma venda
CREATE UNIQUE INDEX IF NOT EXISTS uq_post_sale_webhook_received
  ON public.post_sale_automation_events (sale_id, event_type)
  WHERE event_type = 'webhook_received';

-- RLS
ALTER TABLE public.post_sale_automation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "post_sale_events_company" ON public.post_sale_automation_events;
CREATE POLICY "post_sale_events_company" ON public.post_sale_automation_events
  FOR SELECT TO authenticated
  USING (company_id = (
    SELECT company_id FROM public.users WHERE id = auth.uid()
  ));

GRANT SELECT ON public.post_sale_automation_events TO authenticated;
GRANT ALL    ON public.post_sale_automation_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.post_sale_automation_events_id_seq TO service_role;
