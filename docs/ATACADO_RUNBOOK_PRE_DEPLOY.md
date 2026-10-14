# Runbook de pré-publicação — atacado institucional (SOMENTE LEITURA)

Branch: `feat/atacado-institucional` (hash remoto `b9fb178`). `origin/main` = `d52851e`.
Regra: nada abaixo escreve, reinicia ou altera configuração. Todo SQL é `SELECT`. Nenhum comando imprime segredos
(variáveis de ambiente são mostradas só pelo NOME). Se um comando exigir `sudo` só para LEITURA de logs, tudo bem; nada além disso.

Os seis arquivos de migration pendentes (ordem):

| # | Arquivo | Cria/altera |
|---|---|---|
| 1 | `202610091000_wholesale_banners_text_mobile` | 5 colunas em `wholesale_site_banners`, CHECK `chk_wholesale_site_banners_text_len`, índice `idx_wholesale_site_banners_mobile_media` |
| 2 | `202610091100_wholesale_category_covers` | tabela `wholesale_category_covers`, UNIQUE, índice, trigger, RLS |
| 3 | `202610091200_wholesale_site_texts` | 8 colunas de texto em `wholesale_site_settings`, CHECK `chk_wholesale_site_texts_len` |
| 4 | `202610091300_product_color_groups` | tabela `product_color_groups`, `products.color_group_id`, FK composta `fk_products_color_group` (**PG15+**), índices, trigger, RLS |
| 5 | `202610131000_wholesale_orders_optional_contact` | `customer_name/phone` NULLáveis, CHECK `chk_wholesale_orders_contact_pair`, **UPDATE de backfill**, nova `rpc_create_wholesale_order` |
| 6 | `202610141000_wholesale_site_chrome` | tabela `wholesale_site_announcements`, colunas `announcement_interval_seconds`, `site_chrome`, 2 CHECKs, trigger, RLS |

---------------------------------------------------------------------------------------------------

## ETAPA 1 — Supabase SQL Editor (banco de produção)
Onde: Supabase Studio (o seu está em `qarvon-supabase.uxxkgy.easypanel.host`) → SQL Editor. Rode cada bloco separadamente.

### 1.1 Versão do PostgreSQL (migration 4 exige >= 15)
```sql
select current_setting('server_version') as versao,
       current_setting('server_version_num')::int as num,
       current_setting('server_version_num')::int >= 150000 as suporta_migration_4;
```
Esperado: `suporta_migration_4 = true`. Se `false` → **NO-GO** para a migration 4 (e para o que depende de `color_group_id`).

### 1.2 Pré-requisitos (objetos que as migrations assumem existir)
```sql
select x.objeto, to_regclass(x.objeto) is not null as existe
from (values ('public.companies'),('public.categories'),('public.media'),('public.products'),
             ('public.wholesale_site_banners'),('public.wholesale_site_settings'),
             ('public.wholesale_orders'),('public.wholesale_order_items'),('public.wholesale_order_counters')) x(objeto);

select 'fn company_integrations_touch_updated_at' as objeto,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='company_integrations_touch_updated_at') as existe;
```
Esperado: tudo `true`. Qualquer `false` → a migration correspondente falhará.

