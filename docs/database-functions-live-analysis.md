# Análise das Funções e Triggers Vivos — Consultas e Achados Consolidados

**Tipo:** consultas somente leitura + síntese do que já é possível confirmar sem nova consulta ao banco. **Não tenho conexão autenticada ao Supabase nesta sessão** (o conector `supabase` requer autorização interativa que não está disponível aqui) — por isso, como nas duas rodadas anteriores, preparo as consultas exatas para você executar e colar o retorno. Tudo abaixo que **não** está marcado como consulta pendente já foi confirmado por leitura direta do código-fonte do repositório nesta sessão.

Todas as consultas são `SELECT` contra catálogo do sistema (`pg_proc`, `pg_trigger`, `pg_constraint`, `pg_indexes`) — nenhuma executa função de negócio, nenhuma escreve.

---

## O que já foi resolvido sem precisar de nova consulta

### `audit_cash_trigger()` — corpo completo já lido diretamente no repositório
Local: `supabase/migrations/20260602_security_audit_controls.sql:29-95` (`CREATE OR REPLACE FUNCTION`, então é rastreável — diferente de todas as outras funções desta análise). Resumo do comportamento:
- `SECURITY DEFINER`, dispara em `cash_register_sessions`, `cash_movements` (ambas `AFTER INSERT OR UPDATE OR DELETE`) e `users` (`AFTER UPDATE`, com `WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.active IS DISTINCT FROM NEW.active)` — linhas 110-118).
- Deriva `user_id` do próprio registro (não de `auth.uid()`, que pode ser `NULL` dentro de RPCs `SECURITY DEFINER`) — lógica condicional por `TG_TABLE_NAME` (linhas 50-66).
- Insere em `audit_logs` (plural) com `before_data`/`after_data` via `to_jsonb(OLD)`/`to_jsonb(NEW)`.
- **Bloco `EXCEPTION WHEN OTHERS`** (linhas 91-94) garante que uma falha no log de auditoria **nunca bloqueia a operação principal** — é fail-open por desenho, não por acidente. Relevante para qualquer decisão futura de trilha de auditoria fiscal: o mesmo padrão (auditoria não deve poder travar a operação de negócio) é uma boa prática a copiar, mas também significa que uma falha de auditoria pode passar despercebida silenciosamente hoje.
- A mesma função é reaproveitada para o trigger `trg_audit_users_role` — nome um pouco enganoso (sugere "caixa", mas cobre `users` também), não é um bug, é reaproveitamento deliberado de uma função genérica o suficiente.

**Esta função está fora do escopo de risco não confirmado — seu comportamento é totalmente conhecido.**

### `generate_cashback_for_sale(p_sale_id integer)` e `generate_cashback_for_all_sales()` — existem, mas não têm nenhum vestígio
Confirmado no catálogo de funções da rodada anterior (`pg_proc`), ambas retornam `void`, `security_definer = false`. Busca feita agora: `grep -rln "generate_cashback_for_sale\|generate_cashback_for_all_sales"` nas duas árvores de migration **e** em todo `src/` → **zero resultados em ambos**. Isso significa: (a) nenhuma migration rastreada as criou, (b) nenhum código de aplicação as chama diretamente. **Hipótese não confirmada, mas plausível:** `trigger_generate_cashback()` pode chamar `generate_cashback_for_sale(NEW.id)` internamente — os nomes são consistentes com essa relação, e seria um padrão razoável (trigger fino delegando para uma função utilitária testável). **Isto precisa ser confirmado lendo o corpo de `trigger_generate_cashback()`** (Bloco 1 abaixo) antes de ser tratado como fato.

### Assinaturas e `SECURITY DEFINER`/`INVOKER` — já confirmados na rodada anterior
Do catálogo `pg_proc` já coletado:

| Função | Argumentos | Retorno | `SECURITY DEFINER`? |
|---|---|---|---|
| `set_sale_number` | (nenhum) | `trigger` | Não (`INVOKER`) |
| `generate_sale_number` | (nenhum) | `text` | Não (`INVOKER`) |
| `generate_sale_number` | `p_sale_date date` | `text` | Não (`INVOKER`) |
| `trigger_generate_cashback` | (nenhum) | `trigger` | Não (`INVOKER`) |
| `audit_cash_trigger` | (nenhum) | `trigger` | **Sim** |
| `rpc_create_sale` | 16 parâmetros (vigente) | `jsonb` | **Sim** |
| `rpc_create_sale` | 12 parâmetros (`p_accumulate_cashback...`) | `jsonb` | **Sim** |

Nota: `set_sale_number`/`generate_sale_number`/`trigger_generate_cashback` sendo `SECURITY INVOKER` (não `DEFINER`) é relevante — significa que rodam com o privilégio de quem disparou o `INSERT`/`UPDATE` (no caso da app, sempre `service_role`, que já tem privilégio total, então não muda o comportamento prático hoje — mas é uma diferença de padrão em relação às funções `rpc_*`, todas `SECURITY DEFINER`).

---

## Consultas pendentes — ainda não executadas

### Bloco 1 — Corpo completo das funções-alvo (o mais importante desta rodada)
```sql
SELECT
  p.oid,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS security_definer,
  pg_get_functiondef(p.oid) AS full_source
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'set_sale_number', 'generate_sale_number', 'trigger_generate_cashback',
    'generate_cashback_for_sale', 'generate_cashback_for_all_sales'
  )
ORDER BY p.proname, arguments;
```
**O que consulta:** o texto-fonte completo (`pg_get_functiondef`) de cada função, incluindo corpo PL/pgSQL inteiro.
**Por que é necessária:** é a única forma de responder com certeza às perguntas sobre duplicação de cashback e corrida de numeração — nenhuma delas está em nenhuma migration rastreada.
**Carga no banco:** desprezível — leitura de catálogo.
**O que copiar de volta:** o resultado completo, principalmente a coluna `full_source` de cada linha (pode ser longo, mas é essencial — não resuma ao colar).
**Risco de alteração:** nenhum.

