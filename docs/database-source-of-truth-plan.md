# Plano de Fonte de Verdade do Banco de Dados

**Tipo:** determinação factual + plano de baseline futuro, **não executado**. Complementa [`migrations-divergence-analysis.md`](migrations-divergence-analysis.md) com evidência real do banco, coletada em [`fiscal-database-validation-results.md`](fiscal-database-validation-results.md). Nenhuma migration foi criada, nenhum arquivo foi movido, apagado ou renomeado. Não consolida nada ainda — apenas determina os fatos e propõe o caminho.

---

## Quais objetos existem no banco e não constam em nenhuma migration confiável

Esta lista **cresceu** em relação à análise anterior (que já sabia que `companies`/`products`/`customers`/`pedidos`/`pedidos_itens` predatam o histórico rastreado). A validação com dados reais confirmou objetos **adicionais**, incluindo alguns **ativos e funcionalmente relevantes**, não só estruturas estáticas:

| Objeto | Tipo | Onde foi confirmado | Rastreado em alguma migration? |
|---|---|---|---|
| `companies`, `products`, `customers`, `pedidos`, `pedidos_itens` (CREATE TABLE original) | Tabela | Análise anterior + confirmado via `information_schema.columns` | Não (nenhuma árvore) |
| `pedidos.nf_status` | Coluna | `information_schema.columns` (Bloco 4/6) | Não |
| `pedidos_external_id_source_key` | Constraint UNIQUE | `pg_constraint` (Bloco 6.1) | Não |
| `set_sale_number()` | Função (trigger) | `pg_proc` + `information_schema.triggers` | Não |
| `generate_sale_number(p_sale_date date)` (overload com parâmetro) | Função | `pg_proc` (Bloco 5.5) | Não — só o overload sem parâmetro está em `000_schema_completo.sql` |
| `trigger_generate_cashback()` | Função (trigger) | `pg_proc` + `information_schema.triggers` | Não |
| `trg_set_sale_number`, `trg_generate_cashback` | Triggers | `information_schema.triggers` (Bloco 5.6) | Não (as funções que executam não estão documentadas, logo os triggers também não) |
| `rpc_create_sale` (overload de 12 parâmetros, `p_accumulate_cashback`) | Função | `pg_proc` (Bloco 5.5) — origem rastreada **parcialmente**: `20260522_rpc_create_sale_cash_session.sql`, `20260522_rpc_create_sale_payments.sql`, `20260610_multi_estoque.sql` o criam/recriam, mas nenhuma migration posterior a 10/06 o toca | Parcialmente — criado em migrations conhecidas, mas o estado atual do seu corpo (se ainda reflete alguma dessas 3 versões) não é confirmável sem ler o `pg_proc` diretamente |
| `audit_log` (singular, distinto de `audit_logs` plural) | Tabela | `pg_class`/`pg_policies` (Bloco 5.2/5.9) — 4.577 linhas | Provavelmente `archive/001_rls_and_audit.sql` (mesma origem das policies antigas `USING(true)` que também nunca foram documentadas como removidas) — não confirmado com leitura direta do arquivo nesta rodada |
| Policies `authenticated_full_access` em ~15 tabelas | RLS Policy | `pg_policies` (Bloco 3.2/5.9) | Origem provável idêntica à de `audit_log` — mesmo padrão de "nunca dropado", não confirmado individualmente por arquivo nesta rodada |

**Padrão geral confirmado:** não é só o schema-base (as 5 tabelas centrais) que predata o histórico — **funções e triggers que mutam dados de negócio ativamente, hoje** (numeração de venda, geração de cashback) também o fazem. Isso é mais sério do que a conclusão da análise anterior, que tratava a lacuna como majoritariamente estrutural/estática (colunas, constraints). Agora há **lógica de negócio ativa e não documentada**.

## Quais objetos constam em migrations, mas não existem no banco (ou não puderam ser confirmados)

Nenhum objeto foi confirmado como "existe em migration mas ausente do banco real" nesta rodada — a direção do problema, em todos os casos encontrados, foi a oposta (banco tem mais do que as migrations documentam), não menos. Isso é parcialmente uma limitação do escopo das consultas rodadas (nenhuma delas foi desenhada para detectar "migration aplicada mas depois desfeita manualmente") — não deve ser lido como "está tudo coberto na direção contrária", apenas como "nenhuma evidência do contrário apareceu com as consultas rodadas até agora".

## Qual função de criação de venda está realmente instalada

