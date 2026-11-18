-- =============================================================================
-- 202611191000_fn_settle_scheduled_payments.sql
--
-- Efetivação automática de pagamentos agendados.
--
-- public.fn_settle_scheduled_payments() converte finance_entries de
-- 'scheduled' para 'paid' quando a data programada (paid_at) chegou, no fuso
-- America/Fortaleza. Ela é a ÚNICA regra de negócio da automação; quem a
-- dispara (pg_cron, ver 202611191100, ou a rota /api/jobs/settle-scheduled-
-- payments) apenas a chama.
--
-- Garantias:
--   • Só payment_status='scheduled' E type='expense' E paid_at <= hoje
--     (hoje = data atual em America/Fortaleza, calculada DENTRO da função —
--     não há parâmetro de data, ninguém consegue efetivar antecipadamente).
--   • Altera SOMENTE payment_status. paid_at (data programada = data efetiva),
--     reference_date, payment_method, amount, categoria, descrição, company_id
--     e cash_movement_id ficam intactos. Não cria lançamentos nem movimentos
--     de Caixa. pending e paid nunca são tocados.
--   • Idempotente: após a 1ª execução as linhas já são 'paid' e saem do
--     filtro; execuções repetidas retornam settled = 0.
--   • Concorrência: FOR UPDATE SKIP LOCKED + re-checagem das condições no
--     próprio UPDATE (READ COMMITTED reavalia o WHERE após esperar lock). Uma
--     ação manual (confirmar/cancelar/reagendar) concorrente vence ou perde
--     por inteiro, nunca corrompe o status.
--   • Auditoria atômica (mesma instrução): uma linha em audit_logs por
--     lançamento, user_id NULL e user_role 'system'.
--   • Multiempresa: processa todas as empresas, linha a linha, sem misturar
--     company_id (cada auditoria carrega o company_id do próprio registro).
--
-- Permissões: só service_role (e o dono do banco/pg_cron). Nada de
-- anon/authenticated.
--
-- Não altera nenhuma linha existente ao ser criada. Idempotente.
-- Pré-requisito: 202611181000 (status 'scheduled').
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_settle_scheduled_payments()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'America/Fortaleza')::date;
  v_settled integer;
  v_by_co   jsonb;
BEGIN
  WITH due AS (
    SELECT id
    FROM   public.finance_entries
    WHERE  payment_status = 'scheduled'
      AND  type = 'expense'
      AND  paid_at IS NOT NULL
      AND  paid_at <= v_today
    ORDER  BY id
    FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE public.finance_entries fe
       SET payment_status = 'paid'
      FROM due
     WHERE fe.id = due.id
       AND fe.payment_status = 'scheduled'
       AND fe.type = 'expense'
       AND fe.paid_at <= v_today
    RETURNING fe.id, fe.company_id, fe.paid_at, fe.payment_method, fe.reference_date, fe.amount
  ),
  aud AS (
    INSERT INTO public.audit_logs
      (ts, user_id, user_role, action, resource, resource_id, before_data, after_data, detail)
    SELECT now(), NULL, 'system', 'update', 'finance_entry', upd.id::text,
           jsonb_build_object('payment_status', 'scheduled', 'paid_at', upd.paid_at,
                              'payment_method', upd.payment_method),
           jsonb_build_object('payment_status', 'paid', 'paid_at', upd.paid_at,
                              'payment_method', upd.payment_method),
           'agendamento:auto_confirm (sistema) company_id=' || upd.company_id
    FROM   upd
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM aud)::integer,
         COALESCE((SELECT jsonb_object_agg(company_id::text, n)
                   FROM (SELECT company_id, count(*) AS n FROM upd GROUP BY company_id) s), '{}'::jsonb)
  INTO   v_settled, v_by_co;

  RETURN jsonb_build_object('today', v_today, 'settled', v_settled, 'by_company', v_by_co);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_settle_scheduled_payments() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_scheduled_payments() TO service_role;

COMMENT ON FUNCTION public.fn_settle_scheduled_payments() IS
  'Efetiva despesas scheduled cuja paid_at <= hoje (America/Fortaleza): payment_status scheduled->paid, preservando paid_at/reference_date/payment_method. Idempotente, SKIP LOCKED, auditoria user_role=system. Chamada por pg_cron diário.';
