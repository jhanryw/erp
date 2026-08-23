# Fase Fiscal 5C — Roteiro operacional de aplicação no banco real

Este roteiro **não aplica nada sozinho**. É a sequência exata de comandos para você
rodar manualmente (via `psql`), migration por migration, na ordem abaixo. Nenhum
commit é feito por este documento. Nenhuma migration é aplicada por mim nesta sessão
— não tenho acesso a banco real.

Pré-requisito único antes de começar: `$DATABASE_URL` apontando para o banco real,
com permissão suficiente (dono do schema `public` ou superusuário) para
`ALTER TABLE`/`CREATE TABLE`/`DROP FUNCTION`/`GRANT`/`REVOKE`.

## Antes de tudo — backup

Independente do rollback específico de cada migration (detalhado abaixo), faça um
backup completo antes de iniciar a sequência:

```bash
pg_dump "$DATABASE_URL" \
  -t public.sales -t public.sale_items -t public.customer_addresses \
  -t public.sale_recipients --data-only -F c \
  -f /tmp/backup_pre_fase5c_$(date +%Y%m%d_%H%M).dump
```

Isso cobre as 4 tabelas tocadas por esta fase. `sale_recipients` ainda não existe
antes da migration 2 — o `pg_dump` de uma tabela inexistente falha; rode este backup
específico só a partir de depois da migration 2, ou omita `-t public.sale_recipients`
no primeiro backup e refaça depois.

## Ordem de aplicação

| # | Migration | Tipo | Reversível automaticamente? |
|---|---|---|---|
| 1 | `20260828_customer_addresses_ibge.sql` | Schema (ADD COLUMN) | Sim |
| 2 | `20260828_sale_recipients.sql` | Schema (CREATE TABLE) | Sim |
| 3 | `20260828_sale_items_price_snapshot.sql` | Schema (ADD COLUMN) | Sim |
| 4 | `20260828_rpc_create_sale_pricing_and_products_total.sql` | RPC (DROP+CREATE+GRANT) | Não automático — ver seção própria |
| 5 | `20260828_backfill_products_total.sql` | Dado (UPDATE) | Não automático — precisa backup próprio (incluído abaixo) |

A ordem é obrigatória: 4 lê colunas criadas em 1 e 3, e escreve em 2; 5 só faz
sentido depois que 4 já está gravando `products_total` corretamente para vendas
novas (senão o backfill corrige o passado e a próxima venda volta a ficar errada).

Regra geral de PARE: se qualquer comando abaixo retornar erro, ou qualquer query de
verificação não bater com o "resultado esperado", **pare nesse ponto — não aplique a
próxima migration da lista**, mesmo que o erro pareça pequeno.

---

## Migration 1 — `20260828_customer_addresses_ibge.sql`

### Aplicar

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f supabase/migrations/20260828_customer_addresses_ibge.sql
```

`--single-transaction` garante que, se qualquer statement do arquivo falhar, nada
daquele arquivo fica meio-aplicado.

### Verificação pós-aplicação

```sql
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customer_addresses'
  AND column_name IN ('municipio_ibge', 'ibge_source')
ORDER BY column_name;

SELECT conname
FROM pg_constraint
WHERE conname IN ('customer_addresses_municipio_ibge_format', 'customer_addresses_ibge_source_valid')
ORDER BY conname;
```

### Resultado esperado

- Primeira query: 2 linhas — `ibge_source` (`text`), `municipio_ibge` (`character`, `character_maximum_length = 7`).
- Segunda query: 2 linhas — as duas constraints existem.

### PARE se

- Alguma das duas colunas não aparecer.
- Alguma das duas constraints não aparecer.
- O comando `psql` retornar código de saída diferente de zero.

### Rollback

Só é seguro **antes** de aplicar a migration 4 (que passa a ler estas colunas via
`customer_addresses` dentro do RPC). Depois da migration 4, reverter isto quebra a
função.

```sql
ALTER TABLE public.customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_municipio_ibge_format;
ALTER TABLE public.customer_addresses DROP CONSTRAINT IF EXISTS customer_addresses_ibge_source_valid;
ALTER TABLE public.customer_addresses DROP COLUMN IF EXISTS municipio_ibge;
ALTER TABLE public.customer_addresses DROP COLUMN IF EXISTS ibge_source;
```

---

## Migration 2 — `20260828_sale_recipients.sql`

### Aplicar

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f supabase/migrations/20260828_sale_recipients.sql
```

