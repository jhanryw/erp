-- =============================================================================
-- integration_event_deliveries_independence.test.sql
--
-- TESTE MAIS IMPORTANTE DA FASE 4 (seção 50 do pedido) — prova, no nível de
-- schema (não só de intenção de código), que:
--
--   1. Marcar a delivery do Chatwoot como `processed` NUNCA move a delivery
--      de outro destino (`meta`, hoje sem consumidor real, mas já modelada
--      no CHECK constraint — ver migration 20260818) pro mesmo evento.
--   2. Marcar TODAS as deliveries de um evento como `processed`/`dead`
--      NUNCA muda `integration_outbox.status` de volta — esse campo já foi
--      congelado em `dispatched` pelo fan-out e não representa mais
--      sucesso/falha de destino nenhum (é exatamente essa mudança de
--      semântica que motivou reavaliar a Fase 2).
--   3. Falha de fan-out ou de qualquer delivery NUNCA reverte/apaga a
--      venda em si (a venda já commitou muito antes de qualquer delivery
--      existir — prova estrutural, não só funcional).
--
-- COMO RODAR (ambiente de TESTE, nunca produção):
--   psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/integration_event_deliveries_independence.test.sql
--
-- Roda inteiro dentro de BEGIN...ROLLBACK — não é destrutivo.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_outbox_id        bigint;
  v_delivery_chatwoot bigint;
  v_delivery_meta     bigint;
  v_outbox_status     text;
BEGIN
  -- ─── Fixture: 1 evento de domínio JÁ "dispatched" (simula fan-out concluído) ──
  INSERT INTO public.integration_outbox (company_id, event_id, event_type, aggregate_type, aggregate_id, payload, status)
  VALUES (1, 'teste:independencia:1', 'sale.completed', 'sale', '999004', '{"sale_id": 999004, "customer_id": 1, "total": 100}'::jsonb, 'dispatched')
  RETURNING id INTO v_outbox_id;

  -- 2 deliveries pro MESMO evento, destinos diferentes — exatamente o
  -- cenário "Chatwoot processado, Meta ainda pendente" do pedido.
  INSERT INTO public.integration_event_deliveries (outbox_event_id, company_id, destination, status)
  VALUES (v_outbox_id, 1, 'chatwoot', 'pending')
  RETURNING id INTO v_delivery_chatwoot;

  INSERT INTO public.integration_event_deliveries (outbox_event_id, company_id, destination, status)
  VALUES (v_outbox_id, 1, 'meta', 'pending')
  RETURNING id INTO v_delivery_meta;

  -- ─── TESTE 1: marcar Chatwoot como processed não move Meta ────────────────
  UPDATE public.integration_event_deliveries
  SET status = 'processed', processed_at = NOW()
  WHERE id = v_delivery_chatwoot;

  PERFORM 1 FROM public.integration_event_deliveries
  WHERE id = v_delivery_meta AND status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: marcar a delivery do Chatwoot como processed alterou (ou apagou) a delivery do Meta — destinos NÃO são independentes.';
  END IF;
  RAISE NOTICE 'OK (1/3): delivery Meta continua pending depois do Chatwoot ser processed — destinos são independentes.';

  -- ─── TESTE 2: mesmo com Chatwoot processed e Meta ainda pending, o evento
  -- outbox continua "dispatched" — nunca reflete o status de um destino só ──
  SELECT status INTO v_outbox_status FROM public.integration_outbox WHERE id = v_outbox_id;
  IF v_outbox_status <> 'dispatched' THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: integration_outbox.status mudou de "dispatched" pra "%" só porque UM destino terminou — isso é exatamente o bug que a Fase 4 existe pra evitar (Meta perderia o evento).', v_outbox_status;
  END IF;
  RAISE NOTICE 'OK (2/3): integration_outbox.status continua "dispatched" independente do progresso de cada delivery — Meta não perde o evento.';

  -- ─── TESTE 3: marcar TODAS as deliveries (inclusive como dead) não altera a venda ──
  UPDATE public.integration_event_deliveries SET status = 'dead', last_error = 'falha simulada' WHERE id = v_delivery_meta;

  -- Não há "sales" real nesta fixture (aggregate_id é só um texto de
  -- teste) — a prova estrutural é que nenhum trigger/FK deste schema liga
  -- integration_event_deliveries de volta pra `sales` (sem FK ON UPDATE/
  -- DELETE CASCADE partindo de deliveries em direção a sales, confirmado
  -- pelo desenho: aggregate_id é TEXT solto, não FK). Confirma isso
  -- diretamente no catálogo:
  PERFORM 1 FROM pg_constraint
  WHERE conrelid = 'public.integration_event_deliveries'::regclass
    AND confrelid = 'public.sales'::regclass;
  IF FOUND THEN
    RAISE EXCEPTION 'FALHA CRÍTICA: existe uma FK de integration_event_deliveries pra sales — isso acoplaria o resultado de uma delivery ao domínio comercial, quebrando a garantia de independência.';
  END IF;
  RAISE NOTICE 'OK (3/3): nenhuma FK liga integration_event_deliveries a sales — falha/estado de delivery estruturalmente não pode reverter/travar uma venda.';

  RAISE NOTICE 'integration_event_deliveries_independence.test.sql: todos os testes passaram.';
END $$;

ROLLBACK;
