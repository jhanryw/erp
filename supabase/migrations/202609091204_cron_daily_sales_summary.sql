-- =============================================================================
-- 202609091204_cron_daily_sales_summary.sql
--
-- Agenda o resumo diário de vendas (17h America/Fortaleza = 20h UTC, fixo o
-- ano todo — Brasil não tem mais horário de verão) via pg_cron + pg_net,
-- eliminando a dependência de um cron externo (EasyPanel/n8n) para ESTE job
-- específico. A regra de negócio continua inteiramente em TypeScript
-- (/api/jobs/daily-sales-summary, que reusa getTodayRevenue()) — pg_cron só
-- passa a ser quem disca a chamada HTTP.
--
-- Depende de 202609091202_enable_pg_cron_pg_net.sql (cron.*, net.*, vault.*
-- precisam existir antes desta migration rodar).
--
-- O Bearer token é lido de vault.decrypted_secrets em tempo de execução —
-- nunca gravado em texto plano aqui. Pré-requisito (rodar manualmente, uma
-- vez, no SQL Editor — NUNCA commitar isto):
--
--   select vault.create_secret(
--     '<valor atual da env CRON_SECRET no EasyPanel>',
--     'cron_secret',
--     'Bearer token usado pelo pg_net para chamar /api/jobs/* — precisa ficar
--      idêntico à env CRON_SECRET do EasyPanel; ao rotacionar, usar
--      select vault.update_secret(id, novo_valor) com o id de
--      select id from vault.secrets where name = ''cron_secret''.'
--   );
--
-- Idempotência: remove o job antigo 'daily-sales-summary' (nome usado numa
-- primeira tentativa manual, com id numérico redondo demais pra ser
-- coincidência de produção real) antes de agendar com o nome definitivo
-- 'daily-sales-summary-17h' — evita ficar com dois jobs batendo no mesmo
-- endpoint. cron.unschedule(text) pode não existir ou lançar exceção se o
-- job já não existir, dependendo da versão — por isso o guard em bloco
-- DO/EXCEPTION, seguro tanto em bancos que já tinham o job antigo quanto em
-- bancos novos que nunca o tiveram. cron.schedule(...) com o mesmo nome
-- SUBSTITUI o agendamento existente em vez de duplicar — esta migration é
-- segura de reaplicar.
--
-- ATENÇÃO: confirmar a URL abaixo antes de aplicar (santtorini.qarvon.com é
-- o domínio de produção conforme TECHNICAL_NOTES.md — ajustar se diferente).
-- =============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('daily-sales-summary');
EXCEPTION WHEN OTHERS THEN
  NULL; -- job antigo não existia — nada a fazer
END $$;

SELECT cron.schedule(
  'daily-sales-summary-17h',
  '0 20 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://santtorini.qarvon.com/api/jobs/daily-sales-summary',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret'
      )
    ),
    body    := '{}'::jsonb
  );
  $$
);