### 1.3 Quais migrations já estão REALMENTE aplicadas (por objeto, não por nome)
**Colunas** (uma linha por coluna esperada; `existe=false` = ausente):
```sql
with esperado(migration, tbl, col) as (values
 (1,'wholesale_site_banners','mobile_media_id'),(1,'wholesale_site_banners','title'),(1,'wholesale_site_banners','subtitle'),
 (1,'wholesale_site_banners','cta_label'),(1,'wholesale_site_banners','show_text'),
 (3,'wholesale_site_settings','hero_title'),(3,'wholesale_site_settings','hero_subtitle'),(3,'wholesale_site_settings','categories_title'),
 (3,'wholesale_site_settings','products_title'),(3,'wholesale_site_settings','add_also_title'),(3,'wholesale_site_settings','minimum_order_note'),
 (3,'wholesale_site_settings','empty_message'),(3,'wholesale_site_settings','footer_text'),
 (4,'products','color_group_id'),
 (6,'wholesale_site_settings','announcement_interval_seconds'),(6,'wholesale_site_settings','site_chrome'))
select e.migration, e.tbl||'.'||e.col as objeto, c.column_name is not null as existe, c.data_type, c.is_nullable
from esperado e
left join information_schema.columns c
  on c.table_schema='public' and c.table_name=e.tbl and c.column_name=e.col
order by e.migration, objeto;
```
**Tabelas, RLS, índices, triggers, constraints:**
```sql
-- tabelas + RLS ligada
select r.migration, r.tbl, to_regclass('public.'||r.tbl) is not null as existe,
       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.'||r.tbl)), false) as rls_ligada
from (values (2,'wholesale_category_covers'),(4,'product_color_groups'),(6,'wholesale_site_announcements')) r(migration,tbl);

-- índices
select migration, idx, exists(select 1 from pg_indexes where schemaname='public' and indexname=idx) as existe
from (values (1,'idx_wholesale_site_banners_mobile_media'),(2,'idx_wholesale_category_covers_media'),
             (4,'idx_product_color_groups_company'),(4,'idx_products_color_group'),
             (6,'idx_wholesale_site_announcements_company')) v(migration,idx);

-- triggers
select migration, trg, exists(select 1 from pg_trigger where tgname=trg and not tgisinternal) as existe
from (values (2,'trg_wholesale_category_covers_touch_updated_at'),(4,'trg_product_color_groups_touch_updated_at'),
             (6,'trg_wholesale_site_announcements_touch_updated_at')) v(migration,trg);

-- constraints (convalidated deve ser true)
select conname, conrelid::regclass as tabela, convalidated, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conname in ('chk_wholesale_site_banners_text_len','uq_wholesale_category_covers_company_category',
                  'chk_wholesale_site_texts_len','uq_product_color_groups_id_company','fk_products_color_group',
                  'chk_wholesale_orders_contact_pair',
                  'chk_wholesale_site_settings_announcement_interval','chk_wholesale_site_settings_chrome')
order by conname;
```
Leitura: na linha `fk_products_color_group`, a definição deve conter `ON DELETE SET NULL (color_group_id)` (lista de colunas = PG15+).

**Migration 5 (contato opcional) — por comportamento do banco:**
```sql
select column_name, is_nullable
from information_schema.columns
where table_schema='public' and table_name='wholesale_orders' and column_name in ('customer_name','customer_phone');
-- ambos devem ser YES se a migration 5 foi aplicada

select p.oid::regprocedure as assinatura,
       p.prosrc ilike '%p_customer_phone IS NOT NULL%' as corpo_da_migration_5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='rpc_create_wholesale_order';

select has_function_privilege('anon',   'public.rpc_create_wholesale_order(int,uuid,text,text,numeric,text,jsonb,int,int,int)', 'EXECUTE') as anon_executa,
       has_function_privilege('service_role','public.rpc_create_wholesale_order(int,uuid,text,text,numeric,text,jsonb,int,int,int)','EXECUTE') as service_role_executa;
```
Esperado: `anon_executa=false`, `service_role_executa=true`. Se a função tiver assinatura diferente da acima, `has_function_privilege` dará erro — nesse caso use a assinatura mostrada na 1ª consulta.

### 1.4 Rastreamento oficial (apenas informativo — as migrations podem ter sido aplicadas à mão)
```sql
select to_regclass('supabase_migrations.schema_migrations') is not null as tem_tabela_de_historico;
-- se true:
select version, name from supabase_migrations.schema_migrations order by version desc limit 15;
```
Não confie só nisto: se os arquivos foram colados no SQL Editor, o histórico não existe. A verdade são os objetos (1.3).

