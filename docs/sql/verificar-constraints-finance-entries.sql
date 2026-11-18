-- SOMENTE LEITURA. Rodar em produção ANTES da migration 202611181000.
-- Esperado: colunas payment_status/paid_at(date)/payment_method/cash_movement_id,
-- e constraints fe_payment_status_valid (paid,pending), fe_pending_has_no_payment,
-- fe_payment_method_paid_at_together, fe_cash_movement_requires_cash_method,
-- fe_cash_movement_id_unique. Qualquer diferença: parar e revisar.

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='finance_entries'
  AND column_name IN ('payment_status','paid_at','payment_method','cash_movement_id','type','reference_date')
ORDER BY column_name;

SELECT conname, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid = 'public.finance_entries'::regclass AND contype IN ('c','u')
ORDER BY conname;

-- Triggers na tabela (esperado: nenhum que reescreva payment_status)
SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
WHERE tgrelid='public.finance_entries'::regclass AND NOT tgisinternal;

-- Distribuição atual (nenhum 'scheduled' ainda)
SELECT payment_status, (paid_at IS NULL) AS paid_at_nulo, count(*)
FROM public.finance_entries GROUP BY 1,2 ORDER BY 1,2;

-- Views/funções que mencionam payment_status (precisam de revisão se existirem)
-- Usa prosrc (pg_get_functiondef falha em funções agregadas, ex.: array_agg).
SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prosrc ILIKE '%payment_status%'
  AND p.prosrc ILIKE '%finance_entries%';
SELECT schemaname, viewname FROM pg_views
WHERE schemaname='public' AND definition ILIKE '%payment_status%' AND definition ILIKE '%finance_entries%';

-- ── Pré-requisitos da efetivação automática (202611191000/1100) ─────────────
-- 1) Trigger de auditoria genérico de finance_entries: precisa tolerar UPDATE
--    sem usuário (auth.uid() NULL), pois o job roda sem sessão.
SELECT pg_get_functiondef('public.audit_trigger_function'::regproc);
-- 2) audit_logs (usada pela função) e audit_log (usada pelo trigger): user_id nullable?
SELECT table_name, column_name, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name IN ('audit_logs','audit_log') AND column_name='user_id';
-- 3) pg_cron habilitado e jobs atuais
SELECT extname FROM pg_extension WHERE extname IN ('pg_cron','pg_net');
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid;
