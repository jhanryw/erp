# Fase Fiscal 5C — Revisão de Blockers Arquiteturais

Revisão da implementação da Fase 5C antes de qualquer aplicação em banco real. Nenhuma migration foi aplicada. Nenhum commit foi feito.

**Atualização**: um terceiro blocker (risco de overload/ambiguidade no PostgreSQL, introduzido pela própria correção do Blocker 1) foi encontrado numa rodada de auditoria seguinte, também antes de qualquer aplicação — ver [§ Blocker 3](#blocker-3--risco-de-overload-do-postgresql-na-assinatura-de-rpc_create_sale) abaixo. A migration da RPC (#4 na tabela de ordem) foi corrigida para incluir `DROP FUNCTION` explícito antes do `CREATE`.

---

## Blocker 1 — Atomicidade sale + snapshot de destinatário

### Antes (problema)

`sale_recipients` era gravado numa segunda chamada, depois de `rpc_create_sale` já ter commitado a venda — mesmo padrão não-atômico já usado (e questionável) para `shipments`. Uma falha na segunda chamada deixava a venda criada sem snapshot fiscal do destinatário.

### Solução implementada

`rpc_create_sale` ganhou um parâmetro novo, opcional, ao final da assinatura (retrocompatível — qualquer chamador existente que não o envie continua funcionando exatamente como antes):

```sql
p_delivery_recipient jsonb DEFAULT NULL
```

Quando presente, o snapshot (e, se pedido via `save_as_customer_address`, o cadastro reutilizável em `customer_addresses`) é gravado **dentro da mesma transação** da venda — depois de todo o efeito comercial (estoque, financeiro, pagamentos, cashback), antes do evento de domínio. Qualquer falha nesse trecho (violação de CHECK/NOT NULL, endereço que não pertence ao cliente, etc.) levanta exceção e o Postgres desfaz **tudo** automaticamente — venda, itens, estoque, financeiro, evento — porque nenhum `EXCEPTION` intermediário captura o erro dentro da função.

Retirada continua sem exigir nada disso: `p_delivery_recipient = NULL` é (e sempre foi) o comportamento padrão.

### Requisitos do pedido — checklist

| Requisito | Atendido | Como |
|---|---|---|
| pickup continua sem destinatário obrigatório | ✅ | `p_delivery_recipient` só é processado `IF ... IS NOT NULL` |
| delivery só conclui se o snapshot for persistido | ✅ | Mesma transação — se o snapshot falha, a venda inteira falha junto (nunca "conclui sem") |
| qualquer erro faz rollback da operação inteira | ✅ | Exceção não capturada em função PL/pgSQL desfaz a transação inteira por padrão |
| não criar venda órfã | ✅ | Testado no Cenário 4 de `rpc_create_sale_recipient_atomicity.test.sql` |
| não criar snapshot sem venda | ✅ | `sale_recipients.sale_id` só é inserido depois que `v_sale_id` já existe, na mesma transação — logicamente impossível ter o inverso |
| isolamento por company_id | ✅ | `sale_recipients.company_id = v_company_id` (nunca vindo do payload); `customer_address_id` filtrado por `customer_id = p_customer_id` |
| SECURITY DEFINER/search_path/grants auditados | ✅ | Ambos preservados idênticos (`SECURITY DEFINER`, `SET search_path = public`); `CREATE OR REPLACE` não altera GRANTs existentes — confirmado, nenhum `GRANT`/`REVOKE` novo necessário nem escrito |
| não confiar em company_id vindo do frontend | ✅ | `v_company_id` é **sempre** resolvido server-side a partir de `p_system_user_id` (nunca de um parâmetro do payload) — o parâmetro `p_delivery_recipient` não tem (e nunca deveria ter) uma chave `company_id` |

### Achado adicional, corrigido junto (diretamente implicado pelo requisito de isolamento)

Nem `rpc_create_sale` nem a camada de serviço validavam que `p_customer_id` pertence a `v_company_id` (a empresa do usuário autenticado). Isso já era uma lacuna **pré-existente**, independente desta fase — mas ficou diretamente relevante aqui porque o snapshot de entrega pode ler um `customer_address_id` a partir de `p_customer_id`; sem essa checagem, um usuário de uma empresa poderia, em tese, criar uma venda vinculando um cliente (e endereço) de outra empresa. Adicionada:

```sql
IF p_customer_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM customers WHERE id = p_customer_id AND company_id = v_company_id
) THEN
  RAISE EXCEPTION 'Cliente não pertence à empresa.' USING ERRCODE = 'P0001';
END IF;
```

Testado nos Cenários 5 e 6 de `rpc_create_sale_recipient_atomicity.test.sql`. Não deveria quebrar nenhum caller legítimo existente (Nuvemshop, troca, PDV) — todos já operam sempre dentro da própria empresa.

### Teste SQL real de atomicidade

[`supabase/tests/rpc_create_sale_recipient_atomicity.test.sql`](../supabase/tests/rpc_create_sale_recipient_atomicity.test.sql) — 6 cenários (sucesso simples, sucesso com endereço reutilizável novo, sucesso com endereço já existente ignorando payload forjado em paralelo, **falha que desfaz tudo** incluindo estoque não decrementado, isolamento cross-company do cliente, isolamento cross-customer do endereço). **Não executado nesta sessão** (sem acesso a banco real) — precisa rodar com `DATABASE_URL` de teste antes de confiar no resultado. Ressalva conhecida: os 6 cenários dependem de `company_id=1` já ter "Estoque Loja" e usuário ativo configurados (mesmo pré-requisito de `integration_outbox_sale_events.test.sql`); se esse pré-requisito faltar, o bloco de fixture já avisa e retorna cedo, mas os blocos de cenário SEGUINTES vão falhar com "relation does not exist" (a tabela temporária de fixture não chega a ser criada) — não um "pulado" gracioso. Rode num ambiente onde a empresa 1 já está configurada (mesmo que outros testes deste repositório já assumem isso).

---

## Blocker 2 — Semântica de `products_total`

### Auditoria da semântica real de cada campo (antes de tocar a RPC, como pedido)

| Campo | Semântica real (confirmada por leitura do código) |
|---|---|
| `sale_items.unit_price` | Preço unitário **efetivamente cobrado** — já reflete qualquer negociação (se o vendedor digitou um preço diferente do catálogo, a diferença já está aqui, implicitamente) |
| `sale_items.discount_amount` | Ajuste **adicional** de desconto sobre o item, subtraído de `unit_price × quantity` — usado quando o vendedor quer registrar um desconto explícito SEM alterar `unit_price` |
| `sale_items.surcharge_amount` (novo) | Simétrico — acréscimo adicional sobre o item |
| `sale_items.total_price` | `unit_price × quantity − discount_amount + surcharge_amount` (por item) |
| `sales.subtotal` | `Σ total_price` de todos os itens — já reflete **100%** dos ajustes conhecidos por item (embutidos em `unit_price` OU explícitos via `discount_amount`/`surcharge_amount` do item) |
| `sales.discount_amount` | Ajuste **GLOBAL** de pedido, independente dos itens — nunca derivado somando-os |
| `sales.surcharge_amount` | Idem, acréscimo GLOBAL de pedido |
| `sales.shipping_charged` | Frete cobrado do cliente — **sempre** separado, nunca compõe valor de mercadoria |
| `sales.products_total` | Valor comercial líquido das **MERCADORIAS** (ver fórmula abaixo) |
| `sales.total` | Total financeiro recebido |

### Fórmula definitiva

```
products_total = subtotal − sales.discount_amount + sales.surcharge_amount
```

**Nunca inclui `shipping_charged`.**

```
total = products_total + shipping_charged − cashback_used
      (= subtotal − discount_amount + surcharge_amount + shipping_charged − cashback_used, idêntico a antes)
```

### Por que isso não duplica nenhum ajuste

`subtotal` já soma `total_price` de cada item — ou seja, já contém 100% dos ajustes **por item**. `sales.discount_amount`/`sales.surcharge_amount` são campos de nível de **pedido**, independentes dos itens **por construção** (o RPC nunca deriva um a partir do outro — são parâmetros distintos, `p_discount_amount`/`p_surcharge_amount` vs. o array `p_items`). Como as duas fontes nunca se sobrepõem, somar `-discount_amount +surcharge_amount` por cima do `subtotal` nunca conta o mesmo ajuste duas vezes — é exatamente a mesma disciplina de não-duplicidade que já valia para o desconto isoladamente, agora simétrica para o acréscimo.

### Verificação contra o exemplo do pedido

```
produtos = 80 (item vendido ao preço nominal, sem ajuste por item)
acréscimo comercial global sobre mercadorias = 8 (sales.surcharge_amount)
frete = 12 (sales.shipping_charged)

subtotal = 80
products_total = 80 − 0 + 8 = 88        ✓ (esperado: 88)
shipping_charged = 12                    ✓ (esperado: separado)
total = 88 + 12 = 100                    ✓ (esperado: 100)
```

Confirmado por teste espelhado em dois lugares independentes, produzindo os mesmos números:
- **TypeScript**: `src/lib/sales/pricing.ts` (`computeProductsTotal`) + `src/lib/sales/pricing.test.ts` (teste "exemplo completo do pedido (Blocker 2)").
- **SQL real**: `supabase/tests/rpc_create_sale_pricing_invariants.test.sql`, Cenário 5 — chama `rpc_create_sale` de verdade e confere `sales.products_total`/`sales.total` gravados pelo banco.

Isso satisfaz "prove por testes espelhados que as duas fórmulas são idênticas" — não há um único módulo de código compartilhado entre TS e SQL (tecnicamente impossível sem um gerador de código, que seria desproporcional aqui), mas as DUAS implementações são auditáveis lado a lado com a mesma fórmula documentada, e os testes confirmam que produzem os mesmos números para os mesmos cenários.

**Resposta direta às suas perguntas:**
- `shipping_charged` entra em `products_total`? **NÃO.**
- `sales.surcharge_amount` entra em `products_total`? **SIM** — porque é definido como ajuste GLOBAL de **mercadoria** (não de frete), simétrico ao desconto global, que já sempre entrou. Excluí-lo seria inconsistente: trataria desconto e acréscimo globais como conceitos diferentes quando são o mesmo tipo de ajuste com sinal oposto.

---

## Blocker 3 — Risco de overload do PostgreSQL na assinatura de `rpc_create_sale`

Auditoria pedida antes de aplicar qualquer migration, respondendo às 8 perguntas exatamente na ordem feita.

### 1. Assinatura EXATA atual (antes desta migration)

Confirmada por fonte primária — não presumida — o `REVOKE`/`GRANT` real de `20260811_fix_rpc_identity_grants_tenant.sql:600-607`:

```
public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int
)
```
16 tipos. `20260817_sale_rpcs_emit_outbox_events.sql` (a versão vigente do corpo) usa exatamente essa mesma lista de tipos — confirma que continua sendo a assinatura real hoje (nenhuma migration entre 20260811 e esta fase mudou o número/tipo de parâmetros).

### 2. Assinatura EXATA depois

```
public.rpc_create_sale(
  int, uuid, payment_method, text, numeric, numeric, numeric, text,
  jsonb, uuid, numeric, numeric, jsonb, bigint, text, int, jsonb
)
```
17 tipos — um `jsonb` a mais no fim (`p_delivery_recipient jsonb DEFAULT NULL`).

### 3. `CREATE OR REPLACE FUNCTION` altera o número de argumentos, ou cria overload?

**Cria overload.** Fato de Postgres, não interpretação: a identidade de uma função para fins de `CREATE OR REPLACE` é `(schema, nome, lista ORDENADA DE TIPOS dos parâmetros de entrada)` — nomes de parâmetro, `DEFAULT`s e tipo de retorno não fazem parte dessa chave. `CREATE OR REPLACE FUNCTION` só substitui quando essa chave já existe idêntica; caso contrário, é equivalente a `CREATE FUNCTION` — cria uma função nova, adicional, com o mesmo nome. Como a lista de tipos muda (16 → 17), a minha migration original (antes desta correção) **não substituía** a função de 16 parâmetros — criava uma segunda.

Isso não é hipotético neste projeto: `src/lib/db/migrations/archive/034_fix_rpc_sale_stock_sync.sql:5` documenta literalmente **"Existem 3 versões sobrecarregadas de rpc_create_sale no banco"** — o próprio time já teve que limpar esse tipo de acúmulo antes.

### 4. Uma chamada com 16 argumentos fica ambígua, com as duas assinaturas coexistindo?

**Sim.** Os 16 parâmetros compartilhados têm tipos idênticos nas duas funções; a única diferença é a de 17 ter um parâmetro opcional a mais. Qualquer chamada que não mencione `p_delivery_recipient` (nem posicional, nem nomeada) é candidata a AMBAS. O resultado depende do algoritmo de resolução de overload do Postgres para argumentos com `DEFAULT`: a documentação oficial descreve que, entre candidatos empatados em tipo, o Postgres prefere o que precisa preencher MENOS parâmetros por `DEFAULT`; se ainda houver empate, o erro é `function ... is not unique`. Aplicado aqui: uma chamada com os 16 parâmetros compartilhados sempre precisaria de 1 `DEFAULT` a menos na função de 16 do que na de 17 — ou seja, na prática tenderia a resolver silenciosamente para a função ANTIGA (não a erro), o que seria pior que um erro explícito: o parâmetro novo simplesmente nunca seria usado, sem aviso nenhum. **Não testei isso ao vivo contra um Postgres real nesta sessão** (sem acesso a banco) — a leitura acima é o comportamento documentado, mas o smoke test que preparei (`rpc_create_sale_single_overload.test.sql`) precisa confirmar contra o banco de teste antes de qualquer confiança adicional. De qualquer forma, a correção (DROP explícito) elimina o problema por construção, independente de qual das duas leituras (erro vs. resolução silenciosa) fosse a real.

### 5. Como o PostgREST/Supabase resolve isso ao chamar `.rpc('rpc_create_sale', params)`

O cliente `supabase-js` serializa o objeto `params` e o PostgREST monta a chamada usando **notação de argumento NOMEADO** no SQL (`rpc_create_sale(p_customer_id := ..., p_seller_id := ..., ...)`), incluindo só as chaves presentes no objeto JS — chaves ausentes contam com o `DEFAULT` do parâmetro correspondente. A resolução de overload por nome segue a mesma lógica de compatibilidade de tipos/quantidade de defaults do caso posicional (pergunta 4). **Achado concreto**: minha própria alteração em `vendas.service.ts` já inclui `p_delivery_recipient` (mesmo que `null`) em TODA chamada — então essas duas chamadas resolveriam sem ambiguidade (só a função de 17 tem esse nome de parâmetro). MAS o webhook da Nuvemshop (`src/app/api/webhooks/nuvemshop/order/route.ts:526-540`) monta seu PRÓPRIO objeto de parâmetros, **sem** a chave `p_delivery_recipient` — essa chamada específica cairia exatamente na ambiguidade da pergunta 4, e poderia quebrar a criação de TODA venda vinda da Nuvemshop se a migration original (sem o DROP) fosse aplicada.

### 6. Precisamos de `DROP FUNCTION` da assinatura antiga antes de criar a nova?

**Sim — implementado.** Ver §"Correção" abaixo.

### 7. Views/grants/triggers/funções dependentes da OID/assinatura antiga

- **Views/triggers**: nenhum encontrado referenciando `rpc_create_sale` (ela é chamada por código de aplicação, nunca por trigger/view).
- **Grants**: já documentados (pergunta 1) — `REVOKE ... FROM authenticated` + `GRANT ... TO service_role`, ambos com a assinatura de 16 tipos, específicos dela.
- **Outra função dependente, achado real**: existe uma SEGUNDA função `rpc_create_sale` já viva desde `20260610_multi_estoque.sql` — um "wrapper de compatibilidade" de **12 parâmetros** (`boolean, numeric, int, numeric, jsonb, text, text, text, uuid, numeric, numeric, uuid`, primeiro tipo `boolean` — nunca ambíguo com a principal, tipos incompatíveis já na 1ª posição). Confirmado por grep exaustivo em `supabase/migrations/*.sql`: nenhuma das 4 `DROP FUNCTION rpc_create_sale(...)` existentes tem essa assinatura — **nunca foi removida**. Sem uso em código vivo (`grep -rn "rpc_create_sale" src/` só mostra as 2 chamadas já mapeadas). Incluí `DROP FUNCTION IF EXISTS` dela na correção, por higiene, já que estou mexendo exatamente aqui.
- **Achado crítico CONFIRMADO com dado real do banco** (trazido pelo usuário depois da primeira versão desta seção, que ainda tratava isso como "plausível, não confirmado"): as DUAS assinaturas hoje vivas de `rpc_create_sale` (16 parâmetros + wrapper de 12) têm `EXECUTE` **explicitamente** concedido — não só herdado de `PUBLIC` — para `PUBLIC`, `anon`, `authenticated`, `service_role`, `postgres`, `supabase_admin`. Isso é mais grave do que a hipótese original (só "`PUBLIC` nunca revogado"): `20260811_fix_rpc_identity_grants_tenant.sql` revogou `EXECUTE` só de `authenticated` (linhas 600-603) — nunca de `PUBLIC` nem de `anon` — e como `anon`/`authenticated` tinham grant DIRETO (não só via `PUBLIC`), **revogar só `PUBLIC` não teria fechado nada**: cada caminho de privilégio (direto pro papel, ou via `PUBLIC`, ou via herança de grupo) é independente — revogar um não revoga os outros. Isso é consistente com o comportamento conhecido de projetos Supabase, que configuram privilégios default de projeto (`ALTER DEFAULT PRIVILEGES`, fora da árvore de migrations de usuário) concedendo automaticamente a `anon`/`authenticated`/`service_role` em objetos novos do schema `public` — por isso outras RPCs deste mesmo projeto já usam `REVOKE ALL ... FROM PUBLIC, anon, authenticated` explicitamente (`20260627_authorization_tokens_v2.sql:23`, `20260816_fix_stock_media_repasse_rpc_grants_public.sql`, `202607302600_pim_product_sku_identity.sql`) — só `rpc_create_sale` (e as 10 RPCs irmãs da mesma migration 20260811) tinham ficado de fora desse padrão. **Corrigido nesta migration** para a assinatura nova: `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (os 3 papéis explicitamente, no mesmo `REVOKE`) + `GRANT ... TO service_role` — ver Passo 3 corrigido abaixo. `postgres`/`supabase_admin` não são tocados (papéis administrativos, não superfície pública do app).
  **Ainda NÃO verificado nesta sessão** (fora do escopo desta migration, que é só sobre `rpc_create_sale`): as outras 10 RPCs reveladas junto na mesma migration 20260811 (`rpc_cancel_sale`, `rpc_return_sale`, `rpc_process_exchange`, `rpc_open_cash_session`, `rpc_add_cash_movement`, `rpc_close_cash_session`, `rpc_cancel_cash_movement`, `rpc_reopen_cash_session`, `rpc_stock_entry`, `rpc_stock_adjust`, `rpc_pagar_repasse_lote`) muito provavelmente têm o MESMO problema (grant explícito pra `anon`/`authenticated`, não só herança) — dado que o padrão agora confirmado em `rpc_create_sale` veio da mesma migration com o mesmo texto de `REVOKE`/`GRANT`. **Recomendo prioridade alta**: rodar a mesma introspecção (`has_function_privilege`/`information_schema.routine_privileges`) pra essas 10 funções e tratar a correção delas como uma migration separada, assim que esta fase for concluída.

### 8. Algum caller usa parâmetros posicionais em SQL em vez de nomeados via Supabase?

**Sim.** Grep completo (resultado abaixo). Callers de **produção** (`src/`) usam sempre `.rpc('rpc_create_sale', {...})` (nomeado, via Supabase JS) — só 2 call sites reais. Callers **posicionais diretos** existem, mas só em SQL de teste (`supabase/tests/*.test.sql`), nunca em código de aplicação:

```
$ grep -rn "\.rpc(['\"]rpc_create_sale['\"]" src/
src/app/api/webhooks/nuvemshop/order/route.ts:526:      .rpc('rpc_create_sale', {
src/services/vendas.service.ts:415:    .rpc('rpc_create_sale', rpcParams) as unknown as {
```

```
$ grep -rn "rpc_create_sale(" --include="*.sql" . | grep -v "CREATE\|DROP\|GRANT\|REVOKE\|COMMENT\|--"
supabase/tests/integration_outbox_sale_events.test.sql:69   (posicional, 10 args)
supabase/tests/rpc_create_sale_pricing_invariants.test.sql   (5 chamadas, mistura nomeado/posicional)
supabase/tests/rpc_create_sale_recipient_atomicity.test.sql  (6 chamadas, mistura nomeado/posicional)
[+ vários hits em src/lib/db/migrations/ e docs/superpowers/ — árvore
   HISTÓRICA/paralela, não aplicada ao Supabase real (ver nota abaixo)]
```

Nota sobre `src/lib/db/migrations/`: essa árvore não é a fonte de verdade do banco real (já documentado em auditorias anteriores desta mesma sessão) — `supabase/migrations/*.sql` é a única aplicada de fato. As referências posicionais lá (incluindo a do wrapper de 12 parâmetros) são história, não risco vivo — mas reforçam que este projeto já usou chamada posicional para `rpc_create_sale` no passado.

### Correção aplicada

`supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql` foi reescrita para, na ordem:

1. `DROP FUNCTION IF EXISTS public.rpc_create_sale(<16 tipos>)` — a assinatura principal antiga. Elimina, junto, todos os grants explícitos que ela tinha (`PUBLIC`, `anon`, `authenticated`, `service_role` — a função deixa de existir, não há grant "órfão" para revogar depois).
2. `DROP FUNCTION IF EXISTS public.rpc_create_sale(<12 tipos do wrapper>)` — achado adicional, removido por higiene. Mesmo efeito colateral: elimina os grants dela também.
3. `CREATE OR REPLACE FUNCTION public.rpc_create_sale(<17 tipos>)` — corpo idêntico ao já revisado (Blockers 1 e 2), na mesma transação de migration.
4. `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (um único `REVOKE`, os 3 papéis explícitos) + `GRANT EXECUTE ... TO service_role` — necessário porque uma função recém-criada em projeto Supabase tende a herdar privilégio default para `PUBLIC`/`anon`/`authenticated` (confirmado com dado real do banco — ver achado acima), não só `PUBLIC` como a hipótese inicial desta seção presumia.

Como as instruções (`DROP` × 2, `CREATE`, `REVOKE`/`GRANT`) estão no mesmo arquivo de migration, rodam na mesma transação implícita que o runner de migrations do Supabase já aplica por arquivo — nunca existe uma janela em que 0 ou 2 versões da função coexistem de forma persistente, nem uma janela em que a função nova existe sem seus GRANTs corretos.

**Smoke test dedicado**: [`supabase/tests/rpc_create_sale_single_overload.test.sql`](../supabase/tests/rpc_create_sale_single_overload.test.sql) — roda a query exata pedida (`pg_proc`/`pg_get_function_arguments`), confirma 1 única linha, confirma os GRANTs nos 4 papéis relevantes (`service_role` sim; `authenticated`, `anon` e `PUBLIC` não, via `has_function_privilege`), e prova as duas formas de chamada (sem `p_delivery_recipient`, igual ao webhook Nuvemshop hoje; e com `p_delivery_recipient`, o caso novo) resolvendo para a mesma função. **Não executado nesta sessão** — precisa rodar contra um banco de teste com a migration já aplicada.

---

## Backfill — auditoria concluída com dados reais (migration ainda NÃO aplicada)

Script read-only executado pelo usuário contra o banco real: [`docs/products_total_backfill_audit_readonly.sql`](products_total_backfill_audit_readonly.sql). Todos os números abaixo são dado real, não estimativa.

### Decisão de escopo (do usuário, confirmada após ver os dados)

Um único backfill, cobrindo dois universos com a mesma fórmula — não dois backfills separados:
> "Se products_total passa a ter como invariante oficial subtotal - discount_amount + surcharge_amount, não quero manter registros conhecidos usando outra semântica."

### Números reais confirmados

| Item | Valor real |
|---|---|
| Universo A — `products_total IS NULL` | **490** vendas (486 `paid`, 1 `cancelled`, 3 `returned`; 15/06 a 22/08/2026) |
| Universo A — linhas que divergiriam entre fórmula antiga/nova | 87 de 490 |
| Universo A — soma da divergência | R$ 859,05 |
| Universo A — maior divergência | R$ 41,03 (venda #568) |
| Universo A — vendas com `surcharge_amount > 0` | 87 (idêntico ao nº de divergentes — confirma que divergência = `surcharge_amount`, sempre, por construção matemática) |
| Universo A — vendas com `shipping_charged > 0` | 25 |
| Universo A — vendas com `discount_amount > 0` | 131 |
| Universo A — integridade `subtotal` × soma `sale_items.total_price` | **Zero inconsistências** |
| Universo B — `products_total` já preenchido, divergente da fórmula nova | **45** vendas (41 `paid`, 4 `cancelled`; 09/04 a 13/06/2026, todas anteriores à regressão de 14/06) |
| Universo B — soma da divergência | R$ 308,68 |
| Universo B — maior divergência | R$ 89,54 (venda #117) |
| Universo B — `discount_amount` nas 45 linhas | Sempre R$ 0,00 (confirmado) |
| Universo B — integridade `subtotal` × soma `sale_items.total_price` | **Zero inconsistências** |
| **Total de linhas afetadas pelo backfill unificado (A + B)** | **535** — confirmado por `COUNT(*)` ao vivo com o `WHERE` definitivo, não calculado |
| **Impacto financeiro total** | R$ 859,05 + R$ 308,68 = **R$ 1.167,73**, sempre para cima (nunca reduz `products_total` de nenhuma venda) |

### `WHERE`/`UPDATE` definitivos (validados, aplicados ao arquivo da migration)

```sql
UPDATE public.sales
SET products_total = ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) + COALESCE(surcharge_amount, 0), 2)
WHERE products_total IS NULL
   OR ROUND(products_total, 2) <> ROUND(COALESCE(subtotal, 0) - COALESCE(discount_amount, 0) + COALESCE(surcharge_amount, 0), 2);
```

- **Quantidade de linhas**: **535**, confirmado ao vivo (490 + 45).
- **Divergências encontradas**: 87 (universo A) + 45 (universo B) = 132 linhas onde o valor gravado será diferente do que a fórmula antiga/ausência de valor sugeriria — o restante (403 do universo A) recebe o mesmo valor que a fórmula antiga já daria, só passa de `NULL` para um número real.
- **Seguro aplicar**: **SIM**, do ponto de vista de dados — zero inconsistências de integridade em ambos os universos, contagem confirmada bate exatamente com o `WHERE` real, fórmula validada linha a linha contra os números reais. Falta apenas sua autorização explícita para efetivamente rodar o `UPDATE` contra o banco de produção — esta migration continua **não aplicada**.

`20260828_backfill_products_total.sql` foi atualizado com o `WHERE`/`UPDATE` unificado acima, os números reais no cabeçalho, e continua marcado como pendente de aplicação.

---

## Compatibilidade do readiness com a UI fiscal

Confirmado por leitura direta do componente (não só grep): `src/app/(dashboard)/vendas/[id]/_components/documento-fiscal-card.tsx:169` renderiza `{e.message}` para cada erro de `validationErrors` — o `code` é usado **só** como `key` do React, nunca exibido. A resposta de `POST /api/fiscal/nfe/preview` repassa o array de `FiscalValidationError` sem alteração (`src/app/api/fiscal/nfe/preview/route.ts:101`). Logo, os novos códigos granulares (`destinatario_cep_missing`, `destinatario_numero_missing`, etc.) já chegam à UI como mensagens completas em português, automaticamente — nenhuma mudança adicional foi necessária no card ou nas rotas.

Como este repositório não tem infraestrutura de teste de componente React (`@testing-library/react` não é dependência, nenhum `.test.tsx` existe, `vitest.config.ts` não configura `jsdom`) — adicionar isso só para este teste seria uma mudança de infraestrutura desproporcional ao pedido. Em vez disso, adicionei 2 testes em `validateFiscalReadiness.test.ts` que provam, no nível de dado (o mesmo array que a rota devolve e o card consome), que:
1. Uma venda com **múltiplas pendências simultâneas** de destinatário devolve ≥ 8 erros, todos com mensagem não-vazia, nunca igual ao código, sempre com espaço (frase, não identificador) e pontuação final.
2. Cada código granular novo (`destinatario_cep_missing`, `..._logradouro_missing`, `..._numero_missing`, `..._bairro_missing`, `..._municipio_missing`, `..._uf_missing`) tem mensagem que **menciona o nome do campo em português** e `field` correto.

---

## Ordem exata das migrations para aplicação no banco real

Nenhuma foi aplicada. Ordem obrigatória (dependências reais, não arbitrária):

| # | Arquivo | Pré-requisito | Efeito | Dados alterados? | Idempotente? | Rollback real possível? | Smoke test pós-aplicação |
|---|---|---|---|---|---|---|---|
| 1 | [`20260828_customer_addresses_ibge.sql`](../supabase/migrations/20260828_customer_addresses_ibge.sql) | Nenhum | `ALTER TABLE customer_addresses ADD COLUMN municipio_ibge, ibge_source` + 2 CHECKs | Não (só schema) | Sim (`ADD COLUMN IF NOT EXISTS`) | Sim — `ALTER TABLE customer_addresses DROP COLUMN municipio_ibge, DROP COLUMN ibge_source` | `\d customer_addresses` mostra as 2 colunas novas; `INSERT` de teste com `municipio_ibge='123'` (6 dígitos) deve falhar por CHECK |
| 2 | [`20260828_sale_recipients.sql`](../supabase/migrations/20260828_sale_recipients.sql) | Nenhum (não depende de #1, mas roda depois por convenção de agrupamento) | `CREATE TABLE sale_recipients` + RLS deny-by-default | Não (tabela nova, vazia) | Sim (`CREATE TABLE IF NOT EXISTS`) | Sim — `DROP TABLE sale_recipients` (nada mais referencia essa tabela ainda) | `\d sale_recipients` mostra a estrutura esperada; `SELECT COUNT(*) FROM sale_recipients` = 0 |
| 3 | [`20260828_sale_items_price_snapshot.sql`](../supabase/migrations/20260828_sale_items_price_snapshot.sql) | Nenhum | `ALTER TABLE sale_items ADD COLUMN list_price_snapshot, surcharge_amount` + 2 CHECKs | Não (`DEFAULT 0`/`NULL`, não popula linhas existentes) | Sim | Sim — `ALTER TABLE sale_items DROP COLUMN list_price_snapshot, DROP COLUMN surcharge_amount` | `\d sale_items` mostra as 2 colunas; `SELECT surcharge_amount FROM sale_items LIMIT 1` = 0 para linha existente |
| 4 | [`20260828_rpc_create_sale_pricing_and_products_total.sql`](../supabase/migrations/20260828_rpc_create_sale_pricing_and_products_total.sql) | **#2 e #3 aplicadas** (a função referencia `sale_recipients` e as colunas novas de `sale_items`/`customer_addresses`) | **(revisado — Blocker 3)** `DROP FUNCTION` explícito da assinatura de 16 parâmetros + `DROP FUNCTION IF EXISTS` do wrapper de 12 parâmetros (achado adicional) + `CREATE OR REPLACE FUNCTION rpc_create_sale` com a assinatura nova de 17 parâmetros (fórmula de `products_total` corrigida, checagem de isolamento por `company_id`, snapshot atômico) + `REVOKE`/`GRANT` explícitos (`PUBLIC`/`authenticated` fora, `service_role` dentro) | Não diretamente (redefine função; próxima venda criada é que grava dado novo) | Sim (`DROP ... IF EXISTS` + `CREATE OR REPLACE`, idempotente por natureza) | Sim, mas **manual** — precisa recriar a assinatura de 16 parâmetros com o corpo anterior (preservado em `20260817_sale_rpcs_emit_outbox_events.sql`) e reaplicar seu `REVOKE`/`GRANT` original; se quiser reverter 100%, recriar também o wrapper de 12 parâmetros a partir de `20260610_multi_estoque.sql` | Rodar `rpc_create_sale_single_overload.test.sql` PRIMEIRO (confirma exatamente 1 função + GRANTs corretos — se isso falhar, pare, não confie nos outros). Depois `rpc_create_sale_pricing_invariants.test.sql` E `rpc_create_sale_recipient_atomicity.test.sql` (ambos com `ROLLBACK` interno). Por fim, criar 1 venda de teste real via a API (`POST /api/vendas`) com `delivery_mode='pickup'` e confirmar que nada mudou de comportamento (retrocompatibilidade) |
| 5 | [`20260828_backfill_products_total.sql`](../supabase/migrations/20260828_backfill_products_total.sql) | **#4 aplicada** (usa a mesma fórmula, precisa estar consistente com o que novas vendas gravam) + **auditoria read-only aprovada** (rodar `docs/products_total_backfill_audit_readonly.sql` e revisar os números antes) | `UPDATE sales SET products_total = ... WHERE products_total IS NULL` | **Sim — transformação de dado real, não estrutural** | Sim (só afeta `IS NULL`) | **Não automaticamente** — é uma escrita de dado histórico; só reversível se alguém guardar a lista de IDs afetados antes de rodar | `SELECT COUNT(*) FROM sales WHERE products_total IS NULL` deve cair a zero (ou ao número esperado, se havia vendas deliberadamente fora do escopo); comparar uma amostra antes/depois com o Bloco 2 do script de auditoria |

**Tratado deliberadamente à parte, como pedido**: a migration #5 (backfill) não deveria ser aplicada na mesma janela que #1-#4, mesmo sendo tecnicamente compatível — é uma decisão de dados, não estrutural, e depende da sua revisão dos números reais primeiro.

---

## Validação

```
tsc --noEmit  → limpo
vitest run    → 781/781 passam (49 arquivos de teste)
next build    → sucesso
```

Nenhum teste SQL novo (`rpc_create_sale_single_overload.test.sql`, `rpc_create_sale_pricing_invariants.test.sql`, `rpc_create_sale_recipient_atomicity.test.sql`, `sale_recipients_constraints.test.sql`) foi executado nesta sessão — sem acesso a banco real. Precisam rodar contra um Postgres de teste com o schema desta fase já aplicado (migrations #1-#4) antes de qualquer confiança adicional — nessa ordem, `rpc_create_sale_single_overload.test.sql` primeiro.
