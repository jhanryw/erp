# Análise dos Overloads de `rpc_create_sale`

**Tipo:** análise com o que já é confirmável hoje + lacunas explícitas que dependem do Bloco 2 de [`database-functions-live-analysis.md`](database-functions-live-analysis.md) (ainda não executado). Nenhuma função foi executada nesta análise — apenas leitura de catálogo (rodada anterior) e leitura de código-fonte (esta rodada).

---

## Overload 1 — versão vigente (16 parâmetros)

| Campo | Valor |
|---|---|
| Assinatura | `p_customer_id int, p_seller_id uuid, p_payment_method payment_method, p_sale_origin text, p_discount_amount numeric, p_cashback_used numeric, p_shipping_charged numeric, p_notes text, p_items jsonb, p_system_user_id uuid, p_card_fee numeric, p_surcharge_amount numeric, p_payments jsonb, p_cash_session_id bigint, p_stock_mode text, p_responsible_seller_id int` |
| Retorno | `jsonb` |
| `SECURITY DEFINER` | Sim |
| OID | **Pendente** — Bloco 2 |
| Corpo completo | **Já lido diretamente do repositório**, `supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql` — é a última migration que redefine `rpc_create_sale` (confirmado por `grep -rlE "CREATE (OR REPLACE )?FUNCTION public\.rpc_create_sale\b" supabase/migrations/*.sql`, ordenado, sem nenhuma entrada posterior a essa data em nenhuma das 110 migrations) |
| Origem/data | `20260704_fix_cashback_expiry_and_earn.sql` (04/07/2026), base declarada: `20260627_rpc_create_sale_v4.sql` |
| Chamadas no código | **Confirmado**: `src/services/vendas.service.ts` → `.rpc('rpc_create_sale', rpcParams)`, payload com chaves exclusivas desta assinatura (`p_stock_mode`, `p_responsible_seller_id`, `p_payments`, `p_cash_session_id`, `p_card_fee`) |
| Dependências | Lidas diretamente no corpo já conhecido: `generate_sale_number()` (via `DEFAULT` da coluna `sale_number`, embora o mecanismo real de numeração pareça ser via trigger — ver `sale-numbering-concurrency-analysis.md`), `consume_stock_fifo`/lógica de débito de estoque por `stock_balances`, `cashback_transactions` (INSERT direto de `earn`), `sale_payments` (INSERT em loop), `finance_entries` (INSERT condicional se `v_total > 0`) |
| Permissões (`GRANT EXECUTE`) | **Pendente** — Bloco 5. Confirmado por leitura de código que versões anteriores concediam `GRANT EXECUTE ... TO service_role, authenticated` (ex. `20260613_shipping_fiscal_ready.sql:487-489`) — se esse padrão se manteve, **qualquer sessão `authenticated` pode chamar esta função diretamente**, não só o backend via `service_role`. Isso é consistente com o desenho do sistema (a aplicação chama a RPC como o próprio usuário logado em alguns contextos), mas precisa confirmação exata. |
| Sofre a regressão de `products_total`? | **Sim, confirmado** — é exatamente a versão analisada em `products-total-regression-analysis.md`; não grava a coluna. |

## Overload 2 — wrapper de compatibilidade (12 parâmetros)

