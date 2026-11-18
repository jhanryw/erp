-- =============================================================================
-- 202611191100_cron_settle_scheduled_payments.sql
--
-- ATIVAÇÃO do agendamento diário (pg_cron). Aplicar SOMENTE depois de:
--   1. 202611181000 e 202611191000 aplicadas;
--   2. validação manual:  SELECT public.fn_settle_scheduled_payments();
--      (deve retornar settled = 0 se não houver agendado vencido).
--
-- Horário: 03:05 UTC = 00:05 America/Fortaleza (UTC-3 fixo, sem horário de
-- verão). Roda no início do dia, então despesas programadas para "hoje" são
-- efetivadas logo após a virada. Execuções perdidas (banco indisponível) se
-- recuperam sozinhas na seguinte, pois a regra é paid_at <= hoje.
--
-- Chama a função SQL diretamente: não depende do app estar no ar, de rede, de
-- CRON_SECRET nem de pg_net. cron.schedule com o mesmo nome SUBSTITUI o job.
-- Requer pg_cron (202609091202). Para desativar:
--   SELECT cron.unschedule('settle-scheduled-payments');
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron não está habilitado: aplique 202609091202 antes.';
  END IF;
  IF to_regprocedure('public.fn_settle_scheduled_payments()') IS NULL THEN
    RAISE EXCEPTION 'fn_settle_scheduled_payments() não existe: aplique 202611191000 antes.';
  END IF;
END $$;

SELECT cron.schedule(
  'settle-scheduled-payments',
  '5 3 * * *',
  $$ SELECT public.fn_settle_scheduled_payments(); $$
);
