-- ============================================================================
-- NÃO EXECUTADO. Rodar só com autorização, DEPOIS da migration
-- 202610151000_company_fiscal_regime_history.sql e DEPOIS de conferir o
-- cadastro (docs/sql/conferir-cadastro-emitente.sql).
--
-- Pensado para o SQL Editor do Supabase: o script inteiro roda de uma vez,
-- então a conferência NÃO fica depois de um COMMIT manual — ela está DENTRO
-- do bloco DO. Qualquer divergência levanta exceção e o bloco inteiro é
-- desfeito (nada é gravado). Não use BEGIN/COMMIT manuais aqui.
--
-- Escopo: SOMENTE company_id = 1. NÃO toca em fiscal_documents,
-- fiscal_document_items nem vendas.
-- Base: Receita Federal (16/11/2026): SIMEI 30/06/2025–31/08/2026;
-- primeiro dia fora do SIMEI = 01/09/2026.
-- ============================================================================
do $$
declare
  v_crt smallint;
  v_docs_before bigint;
  v_docs_after bigint;
  v_hash_before text;
  v_hash_after text;
begin
  select count(*), md5(string_agg(id::text || status || coalesce(request_payload::text,''), ',' order by id))
    into v_docs_before, v_hash_before
    from public.fiscal_documents where company_id = 1;

  select crt into v_crt from public.company_fiscal_settings where company_id = 1 for update;
  if not found then raise exception 'company_fiscal_settings da empresa 1 não encontrada'; end if;
  if v_crt is distinct from 4 then
    raise exception 'CRT atual é %, esperado 4 — nada foi alterado', v_crt;
  end if;

  insert into public.company_fiscal_regime_history (company_id, crt, effective_from, effective_to, source)
  values (1, 4, date '2025-06-30', date '2026-08-31', 'Receita Federal — consulta 16/11/2026 (SIMEI)'),
         (1, 1, date '2026-09-01', null,              'Receita Federal — consulta 16/11/2026 (desenquadramento SIMEI)');

  update public.company_fiscal_settings
     set crt = 1, crt_effective_from = date '2026-09-01'
   where company_id = 1 and crt = 4;

  -- Conferência pós-update (qualquer falha desfaz tudo):
  if (select crt from public.company_fiscal_settings where company_id = 1) <> 1 then
    raise exception 'conferência falhou: crt não ficou 1';
  end if;
  if (select count(*) from public.company_fiscal_regime_history where company_id = 1) <> 2 then
    raise exception 'conferência falhou: histórico esperado com 2 períodos';
  end if;
  select count(*), md5(string_agg(id::text || status || coalesce(request_payload::text,''), ',' order by id))
    into v_docs_after, v_hash_after
    from public.fiscal_documents where company_id = 1;
  if v_docs_after <> v_docs_before or v_hash_after is distinct from v_hash_before then
    raise exception 'conferência falhou: fiscal_documents foi alterado';
  end if;
end $$;

-- Resultado para conferência visual (somente leitura):
select company_id, crt, crt_effective_from from public.company_fiscal_settings where company_id = 1;
select crt, effective_from, effective_to from public.company_fiscal_regime_history where company_id = 1 order by effective_from;
