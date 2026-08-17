-- =============================================================================
-- integration_event_deliveries_dead_requeue.test.sql
--
-- Fase 5 (seções 20-21 do pedido) — confirma o estado que uma delivery
-- `dead` alcança (esgotou DELIVERY_MAX_ATTEMPTS=5) e a semântica de
-- requeueDelivery() (src/services/integrations/deliveries.service.ts):
-- por padrão PRESERVA `attempts`, só zera com resetAttempts=true.
--
-- Este teste simula em SQL puro exatamente as transições que
-- markDeliveryFailed()/requeueDelivery() fazem em TypeScript — não chama a
-- função TS (não é uma RPC), então é uma prova de que o SCHEMA permite e se
-- comporta como o service espera, não um teste do código TS em si (esse já
-- está coberto por deliveries.service.test.ts via computeNextAvailableAt).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/integration_event_deliveries_dead_requeue.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_outbox_id  bigint;
  v_delivery_id bigint;
  v_count      int;
BEGIN
  INSERT INTO public.integration_outbox (company_id, event_id, event_type, aggregate_type, aggregate_id, payload, status)
  VALUES (1, 'teste:dead-requeue:1', 'sale.completed', 'sale', '999005', '{}'::jsonb, 'dispatched')
  RETURNING id INTO v_outbox_id;

  -- Simula uma delivery que já esgotou as 5 tentativas (mesma semântica de
  -- markDeliveryFailed quando attempts >= DELIVERY_MAX_ATTEMPTS).
  INSERT INTO public.integration_event_deliveries (outbox_event_id, company_id, destination, status, attempts, last_error)
  VALUES (v_outbox_id, 1, 'chatwoot', 'dead', 5, 'Chatwoot respondeu 500 (5x)')
  RETURNING id INTO v_delivery_id;

  -- ─── TESTE 1: listDeadDeliveries — a query WHERE status='dead' AND company_id=? encontra a linha ──
  SELECT COUNT(*) INTO v_count
  FROM public.integration_event_deliveries
  WHERE company_id = 1 AND status = 'dead' AND id = v_delivery_id;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'FALHA: delivery dead não encontrada pela query equivalente a listDeadDeliveries().';
  END IF;
  RAISE NOTICE 'OK (1/3): delivery dead visível pela query de dead-letter, escopada por company_id.';

  -- ─── TESTE 2: requeue PRESERVANDO attempts (comportamento padrão) ──────────
  UPDATE public.integration_event_deliveries
  SET status = 'pending', available_at = NOW(), locked_at = NULL, locked_by = NULL
  -- attempts NÃO tocado — mesmo comportamento de requeueDelivery() sem resetAttempts
  WHERE id = v_delivery_id;

  PERFORM 1 FROM public.integration_event_deliveries
  WHERE id = v_delivery_id AND status = 'pending' AND attempts = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA: requeue padrão não preservou attempts=5.';
  END IF;
  RAISE NOTICE 'OK (2/3): requeue padrão preserva attempts (orçamento de tentativas não reinicia sozinho).';

  -- ─── TESTE 3: requeue COM resetAttempts=true ────────────────────────────────
  UPDATE public.integration_event_deliveries
  SET status = 'dead' WHERE id = v_delivery_id; -- volta pro estado dead pra simular de novo

  UPDATE public.integration_event_deliveries
  SET status = 'pending', available_at = NOW(), locked_at = NULL, locked_by = NULL, attempts = 0
  WHERE id = v_delivery_id;

  PERFORM 1 FROM public.integration_event_deliveries
  WHERE id = v_delivery_id AND status = 'pending' AND attempts = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA: requeue com resetAttempts=true não zerou attempts.';
  END IF;
  RAISE NOTICE 'OK (3/3): requeue com resetAttempts=true zera o orçamento de tentativas.';

  RAISE NOTICE 'integration_event_deliveries_dead_requeue.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
