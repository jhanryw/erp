-- Histórico do regime tributário (CRT) da empresa + data de efeito.
-- Aditiva e idempotente. NÃO altera company_fiscal_settings.crt nem nenhum
-- documento fiscal — a troca de CRT é um procedimento separado e explícito
-- (docs/sql/atualizar-crt-4-para-1-empresa-1.sql).

alter table public.company_fiscal_settings
  add column if not exists crt_effective_from date;

comment on column public.company_fiscal_settings.crt_effective_from is
  'Data (inclusive) a partir da qual o CRT atual vale. Documentos já emitidos nunca são reescritos: guardam o CRT usado em request_payload/snapshot.';

-- Necessária para o EXCLUDE de períodos sobrepostos (igualdade de integer em GiST).
create extension if not exists btree_gist with schema extensions;

create table if not exists public.company_fiscal_regime_history (
  id             bigint generated always as identity primary key,
  company_id     integer  not null,
  crt            smallint not null check (crt between 1 and 4),
  effective_from date     not null,
  effective_to   date,
  source         text,
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique (company_id, effective_from),
  -- Impede períodos sobrepostos (e, por consequência, dois períodos "em aberto") por empresa.
  constraint company_fiscal_regime_no_overlap
    exclude using gist (company_id with =, daterange(effective_from, effective_to, '[]') with &&)
);

alter table public.company_fiscal_regime_history enable row level security;
-- Sem policies: acesso só via service role (mesmo padrão das tabelas fiscais internas).
