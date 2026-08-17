-- FASE N2B — Idempotência + auditoria de mensagens enviadas por automação
-- (POST /api/automations/chatwoot/send).
--
-- Por que uma tabela nova em vez de reaproveitar `post_sale_automation_events`
-- (seção 14 do pedido — reuso só quando semanticamente correto, justificar
-- antes de criar):
--   post_sale_automation_events é amarrada ao fluxo de pós-venda v2
--   especificamente: `event_type` é um CHECK fechado com valores só desse
--   domínio ('cashback_message_sent', 'csat_sent', 'expiry_reminder_sent',
--   'webhook_received'...), e não tem `idempotency_key` (não precisava —
--   sua própria idempotência já vem de `uq_post_sale_webhook_received`,
--   único cenário que precisava disso ali). Forçar `/send` a usar essa
--   tabela exigiria (a) alargar o CHECK de event_type com um valor genérico
--   que não descreve nenhuma etapa real do pós-venda v2, OU (b) adicionar
--   idempotency_key/channel/external_message_id como colunas nullable
--   irrelevantes pra 100% das linhas pós-venda existentes — as duas opções
--   conflitam semânticas de domínios diferentes na mesma tabela. Uma tabela
--   pequena e dedicada é mais simples e mais correta.
--
-- Padrão de idempotência (mesmo espírito de `rpc_claim_outbox_events` —
-- "claim antes de processar", não "check então act"): o endpoint faz
-- INSERT com result='pending' ANTES de chamar o Chatwoot. Se já existe uma
-- linha com o mesmo (company_id, idempotency_key) e result='sent', o
-- endpoint nunca reenvia — devolve o resultado já registrado. Se a linha
-- existente está 'failed', permite nova tentativa (reaproveita a mesma
-- linha). Isso fecha a janela de corrida que um simples "SELECT antes,
-- INSERT depois" deixaria aberta sob retries concorrentes do n8n.

CREATE TABLE IF NOT EXISTS public.automation_message_log (
  id                  BIGSERIAL    PRIMARY KEY,
  company_id          INT          NOT NULL REFERENCES public.companies(id),
  automation_name     TEXT         NOT NULL,
  customer_id         INT          NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  sale_id             INT          REFERENCES public.sales(id) ON DELETE SET NULL,
  idempotency_key     TEXT,
  channel             TEXT         NOT NULL DEFAULT 'chatwoot' CHECK (channel = 'chatwoot'), -- só Chatwoot nesta fase (seção 1 do pedido N2B); ampliar o CHECK quando um segundo canal existir de verdade
  result              TEXT         NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'sent', 'failed', 'duplicate')),
  conversation_id     TEXT,
  external_message_id TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_message_log_company
  ON public.automation_message_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_message_log_customer
  ON public.automation_message_log (customer_id, created_at DESC);

-- Chave da idempotência: no máximo 1 linha por (company_id, idempotency_key)
-- quando informada — regardless de status, é isso que faz o segundo INSERT
-- concorrente falhar com 23505 e ser tratado como "já reivindicado" pelo
-- service layer (claimIdempotencyKey).
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_message_log_idempotency
  ON public.automation_message_log (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- RLS — mesmo padrão deny-by-default de integration_event_deliveries (Fase
-- 4): tabela só de automação/auditoria técnica, sem tela de UI que precise
-- ler via `authenticated` hoje.
ALTER TABLE public.automation_message_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.automation_message_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.automation_message_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.automation_message_log_id_seq TO service_role;
