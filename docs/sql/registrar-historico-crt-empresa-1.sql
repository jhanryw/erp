-- NÃO EXECUTADO. Substitui atualizar-crt-4-para-1-empresa-1.sql (o CRT já está 1 em produção;
-- updated_at 16/11/2026 13:59 UTC). Só registra a data de efeito e o histórico. Idempotente.
-- Instruções simples (sem bloco DO) para o SQL Editor do Supabase: rode TUDO de uma vez ou statement a statement.
-- Pré-requisito: migration 202610151000 aplicada. Não toca em fiscal_documents.

insert into public.company_fiscal_regime_history (company_id, crt, effective_from, effective_to, source)
values (1, 4, date '2025-06-30', date '2026-08-31', 'Receita Federal — consulta 16/11/2026 (SIMEI)'),
       (1, 1, date '2026-09-01', null,              'Receita Federal — consulta 16/11/2026 (desenquadramento SIMEI)')
on conflict do nothing;

update public.company_fiscal_settings
   set crt_effective_from = date '2026-09-01'
 where company_id = 1 and crt = 1 and crt_effective_from is null;

select company_id, crt, crt_effective_from from public.company_fiscal_settings where company_id = 1;
select crt, effective_from, effective_to from public.company_fiscal_regime_history where company_id = 1 order by effective_from;