**Duas, simultaneamente:**
1. `rpc_create_sale(p_customer_id int, p_seller_id uuid, p_payment_method payment_method, p_sale_origin text, p_discount_amount numeric, p_cashback_used numeric, p_shipping_charged numeric, p_notes text, p_items jsonb, p_system_user_id uuid, p_card_fee numeric, p_surcharge_amount numeric, p_payments jsonb, p_cash_session_id bigint, p_stock_mode text, p_responsible_seller_id int)` — a versão vigente, correspondente a `20260704_fix_cashback_expiry_and_earn.sql`, usada pela aplicação hoje.
2. `rpc_create_sale(p_accumulate_cashback boolean, p_cashback_used numeric, p_customer_id integer, p_discount_amount numeric, p_items jsonb, p_notes text, p_payment_method text, p_sale_origin text, p_seller_id uuid, p_shipping_charged numeric, p_surcharge_amount numeric, p_system_user_id uuid)` — um wrapper de compatibilidade de 12 parâmetros, criado deliberadamente em maio de 2026, aparentemente não atualizado desde `20260610_multi_estoque.sql`. Não confirmado se ainda é chamado por algo, nem se seu corpo interno ainda delega corretamente para a versão vigente.

Isso responde à pergunta de forma mais precisa do que "qual está instalada" — **ambas estão**, e qualquer trabalho futuro (inclusive o módulo fiscal) que precise garantir que só um caminho de criação de venda existe precisa lidar com essa dualidade, não presumir que só a versão de 16 parâmetros pode ser chamada.

## Quais arquivos não devem mais ser usados como fonte de verdade

Reafirmado e reforçado por esta rodada: **`src/lib/db/migrations/000_schema_completo.sql`** continua sendo o arquivo a não usar como referência — os erros já documentados (unicidade de `products.sku`, tabelas `pedidos`/`pedidos_itens` ausentes) permanecem verdadeiros, e esta rodada não encontrou nenhum motivo para revisar essa conclusão. **Nenhum arquivo novo entra nesta lista** — os achados desta rodada (numeração via trigger, segunda função de cashback, wrapper de 12 parâmetros) não são casos de "arquivo errado", são casos de **"nenhum arquivo existe"** — uma categoria de problema diferente e, para fins de fonte de verdade, mais grave: não há nem uma referência errada para corrigir, há um vazio completo.

## Como criar futuramente um baseline sem apagar o histórico (proposta, não executada)

A estratégia já proposta em `migrations-divergence-analysis.md` §9 (gerar um snapshot via `pg_dump --schema-only`, rotulado como gerado/não editável à mão) continua válida e agora está **reforçada com prioridade maior**, por dois motivos novos:
1. O escopo do que falta documentar é maior do que se sabia (funções/triggers ativos, não só tabelas estáticas).
2. Pelo menos um desses objetos não documentados (`trigger_generate_cashback`) é uma **possível fonte de bug de correção financeira** (duplicação de cashback) que só pode ser descartada ou confirmada lendo o corpo da função — o que reforça que ler o banco real deixou de ser "boa prática recomendada" e passou a ser **necessário** antes de qualquer trabalho subsequente que toque `rpc_create_sale`, `sales`, ou cashback.

**Passos propostos, em ordem, nenhum executado:**
1. Rodar as consultas de `pg_get_functiondef` já propostas em `fiscal-database-validation-results.md` Seção 5, para ler o corpo de `set_sale_number`, `generate_sale_number(date)`, `trigger_generate_cashback`, e (se ainda não lido) o corpo completo do wrapper de 12 parâmetros de `rpc_create_sale`.
2. Gerar `pg_dump --schema-only` (ou usar as consultas de `information_schema`/`pg_catalog` já existentes em `fiscal-audit-readonly.sql` Seções 4-5) como snapshot completo e datado.
3. Salvar como artefato gerado, não editável à mão (ex. `docs/schema-snapshot-<data>.sql`), com cabeçalho explícito de proveniência.
4. Comparar o snapshot com `000_schema_completo.sql` para produzir a lista completa e definitiva de divergências (não só as já descobertas por acidente).
5. Decidir, com autorização própria e separada, o destino de `src/lib/db/migrations/` (manter com aviso, arquivar, ou remover).

## Como registrar as migrations já aplicadas

Não é possível, com o que foi coletado até agora, reconstruir uma lista confiável de "quais das ~150 migrations das duas árvores foram de fato aplicadas ao banco real, em que ordem" — nenhuma das consultas rodadas consultou uma tabela de controle de migrations (ex. `supabase_migrations.schema_migrations`, convenção padrão do CLI do Supabase, que não foi verificada nesta rodada por não estar no escopo original do `fiscal-audit-readonly.sql`). **Proposta de consulta de acompanhamento, não executada:**
```sql
-- Verificar se existe uma tabela de controle de migrations do Supabase CLI
SELECT schemaname, tablename FROM pg_tables
WHERE tablename ILIKE '%migration%' OR schemaname = 'supabase_migrations';
```
Se essa tabela existir e estiver populada, ela é a fonte mais confiável de "o que foi realmente aplicado, e quando" — mais confiável até do que inspecionar o schema resultante, porque preserva a ordem histórica real. Isso não foi verificado nesta rodada e fica como próximo passo natural antes de qualquer trabalho de consolidação.

---

**Nenhuma consolidação foi feita.** Este documento apenas atualiza a determinação factual com base nos dados reais recebidos, e refina a proposta já existente — a decisão de executar qualquer parte dela continua pendente de autorização separada.