### Verificação pós-aplicação

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sale_recipients'
ORDER BY ordinal_position;

SELECT relrowsecurity FROM pg_class WHERE relname = 'sale_recipients';

SELECT COUNT(*) AS quantidade_de_policies FROM pg_policies WHERE tablename = 'sale_recipients';

SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.sale_recipients'::regclass
ORDER BY conname;
```

### Resultado esperado

- Primeira query: 15 colunas (`id`, `sale_id`, `company_id`, `source_address_id`,
  `nome`, `cpf`, `cnpj`, `telefone`, `cep`, `logradouro`, `numero`, `complemento`,
  `bairro`, `municipio`, `municipio_ibge`, `uf`, `ibge_source`, `created_at` — 18 no
  total, confira contra o arquivo se quiser o número exato).
- `relrowsecurity = true`.
- `quantidade_de_policies = 0` (deny-by-default deliberado — só `service_role`
  acessa, service_role ignora RLS por padrão).
- Constraints: `sale_recipients_pkey`, `sale_recipients_sale_id_key` (UNIQUE),
  2 FKs (`sale_id`→sales, `company_id`→companies) + 1 FK opcional
  (`source_address_id`→customer_addresses), mais os 4 CHECKs
  (`municipio_ibge_format`, `uf_format`, `cep_format`, `ibge_source_valid`).

### PARE se

- Tabela não existir, ou faltar qualquer coluna.
- `relrowsecurity = false` (RLS não ativado — tabela ficaria sem proteção nenhuma).
- Qualquer policy aparecer (não deveria haver nenhuma neste ponto).
- `UNIQUE(sale_id)` ausente.

### Rollback

Só é seguro **antes** de aplicar a migration 4 (que insere nela).

```sql
DROP TABLE IF EXISTS public.sale_recipients;
```

---

## Migration 3 — `20260828_sale_items_price_snapshot.sql`

### Aplicar

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f supabase/migrations/20260828_sale_items_price_snapshot.sql
```

### Verificação pós-aplicação

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'sale_items'
  AND column_name IN ('list_price_snapshot', 'surcharge_amount')
ORDER BY column_name;