### 1.5 Incompatibilidades entre o schema/dados atuais e as migrations
```sql
-- (5) o CHECK novo exige nome e telefone juntos. Linhas que o VIOLARIAM (esperado: 0):
select count(*) as viola_check_contato
from public.wholesale_orders where (customer_name is null) <> (customer_phone is null);

-- (5) o backfill do UPDATE vai REESCREVER estas linhas (é a única escrita de dados das 6 migrations):
select count(*) as linhas_que_o_backfill_alterara
from public.wholesale_orders
where customer_name = 'Cliente do site' and customer_phone ~ '^\+5500[0-9]{8}$';

-- (4) tipos das chaves usadas pelas FKs (precisam ser compatíveis: companies.id/categories.id INT, media.id BIGINT)
select table_name, column_name, data_type from information_schema.columns
where table_schema='public' and (table_name,column_name) in
  (('companies','id'),('categories','id'),('media','id'),('products','id'),('products','company_id'));

-- (6) uma linha de settings por empresa? (a gravação de site_chrome usa a linha da empresa)
select company_id, count(*) from public.wholesale_site_settings group by 1 having count(*) > 1;

-- (qualquer) objetos com o mesmo nome mas definição divergente já existem? (CREATE ... IF NOT EXISTS não corrige)
select conname, conrelid::regclass, pg_get_constraintdef(oid)
from pg_constraint where conname in ('uq_product_color_groups_id_company','uq_wholesale_category_covers_company_category');
```
Esperado: `viola_check_contato=0`; linhas de backfill = número que você aceita alterar (registre antes); sem duplicidade em settings.

### 1.6 Tenant do site (dados fiscais/anúncios dependem dele)
Rode no Studio **apenas** o resultado da empresa do site (o UUID/ID do usuário de sistema está na env do EasyPanel — não cole aqui):
```sql
select u.id as user_id, u.company_id, c.name
from public.users u join public.companies c on c.id = u.company_id
where u.id = '<WHOLESALE_SITE_SYSTEM_USER_ID>';   -- substitua localmente; não registre o valor

select company_id, count(*) from public.company_fiscal_settings group by 1 having count(*) > 1; -- esperado: 0 linhas
```

---------------------------------------------------------------------------------------------------

## ETAPA 2 — EasyPanel (interface web, somente consulta)
Onde: painel do EasyPanel → projeto → serviço do ERP/atacado.

| # | O que olhar | Como interpretar |
|---|---|---|
| 2.1 | **Deploy / Deployments**: último deploy, commit e mensagem | É o commit EM EXECUÇÃO (resposta ao item 5). Compare com `d52851e` (main) |
| 2.2 | **Source / GitHub**: repo, branch configurada, toggle de **Auto Deploy** | Se auto-deploy está ligado na `main`, o merge dispara build+deploy IMEDIATO — antes disso as migrations já têm de estar aplicadas (item 4) |
| 2.3 | GitHub → repo → Settings → Webhooks → *Recent deliveries* (só leitura) | Existe webhook do EasyPanel? Últimas entregas 2xx? Confirma auto-deploy |
| 2.4 | **Environment**: apenas os NOMES. Conferir presença de `WHOLESALE_SITE_SYSTEM_USER_ID`, `WHOLESALE_CLIENT_IP_HEADER` ou `WHOLESALE_TRUSTED_PROXY_HOPS`, `SYSTEM_USER_ID`, `CRON_SECRET` | Sem as duas de IP o rate limiting usa balde único (60/h) |
| 2.5 | **Build args** (o Dockerfile usa `ARG` de `NEXT_PUBLIC_*`) | `NEXT_PUBLIC_*` são fixados no BUILD; mudar só a env não basta, exige novo build |
| 2.6 | **Health check / porta / recursos** (porta 3000, limite de memória/CPU) | Healthcheck apontando para rota inexistente ou protegida (`/api/health` redireciona para /login → 307) pode marcar o app como não saudável |
| 2.7 | **Logs** do serviço (últimas 24–48 h) e **Monitor** (memória/CPU) | Procure `ECONNREFUSED`, `ENOMEM`, `JavaScript heap out of memory`, `Killed`, reinícios; picos de memória antes do 502 |
| 2.8 | Serviço de banco (Supabase) na mesma VPS: memória/CPU | O 502 pode ser o app disputando memória com o Postgres |

