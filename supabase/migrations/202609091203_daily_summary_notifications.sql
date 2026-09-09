-- =============================================================================
-- 202609091203_daily_summary_notifications.sql
--
-- Idempotência do resumo diário de vendas: no máximo 1 notificação por
-- empresa por dia, não importa quantas vezes /api/jobs/daily-sales-summary
-- for chamado (pg_cron disparando mais de uma vez, sobreposição durante a
-- migração do EasyPanel cron pro pg_cron, retry manual, etc.). Mesmo padrão
-- de claim atômico de public.sale_push_notifications.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.daily_summary_notifications (
  company_id   INT          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  summary_date DATE         NOT NULL,
  sent_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, summary_date)
);

ALTER TABLE public.daily_summary_notifications ENABLE ROW LEVEL SECURITY;

-- Só o service_role (backend do job) opera nesta tabela.
GRANT ALL ON public.daily_summary_notifications TO service_role;
