-- FASE 4 (ERP → Chatwoot) — reavaliação deliberada da decisão da Fase 2.
--
-- A Fase 2 escolheu "uma linha por evento" em integration_outbox (não uma
-- linha por destino) porque, na época, ZERO consumidor real existia — não
-- dava pra saber quantos destinos um evento teria. Agora existe o primeiro
-- consumidor real (Chatwoot, esta fase) e um segundo já mapeado no
-- roadmap (Meta CAPI, Fase 6). A decisão muda porque a informação mudou,
-- não porque a decisão anterior estava errada — documentado explicitamente
-- porque o pedido da Fase 4 pediu essa justificativa.
--
-- Migration NOVA (não editada a migration da Fase 2,
-- 20260817_integration_foundation_schema.sql, por instrução explícita).
--
-- Semântica de status revisada:
--   integration_outbox.status agora representa só o ciclo de vida do
--   EVENTO em si, não de nenhum destino: 'pending' (ainda não distribuído)
--   → 'dispatched' (fan-out criou as linhas de delivery relevantes) —
--   nunca mais vira 'processed' por um destino específico ter terminado
--   (isso é EXATAMENTE o bug que este redesenho existe pra evitar: marcar
--   o evento global como concluído porque só o Chatwoot processou faria o
--   Meta CAPI, quando existir, nunca mais enxergar esse evento). Os
--   valores 'processing'/'processed'/'failed'/'dead' continuam válidos no
--   CHECK só por compatibilidade com `rpc_claim_outbox_events` (Fase 2,
--   reaproveitada pelo fan-out abaixo — ela ainda marca 'processing'
--   momentaneamente durante o claim) — na prática, depois desta migration,
--   nenhum evento fica parado em 'processing'/'processed'/'failed'/'dead'
--   por muito tempo: ou vira 'dispatched' (sucesso do fan-out) ou 'failed'
--   (falha do fan-out em si, não de um destino).
--
--   integration_event_deliveries.status é quem agora carrega o ciclo de
--   vida REAL por destino: 'pending' → 'processing' → 'processed' |
--   'failed' (retry agendado) → 'dead' (esgotou tentativas). Independente
--   por linha — Chatwoot falhar nunca move nem trava a linha do Meta.

-- ─── 1. ALTER em integration_outbox.status — adiciona 'dispatched' ─────────
-- Busca o nome real da constraint em vez de presumir (mesma robustez já
-- usada nas correções de segurança de RPC das Fases 0/0B) — a Fase 2 não
-- nomeou a constraint explicitamente, então o nome depende de convenção
-- padrão do Postgres que não confirmamos contra o banco real.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.integration_outbox'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%pending%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.integration_outbox DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.integration_outbox
  ADD CONSTRAINT integration_outbox_status_check
  CHECK (status IN ('pending', 'processing', 'dispatched', 'processed', 'failed', 'dead'));

-- =============================================================================
-- 2. integration_event_deliveries
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.integration_event_deliveries (
  id               BIGSERIAL    PRIMARY KEY,
  outbox_event_id  BIGINT       NOT NULL REFERENCES public.integration_outbox(id) ON DELETE CASCADE,
  company_id       INT          NOT NULL REFERENCES public.companies(id), -- redundante com outbox_event_id->company_id, mesmo padrão já usado em toda a Fase 2
  destination      TEXT         NOT NULL
                      CHECK (destination IN ('chatwoot', 'meta', 'n8n')), -- só 'chatwoot' tem consumidor real nesta fase; 'meta'/'n8n' liberados no CHECK porque já fazem parte do modelo (seção 27 do pedido), sem nenhum código consumidor pra eles ainda
  status           TEXT         NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead')),
  attempts         INT          NOT NULL DEFAULT 0,
  available_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  locked_at        TIMESTAMPTZ,
  locked_by        TEXT,
  last_error       TEXT,
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (outbox_event_id, destination) -- idempotência do fan-out (seção 29 do pedido)
);

CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_status_available
  ON public.integration_event_deliveries (destination, status, available_at);
CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_company
  ON public.integration_event_deliveries (company_id);
CREATE INDEX IF NOT EXISTS idx_integration_event_deliveries_outbox_event
  ON public.integration_event_deliveries (outbox_event_id);

-- ─── Claim concorrente por destino (SKIP LOCKED) — mesmo padrão de rpc_claim_outbox_events (Fase 2) ──
CREATE OR REPLACE FUNCTION public.rpc_claim_event_deliveries(
  p_destination text,
  p_limit       int  DEFAULT 10,
  p_worker_id   text DEFAULT 'unknown'
)
RETURNS SETOF public.integration_event_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.integration_event_deliveries
  SET status     = 'processing',
      locked_at  = NOW(),
      locked_by  = p_worker_id,
      attempts   = attempts + 1
  WHERE id IN (
    SELECT id FROM public.integration_event_deliveries
    WHERE destination = p_destination
      AND status = 'pending'
      AND available_at <= NOW()
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_claim_event_deliveries(text, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_claim_event_deliveries(text, int, text) TO service_role;

-- ─── RLS — mesmo padrão deny-by-default da Fase 2 ──────────────────────────
ALTER TABLE public.integration_event_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.integration_event_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integration_event_deliveries TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.integration_event_deliveries_id_seq TO service_role;