| Campo | Valor |
|---|---|
| Assinatura | `p_accumulate_cashback boolean, p_cashback_used numeric, p_customer_id integer, p_discount_amount numeric, p_items jsonb, p_notes text, p_payment_method text, p_sale_origin text, p_seller_id uuid, p_shipping_charged numeric, p_surcharge_amount numeric, p_system_user_id uuid` |
| Retorno | `jsonb` |
| `SECURITY DEFINER` | Sim |
| OID | **Pendente** — Bloco 2 |
| Corpo completo | **Pendente** — Bloco 2. Três candidatos de origem já identificados no repositório (ver linha seguinte); não sei ainda qual (se algum) corresponde ao corpo realmente vigente no banco |
| Origem/data — candidatos rastreados | Recriado (`CREATE OR REPLACE FUNCTION public.rpc_create_sale(p_accumulate_cashback boolean, ...)`) em três migrations, em ordem cronológica: `20260522_rpc_create_sale_cash_session.sql:397-398`, `20260522_rpc_create_sale_payments.sql:392-393`, `20260610_multi_estoque.sql:858-859`. **Nenhuma migration posterior a 10/06/2026 toca esta assinatura** (`grep -rn "p_accumulate_cashback" supabase/migrations/*.sql` não retorna nada após `20260610_multi_estoque.sql`) — o candidato mais provável de ser o corpo vigente é o de `20260610_multi_estoque.sql:858+`, por ser o mais recente dos três, mas **isso só será confirmado comparando o texto retornado pelo Bloco 2 contra os três arquivos** |
| Propósito declarado | Comentário original (`20260522_rpc_create_sale_cash_session.sql:14,23`): *"Assinatura do wrapper de compatibilidade (p_accumulate_cashback)... O wrapper (12-param com p_accumulate_cashback) não muda — chama a nova função."* — ou seja, **foi desenhado para ser um proxy fino**, não uma implementação paralela |
| Chamadas no código | **Nenhuma encontrada** em `src/` — `grep -rn "p_accumulate_cashback" src/` → zero resultados |
| Dependências | **Pendente** — depende de ler o corpo (Bloco 2) para saber se de fato delega para o overload de 16 parâmetros (como o comentário original promete) ou se tem lógica própria |
| Permissões (`GRANT EXECUTE`) | **Pendente** — Bloco 5 |
| Sofre a regressão de `products_total`? | **Indeterminado sem o corpo.** Se delega para o overload de 16 parâmetros (como projetado), herda automaticamente a mesma ausência de `products_total`. Se tem lógica própria congelada em 10/06/2026 (antes até da criação do campo em 13/06), nunca teve `products_total` para começar — o efeito prático (campo ausente) seria o mesmo, mas por um motivo diferente, relevante para decidir a correção (corrigir só o overload de 16 parâmetros não bastaria se este outro também precisar de ajuste separado) |

---

## Respostas às perguntas específicas do usuário

**Qual overload a aplicação atual chama?** O de 16 parâmetros — confirmado por leitura de código (`src/services/vendas.service.ts`), não por suposição.

**Se o overload antigo ainda pode ser chamado por algum código, integração ou RPC genérico?** Tecnicamente sim, por **qualquer** cliente com uma credencial válida (`service_role` certamente; `authenticated` também, se a permissão não tiver sido revogada — pendente confirmação no Bloco 5) que monte a chamada `supabase.rpc('rpc_create_sale', {...as 12 chaves exatas...})`. Nada no banco impede isso — overloads de função no Postgres coexistem livremente, e o Supabase resolve qual overload chamar pela correspondência exata do conjunto de chaves enviado. **Nenhum código no repositório faz isso hoje**, mas a superfície de chamada continua aberta para qualquer cliente externo (script manual, ferramenta de terceiros, erro futuro de desenvolvimento) que desconheça essa armadilha.

**Se o overload antigo possui comportamento diferente?** **Pendente** — depende do Bloco 2. Diferenças estruturais já visíveis pela assinatura, independentemente do corpo: não tem `p_payments` (não suporta múltiplos pagamentos por venda — só o `p_payment_method` legado, como `text`, não como o enum `payment_method`), não tem `p_stock_mode` (comportamento de débito de estoque indeterminado — usaria algum padrão implícito, ou falharia, dependendo do corpo), não tem `p_cash_session_id` (venda não vinculada a sessão de caixa), não tem `p_responsible_seller_id`, não tem `p_card_fee`. Mesmo que delegue internamente, **precisa ser confirmado como esses parâmetros ausentes são supridos** (valores default fixos? omitidos, quebrando a chamada interna?).

**Pode ser removido futuramente sem quebrar o ERP?** **Alta probabilidade de sim**, dado que nenhum código de aplicação o referencia — mas a recomendação formal é: **não remover sem antes** (a) confirmar via Bloco 5 se `authenticated`/outras roles têm `EXECUTE` nele (se sim, precisa avaliar se alguma integração externa pode depender disso, mesmo sem estar no repositório do ERP), e (b) confirmar via Bloco 2 se ele delega corretamente hoje — se estiver quebrado internamente (chamando algo que não existe mais, por exemplo), isso é evidência adicional a favor de removê-lo, não contra. **Esta remoção não foi executada e não deve ser executada sem autorização própria e separada, com plano de rollback** (recriar a partir do texto capturado pelo Bloco 2, que ficaria preservado neste documento como registro).

---

## Resumo executivo desta análise (para a resposta final do usuário)

**Não é possível ainda dizer com certeza se o overload antigo tem comportamento diferente na prática** — a assinatura por si só já mostra que ele não suporta recursos adicionados depois de 10/06/2026 (multi-pagamento, modo de estoque, sessão de caixa, vendedor responsável), mas sem o corpo (Bloco 2 pendente) não dá para confirmar se ele delega de forma segura para a versão nova ou executa lógica própria e desatualizada. É seguro afirmar que **a aplicação atual não o usa**, e que ele é **tecnicamente alcançável** por qualquer cliente com credencial válida.