SELECT conname
FROM pg_constraint
WHERE conname IN ('sale_items_surcharge_non_negative', 'sale_items_list_price_non_negative')
ORDER BY conname;
```

### Resultado esperado

- `list_price_snapshot`: `numeric`, `is_nullable = YES`, sem default.
- `surcharge_amount`: `numeric`, `is_nullable = NO`, `column_default = 0`.
- As duas constraints existem.

### PARE se

- `surcharge_amount` não for `NOT NULL DEFAULT 0` (todo `sale_items` existente
  precisa herdar `0` automaticamente — se vier `NULL` para linhas antigas, a
  migration não rodou como esperado).
- Alguma constraint ausente.

### Rollback

Só é seguro **antes** de aplicar a migration 4 (que passa a gravar nestas colunas).

```sql
ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_surcharge_non_negative;
ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_list_price_non_negative;
ALTER TABLE public.sale_items DROP COLUMN IF EXISTS list_price_snapshot;
ALTER TABLE public.sale_items DROP COLUMN IF EXISTS surcharge_amount;
```

---

## Migration 4 — `20260828_rpc_create_sale_pricing_and_products_total.sql`

Esta é a migration de maior risco da fase (troca de assinatura de função +
grants). Tem uma etapa de **pré-checagem obrigatória antes de aplicar**, além da
verificação pós-aplicação.

### Pré-checagem — ANTES de aplicar

A migration faz `DROP FUNCTION IF EXISTS` com duas assinaturas exatas. Se a
assinatura real no banco divergir da esperada em um único tipo, o `DROP` não
encontra a função (o `IF EXISTS` engole o erro silenciosamente) e você termina a
migration com **2 ou 3 funções `rpc_create_sale` coexistindo** — exatamente o
overload que a migration existe para eliminar. Confirme antes:

```sql
SELECT p.oid::regprocedure, pg_get_function_identity_arguments(p.oid) AS assinatura
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale'
ORDER BY assinatura;
```

**Resultado esperado — exatamente 2 linhas:**
- `rpc_create_sale(integer, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint, text, integer)` — 16 parâmetros.
- `rpc_create_sale(boolean, numeric, integer, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid)` — 12 parâmetros (wrapper legado).

**PARE aqui** se:
- Aparecer qualquer linha a mais ou a menos que essas 2.
- Os tipos não baterem exatamente com o texto acima (mesmo uma diferença como
  `int` vs `bigint` importa).

Se divergir, **não aplique a migration como está** — ajuste as duas linhas
`DROP FUNCTION IF EXISTS` no início do arquivo para a assinatura real encontrada,
refaça a pré-checagem, e só então prossiga.

### Backup da definição atual (para rollback)

```bash
psql "$DATABASE_URL" -At -c "
SELECT pg_get_functiondef(p.oid) || E';\n'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale'
" > /tmp/rpc_create_sale_defs_pre_5c.sql
```

Isso salva o `CREATE OR REPLACE FUNCTION` de cada assinatura viva hoje. Guarde este
arquivo — é o material bruto do rollback, caso seja necessário.

Também capture os grants atuais, para poder restaurá-los junto:

```bash
psql "$DATABASE_URL" -f docs/rpc_sensitive_grants_audit_readonly.sql > /tmp/grants_pre_5c.txt
```

(esse script audita as outras 12 RPCs, não `rpc_create_sale` — mas rodar
`has_function_privilege` manualmente para as 2 assinaturas atuais de
`rpc_create_sale` antes de aplicar também vale a pena, para registro.)

### Aplicar

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql
```

### Verificação pós-aplicação (as 4 provas exigidas)

**1. Existe UMA ÚNICA `rpc_create_sale`:**

```sql
SELECT p.oid::regprocedure, pg_get_function_arguments(p.oid) AS argumentos
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale';
```

Esperado: **exatamente 1 linha**. O último argumento deve ser
`p_delivery_recipient jsonb DEFAULT NULL::jsonb`.

**2. Ela tem 17 parâmetros:**

```sql
SELECT pronargs
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale';
```

Esperado: `pronargs = 17`.

**3. Grants exatos — `PUBLIC=false, anon=false, authenticated=false, service_role=true`:**

```sql
WITH sig AS (
  SELECT 'public.rpc_create_sale(int, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb)'::text AS assinatura
)
SELECT
  has_function_privilege('public', sig.assinatura, 'EXECUTE')        AS public_exec,
  has_function_privilege('anon', sig.assinatura, 'EXECUTE')          AS anon_exec,
  has_function_privilege('authenticated', sig.assinatura, 'EXECUTE') AS authenticated_exec,
  has_function_privilege('service_role', sig.assinatura, 'EXECUTE')  AS service_role_exec
FROM sig;
```

Esperado: `public_exec = false`, `anon_exec = false`, `authenticated_exec = false`,
`service_role_exec = true`.

**4. Smoke tests — rodar os 4 arquivos, nesta ordem, e conferir que TODOS terminam
sem erro (todos usam `ON_ERROR_STOP=1`, então qualquer `RAISE EXCEPTION` interno
aborta o `psql` com código de saída ≠ 0):**

