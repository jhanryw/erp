-- FASE 5 (Runner automático de Integration Outbox/Deliveries) — adiciona
-- 'skipped' como status distinto de 'processed' em
-- integration_event_deliveries.
--
-- Motivo (seção 11 do pedido): "not_linked" (customer sem contato Chatwoot
-- vinculado ainda) e situações equivalentes (crm_person ambígua, sem
-- customer resolvido, cliente anônimo, integração inativa) NÃO são erro de
-- infraestrutura nem sucesso de sincronização — são um resultado terminal
-- válido e distinto dos dois. Até esta migration, o runner (e o consumer da
-- Fase 4) usava 'processed' pra esses casos, misturando "sincronizei de
-- verdade" com "não havia o que sincronizar" numa métrica só. O pedido da
-- Fase 5 explicitamente quer um contador `deliveries_skipped` separado de
-- `deliveries_processed` na observabilidade (seção 14) — para isso ser uma
-- métrica real (não só um log calculado em cima do mesmo status), o status
-- em si precisa diferenciar os dois casos.
--
-- Não migra dados retroativamente: nenhuma linha com status='processed'
-- pré-existente é reclassificada — só o código novo (Fase 5 em diante)
-- passa a escrever 'skipped' quando for o caso. Não-destrutivo.

DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.integration_event_deliveries'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%status%pending%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.integration_event_deliveries DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE public.integration_event_deliveries
  ADD CONSTRAINT integration_event_deliveries_status_check
  CHECK (status IN ('pending', 'processing', 'processed', 'skipped', 'failed', 'dead'));