---------------------------------------------------------------------------------------------------

## ETAPA 3 — Terminal da VPS (SSH, leitura)
EasyPanel roda sobre Docker Swarm + Traefik. Defina o nome do serviço (substitua `<SERVICO>` pelo que `docker service ls` mostrar).

### 3.1 Recursos do servidor e eventos de OOM
```bash
uptime; free -h; df -h / /var/lib/docker 2>/dev/null
dmesg -T 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -20
```
### 3.2 Serviços e histórico de tarefas (reinícios/falhas)
```bash
docker service ls
docker service ps <SERVICO> --no-trunc | head -20        # linhas Shutdown/Failed + motivo ("task: non-zero exit (137)" = OOM/kill)
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | grep -iE "traefik|<SERVICO>|postgres|supabase"
```
### 3.3 Qual versão está rodando (item 5)
```bash
docker service inspect <SERVICO> --format '{{.Spec.TaskTemplate.ContainerSpec.Image}} | atualizado em {{.UpdatedAt}}'
docker ps --filter name=<SERVICO> --format '{{.ID}} {{.Image}} {{.CreatedAt}} {{.Status}}'
# BUILD_ID do Next dentro do container (identifica o build; compare entre execuções):
docker exec $(docker ps -q --filter name=<SERVICO> | head -1) cat .next/BUILD_ID 2>/dev/null
```
Observação: o repositório NÃO embute o SHA do git no build; o commit exato só é confiável pela tela de Deployments do EasyPanel (2.1).

### 3.4 Variáveis de IP SEM expor segredos (item 6 — parte aplicação)
```bash
C=$(docker ps -q --filter name=<SERVICO> | head -1)
docker exec $C printenv | grep -E '^(WHOLESALE_CLIENT_IP_HEADER|WHOLESALE_TRUSTED_PROXY_HOPS|WHOLESALE_ORDERS_UNKNOWN_IP_PER_HOUR)=' 
docker exec $C printenv | cut -d= -f1 | sort | grep -E '^WHOLESALE_|SYSTEM_USER'   # só NOMES
```
### 3.5 Traefik: IP confiável (item 6 — parte proxy)
```bash
T=$(docker ps -q --filter name=traefik | head -1)
docker inspect $T --format '{{json .Args}}' | tr ',' '\n' | grep -iE "forwardedheaders|trustedips|insecure|accesslog|entrypoints"
docker service inspect traefik --format '{{json .Spec.TaskTemplate.ContainerSpec.Args}}' 2>/dev/null | tr ',' '\n' | grep -iE "forwardedheaders|trustedips|insecure"
```
Interpretação:
- Sem CDN: o DNS do site aponta direto para o IP da VPS (verificado: `82.25.68.222`; resposta sem cabeçalhos `cf-*`/`via`). Logo o Traefik é a borda; o último valor de `X-Forwarded-For` é o IP real.
- `WHOLESALE_TRUSTED_PROXY_HOPS=1` (usa a entrada da DIREITA do XFF) é a opção segura nesse desenho.
- `WHOLESALE_CLIENT_IP_HEADER=x-real-ip` só é seguro se o Traefik SOBRESCREVE o cabeçalho; com `forwardedHeaders.insecure=true` ele pode vir do cliente → evitar.
### 3.6 Logs relacionados ao 502
```bash
docker service logs <SERVICO> --since 48h --timestamps 2>&1 | grep -iE "error|ECONN|ENOMEM|heap|killed|SIGTERM|SIGKILL|listen|EADDRINUSE|502" | tail -80
docker service logs traefik --since 48h --timestamps 2>&1 | grep -E ' (502|503|504) |no available server|unable to|dial tcp|connection refused|EOF' | tail -80
journalctl -u docker --since "48 hours ago" --no-pager 2>/dev/null | grep -iE "oom|killed|restart|unhealthy" | tail -30
```
Leitura: `no available server`/`unhealthy` = Traefik sem backend saudável (container reiniciando/healthcheck); `dial tcp ... refused` = porta errada ou app não subiu; `exit 137`/OOM = memória; erro de SQL/`PGRST` nos logs do app = banco/migration.