```bash
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_single_overload.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_pricing_invariants.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/rpc_create_sale_recipient_atomicity.test.sql
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f supabase/tests/sale_recipients_constraints.test.sql
```

- `rpc_create_sale_single_overload.test.sql` prova de novo, via chamada real,
  compatibilidade sem `p_delivery_recipient` (Bloco 3) e com `p_delivery_recipient`
  (Bloco 4) — além de repetir as provas 1-3 acima como parte do próprio teste.
- `rpc_create_sale_pricing_invariants.test.sql` prova os 5 cenários de
  `products_total`/`total_price` (inclusive o cenário literal 80+8=88,
  frete 12, total 100).
- `rpc_create_sale_recipient_atomicity.test.sql` prova atomicidade (Cenário 4:
  erro no snapshot desfaz venda inteira + estoque) e isolamento por
  `company_id` (Cenários 5-6).
- `sale_recipients_constraints.test.sql` prova as constraints de formato e a
  imutabilidade do snapshot.

Todos os 4 arquivos rodam inteiramente dentro de `BEGIN...ROLLBACK` — nada fica
persistido no banco por eles, mesmo quando passam.

### PARE se

- A prova 1 encontrar mais de 1 função.
- A prova 2 não der exatamente 17.
- Qualquer flag da prova 3 vier diferente do esperado.
- **Qualquer um dos 4 smoke tests falhar** (código de saída ≠ 0, ou você ver
  `NOTICE: PULADO` em vez de `OK` para cenários que deveriam ter pré-requisito de
  ambiente satisfeito — confira se é um "pulado" aceitável, como falta de Estoque
  Loja num ambiente de teste isolado, ou uma falha real).

**Não aplique a migration 5 se qualquer teste da RPC falhar** — esse é um requisito
explícito, não uma sugestão.

### Rollback

Não é um `DROP`/`CREATE` simples de reverter, porque o `DROP FUNCTION` da migration
já removeu a definição de 16 parâmetros do catálogo — não há nada "anterior" para
voltar automaticamente. Duas formas, em ordem de preferência:

**A. Restaurar a partir do backup capturado antes de aplicar** (`/tmp/rpc_create_sale_defs_pre_5c.sql`):

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -c "DROP FUNCTION IF EXISTS public.rpc_create_sale(int, uuid, payment_method, text, numeric, numeric, numeric, text, jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb);" \
  -f /tmp/rpc_create_sale_defs_pre_5c.sql
```

Isso recria a(s) assinatura(s) de 16 e/ou 12 parâmetros exatamente como estavam.
Depois, reaplique os grants antigos manualmente (o backup de `pg_get_functiondef`
não inclui `GRANT`/`REVOKE`) — use o resultado salvo em `/tmp/grants_pre_5c.txt` /
sua própria checagem prévia de `has_function_privilege` para saber exatamente o que
restaurar.

**B. Reaplicar as migrations anteriores que definiam a função**, caso o backup A não
esteja disponível: reexecutar, nesta ordem, `20260817_sale_rpcs_emit_outbox_events.sql`
(corpo/assinatura de 16 parâmetros) e `20260811_fix_rpc_identity_grants_tenant.sql`
(grants). Atenção: essa segunda migration só revoga de `authenticated`, nunca de
`PUBLIC`/`anon` — reverter por este caminho **reabre a exposição de PUBLIC/anon**
que só foi descoberta e corrigida nesta própria Fase 5C. Isso é uma regressão de
segurança conhecida do rollback B, não um bug novo — se usar este caminho, trate o
fechamento de PUBLIC/anon como pendência separada imediata.

Em ambos os casos, o wrapper legado de 12 parâmetros (`20260610_multi_estoque.sql`)
só volta a existir se você o recriar deliberadamente a partir do backup A — não há
motivo para restaurá-lo (zero chamadores em `src/`, confirmado por grep).

---

## Migration 5 — `20260828_backfill_products_total.sql`

### Pré-checagem — repetir a contagem, ANTES de aplicar

```sql
SELECT COUNT(*) AS linhas_que_serao_modificadas
FROM public.sales
WHERE products_total IS NULL
   OR ROUND(products_total, 2) <> ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) + COALESCE(surcharge_amount, 0), 2);
