-- SOMENTE LEITURA — o que ficou gravado depois da tentativa que falhou no SQL Editor.
select to_regclass('public.company_fiscal_regime_history') as tabela_historico,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='company_fiscal_settings' and column_name='crt_effective_from') as coluna_crt_effective_from;
select company_id, crt, updated_at from public.company_fiscal_settings where company_id = 1;
-- só funciona se a migration já foi aplicada:
-- select * from public.company_fiscal_regime_history where company_id = 1;