### Bloco 2 — Todos os overloads de `rpc_create_sale`, corpo completo
```sql
SELECT
  p.oid,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_function_result(p.oid) AS returns,
  p.prosecdef AS security_definer,
  pg_get_functiondef(p.oid) AS full_source
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'rpc_create_sale'
ORDER BY arguments;
```
**O que consulta:** corpo completo dos dois overloads confirmados de `rpc_create_sale`.
**Por que é necessária:** alimenta diretamente [`rpc-create-sale-overloads-analysis.md`](rpc-create-sale-overloads-analysis.md) — preciso do corpo do overload de 12 parâmetros para saber se ele delega para o de 16 (e portanto herda as correções) ou se tem lógica própria e desatualizada.
**Carga no banco:** desprezível.
**O que copiar de volta:** resultado completo, as duas linhas.
**Risco de alteração:** nenhum.

### Bloco 3 — Definição completa dos triggers (inclui cláusula `WHEN`, essencial e não capturada na rodada anterior)
```sql
SELECT
  c.relname AS tabela,
  t.tgname AS trigger_name,
  t.oid,
  pg_get_triggerdef(t.oid, true) AS full_definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND c.relname IN ('sales', 'cashback_transactions', 'users')
ORDER BY tabela, trigger_name;
```
**O que consulta:** o `CREATE TRIGGER` completo de cada trigger relevante — inclusive a cláusula `WHEN (...)`, se existir, que **não** apareceu na consulta da rodada anterior (que só trazia `information_schema.triggers`, sem a condição).
**Por que é necessária:** se `trg_generate_cashback` tiver uma cláusula `WHEN` (ex.: só dispara quando `status` muda para `'paid'`), isso já responde sozinho boa parte da pergunta sobre se um backfill de `products_total` dispararia o trigger — sem nem precisar ler o corpo da função.
**Carga no banco:** desprezível.
**O que copiar de volta:** resultado completo — são poucas linhas (no máximo ~8 triggers entre as 3 tabelas).
**Risco de alteração:** nenhum.

### Bloco 4 — Constraints e índices de `cashback_transactions` (idempotência)
```sql
SELECT conrelid::regclass AS tabela, conname, contype, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid = 'public.cashback_transactions'::regclass
ORDER BY contype, conname;

SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cashback_transactions';
```
**O que consulta:** se existe alguma `UNIQUE`/`EXCLUDE` constraint ou índice único que impeça duas transações de cashback `type='earn'` para a mesma venda.
**Por que é necessária:** nenhuma migration rastreada documenta uma constraint dessas em `cashback_transactions` — preciso confirmar se a proteção contra duplicidade existe no banco (mesmo padrão de descoberta que já aconteceu com `pedidos_external_id_source_key`, que existia sem estar em nenhuma migration).
**Carga no banco:** desprezível.
**O que copiar de volta:** resultado completo de ambas.
**Risco de alteração:** nenhum.

### Bloco 5 — Permissões de execução (ACL) das funções-alvo
```sql
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.proacl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'set_sale_number', 'generate_sale_number', 'trigger_generate_cashback',
    'generate_cashback_for_sale', 'generate_cashback_for_all_sales',
    'audit_cash_trigger', 'rpc_create_sale'
  )
ORDER BY p.proname;
```
**O que consulta:** a lista de controle de acesso (quem pode executar `EXECUTE` cada função) — se `p.proacl` vier `NULL`, significa que as permissões padrão do Postgres se aplicam (tipicamente, qualquer role com `EXECUTE` no schema `public`, o que geralmente inclui `authenticated` por padrão em projetos Supabase, a menos que revogado explicitamente).
**Por que é necessária:** responde diretamente "o overload antigo pode ser chamado por algum código/integração/RPC genérico" — se `authenticated` tiver `EXECUTE` no overload de 12 parâmetros, **qualquer sessão logada** pode chamá-lo via `supabase.rpc('rpc_create_sale', {...12 chaves...})`, não só `service_role`.
**Carga no banco:** desprezível.
**O que copiar de volta:** resultado completo.
**Risco de alteração:** nenhum.

### Bloco 6 — Confirmação de qual overload a aplicação chama (já resolvido por leitura de código, incluído aqui só para referência cruzada)
**Não é uma consulta SQL** — já confirmado por `grep` no repositório: `src/services/vendas.service.ts` monta o payload de `.rpc('rpc_create_sale', rpcParams)` com as chaves `p_stock_mode`/`p_responsible_seller_id`/`p_payments`/`p_cash_session_id`/`p_card_fee` — que só existem na assinatura de 16 parâmetros. **A aplicação hoje usa exclusivamente a versão vigente.** Nenhum ponto do código de `src/` foi encontrado montando um payload com a forma de 12 parâmetros (`p_accumulate_cashback`). Isso não descarta uso por fora da aplicação (scripts manuais, chamada direta à API do Supabase, um futuro provedor fiscal mal configurado) — só confirma que o código-fonte atual não o faz.

---

**Depois de rodar os Blocos 1-5 e colar os resultados**, poderei fechar definitivamente [`rpc-create-sale-overloads-analysis.md`](rpc-create-sale-overloads-analysis.md), [`cashback-trigger-safety-analysis.md`](cashback-trigger-safety-analysis.md) e [`sale-numbering-concurrency-analysis.md`](sale-numbering-concurrency-analysis.md) — os três documentos abaixo já têm toda a análise possível com o que se sabe hoje, com as lacunas marcadas explicitamente.