```

**Esperado: 535.**

### PARE se

O número vier diferente de 535. Isso significa que vendas novas entraram no banco
entre a auditoria e agora (esperado, já que o negócio continua rodando) — não é
necessariamente um problema, mas **não rode o `UPDATE` às cegas**: confira o que
mudou (o número só deveria subir, nunca cair, e o aumento deveria ser plausível
para o intervalo de tempo decorrido) antes de prosseguir. Se migration 4 já está
aplicada nesse momento, todo o aumento deveria vir de novas vendas — nenhuma delas
deveria mais cair no universo A (`products_total IS NULL`), já que a RPC corrigida
passa a gravar sempre; um aumento do universo A depois da migration 4 aplicada é
sinal de algo errado, e é motivo para parar e investigar antes do backfill.

### Backup específico desta migration — antes do UPDATE

```sql
CREATE TABLE IF NOT EXISTS public._backup_products_total_fase5c AS
SELECT id, products_total AS products_total_antes, now() AS capturado_em
FROM public.sales
WHERE products_total IS NULL
   OR ROUND(products_total, 2) <> ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) + COALESCE(surcharge_amount, 0), 2);
```

Confira que a tabela de backup tem 535 linhas antes de seguir:

```sql
SELECT COUNT(*) FROM public._backup_products_total_fase5c;
```

### Aplicar

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f supabase/migrations/20260828_backfill_products_total.sql
```

### Verificação pós-aplicação

```sql
SELECT COUNT(*) AS products_total_null FROM public.sales WHERE products_total IS NULL;

SELECT COUNT(*) AS divergentes_da_formula_oficial
FROM public.sales
WHERE ROUND(products_total, 2) <> ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) + COALESCE(surcharge_amount, 0), 2);
```

**Esperado: `products_total_null = 0` e `divergentes_da_formula_oficial = 0`.**

### PARE se

Qualquer uma das duas contagens vier diferente de zero — significa que o `UPDATE`
não cobriu tudo o que deveria (ex.: uma condição de corrida com uma venda concorrente
durante o `UPDATE`, ou o `WHERE` não bateu com o esperado). Não prossiga para
nenhuma outra etapa da fase (deploy de UI, commit) até entender por quê.

### Rollback

```sql
UPDATE public.sales s
SET products_total = b.products_total_antes
FROM public._backup_products_total_fase5c b
WHERE s.id = b.id;
```

Restaura exatamente o valor anterior de cada uma das 535 linhas — `NULL` para as
490 do universo A, o valor numérico antigo para as 45 do universo B. Depois de
confirmar que o rollback funcionou (repita a pré-checagem — deve voltar a dar 535),
pode remover a tabela de backup:

```sql
DROP TABLE IF EXISTS public._backup_products_total_fase5c;
```

---

## Depois das 5 migrations — antes de qualquer commit/deploy

1. Rode `npx tsc --noEmit`, a suíte de testes (`vitest`) e `npm run build`
   localmente — mesmo que nenhum código TypeScript tenha mudado nesta sessão desde
   a última verificação, é o gate padrão antes de considerar a fase encerrada.
2. **Não faça deploy de UI antes do schema estar aplicado e validado** — a UI já
   modificada (`vendas/nova/page.tsx`, `DeliveryAddressForm.tsx` etc.) assume que
   `sale_recipients`/as colunas novas existem; publicá-la antes do banco estar
   pronto quebra o fluxo de criação de venda com entrega.
3. **Não faça commit** — pendente de autorização explícita separada, conforme
   combinado.