---------------------------------------------------------------------------------------------------

## ETAPA 4 — Verificações externas (já executáveis de qualquer terminal)
```bash
dig +short atacado.santtorini.com A
for p in / /carrinho; do curl -s -o /dev/null -w "$p %{http_code} %{time_total}s\n" https://atacado.santtorini.com$p; done
git ls-remote https://github.com/jhanryw/erp.git refs/heads/main refs/heads/feat/atacado-institucional
```

---------------------------------------------------------------------------------------------------

## Diagnóstico GO / NO-GO

### Fatos CONFIRMADOS (verificados nesta rodada)
- Código: `tsc` limpo, 2572 testes verdes (218 arquivos), build de produção compilou, merge simulado com `origin/main` sem conflito; branch publicada em `b9fb178`, `main` = `d52851e`.
- Produção em 14/10/2026: DNS direto para `82.25.68.222`, sem CDN; `/` e `/carrinho` → 200; sem artefatos desta branch (nem barra, nem rodapé novo, nem botão; `/brand/whatsapp/...svg` → 404) — ou seja, o que roda NÃO contém esta funcionalidade.
- A funcionalidade tem fallback sem a migration 6 (anúncios → vazio; rodapé com padrões), mas sem a migration 5 o pedido sem contato cai no marcador legado.
- O repositório não embute o commit no build → o commit em execução só é conhecido pelo EasyPanel.

### PENDENTE (não verificável daqui — depende das Etapas 1–3)
| Item | Bloqueia? | Como fechar |
|---|---|---|
| Versão do PostgreSQL ≥ 15 | **Sim** (migration 4) | 1.1 |
| Quais das 6 migrations já existem | **Sim** | 1.3 |
| Violação do CHECK de contato / quantidade do backfill | **Sim** (migration 5) | 1.5 |
| Auto-deploy da `main` ligado? | **Sim** — define a ordem: migrations ANTES do merge | 2.2 / 2.3 |
| Commit em execução | Não bloqueia, mas é necessário | 2.1 / 3.3 |
| Causa do 502 anterior | **Sim** (risco de repetir no deploy) | 3.1 / 3.2 / 3.6 / 2.7 |
| IP confiável (variáveis + Traefik) | Não bloqueia; degrada rate limiting | 3.4 / 3.5 |
| Healthcheck apropriado | Risco | 2.6 |

### Veredito atual: **NO-GO (condicional)**
Não há bloqueio de código. O NO-GO é por informação ausente: sem 1.1, 1.3, 1.5 e a causa do 502 não se pode afirmar que o deploy é seguro. Vira **GO** quando TODAS forem verdadeiras:
1. PostgreSQL ≥ 15 (1.1);
2. migrations 1–6 aplicadas e validadas por objeto, em ordem, antes do merge/deploy (1.3), com `viola_check_contato = 0`;
3. auto-deploy conhecido e sob controle (2.2/2.3) — se ligado, o merge só ocorre após o item 2;
4. causa do 502 identificada ou descartada (3.2/3.6), com memória/healthcheck adequados;
5. backup do banco recente antes de aplicar a migration 5 (único passo que altera dados).
