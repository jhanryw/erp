# Fase 9 — Homologação Real e Hardening Ponta a Ponta

## Aviso central, antes de qualquer outra coisa

Este sandbox **não tem acesso a Postgres/Supabase real** — confirmado (de novo) nesta fase: sem `supabase` CLI, sem `psql`, sem `docker`, sem `DATABASE_URL`, sem `supabase/config.toml`. `.env.local` tem credenciais reais do projeto Supabase (URL + service role key), mas por instrução permanente já registrada nesta mesma sessão ([[feedback_destructive_actions]]) **nunca conecto nele sem autorização explícita e no momento**, especialmente para aplicar migrations ou criar dados reais (auth users, vendas) — não há como eu confirmar, de dentro deste ambiente, se esse projeto é homologação isolada ou a mesma base que já atende a operação real da Nuvemshop/Focus.

Por isso, esta fase entregou **tudo que é possível validar sem banco real**: auditoria estática completa de todas as migrations relacionadas, revisão de código de segurança/hardening (2 bugs reais corrigidos), e a suíte automatizada completa. Todo item que exige banco/Focus/browser real está marcado **NÃO EXECUTADO** abaixo, nunca simulado como se tivesse passado — exatamente como instruído.

---

## Matriz de execução

| Área | Teste | Resultado | Evidência | Correção |
|---|---|---|---|---|
| Migrations | Ordem/dependência de todas as 8 migrations varejo/atacado/fiscal/site | ✅ OK | Seção B abaixo, arquivo por arquivo | — |
| Migrations | `20260828_*` (5 arquivos mesmo prefixo) — ordem alfabética correta? | ✅ OK (verificado, não é bug) | `products_total` já existia desde `20260613`, backfill não depende de nada posterior | — |
| Migrations | Migration que falha em banco já populado (NOT NULL sem DEFAULT, UNIQUE colidindo) | ✅ Nenhuma encontrada | Todas as `ADD COLUMN` novas são nullable ou têm DEFAULT; único `NOT NULL` (`sale_type`) tem DEFAULT | — |
| Migrations | `sales_channel`/`sale_type` CHECK batem com os valores usados no código | ✅ OK | `wholesale_site` confirmado no CHECK | — |
| Migrations | `payment_method` enum tem `invoice` | ⚠️ NÃO EXECUTADO (SQL não aplicado) | Migration escrita e revisada estaticamente | — |
| Código | `signupWholesaleCustomer` vazava erro cru do Postgres pro cliente público | 🐛 BUG REAL | `createError?.message` direto na resposta HTTP | ✅ Corrigido — mensagem genérica + `logError` server-side |
| Código | `checkoutWholesaleCart` catch genérico vazava `err.message` cru | 🐛 BUG REAL | mesmo padrão acima | ✅ Corrigido |
| Código | `ExchangeForm.tsx` — `PAYMENT_LABELS[paymentMethod]` sem fallback | ⚠️ Gap defensivo (nunca alcançável hoje) | único uso sem `?? fallback` dos 8 no projeto | ✅ Corrigido (1 linha) |
| Segurança | `service_role` usado corretamente em todas as rotas `wholesale` (nunca `select('*')`, nunca `company_id`/`customer_id` do body) | ✅ OK | grep confirmou zero ocorrências dos dois padrões de risco | — |
| Segurança | RLS de `customers`/`sales`/`product_variations`/`sale_items` — acesso `anon`/`authenticated` aberto? | ✅ Deny-by-default confirmado (estático) | `20260820_fix_rls_open_policies_tenant_isolation.sql`, seção ativa (não o bloco `/* ROLLBACK */` no fim do arquivo) | — |
| Segurança | `current_company_id()`/`get_user_role()` retornam seguro (não vazam empresa) pra uma sessão de CLIENTE (sem linha em `public.users`) | ❓ NÃO VERIFICADO | Definição da função não está em nenhuma migration rastreada (predata o histórico) | Ver seção N |
| Testes SQL | Todos os `.sql` em `supabase/tests/` relacionados às fases | ⚠️ NÃO EXECUTADO | Sem Postgres — listados na seção F | — |
| PDV retail/wholesale | Cenário real (venda + estoque + banco) | ⚠️ NÃO EXECUTADO | Sem banco — lógica já coberta por unit tests + auditoria de código (fases anteriores) | — |
| Estoque compartilhado | 10→atacado 3→7→varejo 2→5→site 1→4 | ⚠️ NÃO EXECUTADO contra banco real | Cenário coberto por `wholesale_site_foundation.test.sql` (não rodado) e testes unitários da lógica de agregação | — |
| CSV real | Update por SKU + criação | ⚠️ NÃO EXECUTADO | Sem banco | — |
| Site atacado — tenant | `WHOLESALE_SITE_SYSTEM_USER_ID` real configurada e testada | ⚠️ NÃO EXECUTADO | Env var não configurada neste ambiente (confirmado, vazia) | — |
| Site atacado — browser | `/atacado` real em navegador, Network/JSON | ⚠️ NÃO EXECUTADO | Sem tenant configurado + risco de subir servidor apontando pro Supabase real sem autorização | — |
| Auth real do cliente | Signup/login real, cookie, RLS | ⚠️ NÃO EXECUTADO | Mesmo motivo acima | — |
| Checkout real | Preço forjado, sale_type forjado, tenant cruzado, concorrência, idempotência dupla | ⚠️ NÃO EXECUTADO contra servidor real | **Todos os 4 cenários já têm teste automatizado equivalente e passando** (`checkout.test.ts`) — ver seção G para a distinção entre "testado" e "testado contra servidor real" | — |
| Fiscal — comprovante | Venda `fiscal_document_type=none` | ⚠️ NÃO EXECUTADO | Sem banco | — |
| Fiscal — NFC-e/NF-e homologação | Emissão real via Focus | ⚠️ **NÃO EXECUTADO — sem credenciais Focus configuradas** (confirmado: nenhuma env var `FOCUS_*`; integração vive em `company_integrations`, tabela do banco, inacessível) | — | — |
| Nuvemshop — regressão | Fluxo `retail+nuvemshop` após `stockMode` opcional | ✅ Verificado estaticamente | `createSale()`/webhook Nuvemshop não tocados nesta fase nem nas anteriores; `stockMode` é opcional com default idêntico ao comportamento anterior | — |
| Validação automática | `vitest`/`typecheck`/`build` | ✅ **987/987, limpo, limpo** | Seção K | — |

---

## A. Migrations

**Aplicadas**: nenhuma nesta sessão — sem acesso a banco.
**Pendentes**: as 8 abaixo, na ordem (confirmada pelo nome real do arquivo, não por relatório anterior):

1. `202608311200_wholesale_retail_schema_foundation.sql`
2. `202608311201_rpc_create_sale_wholesale_channel.sql`
3. `202608311202_sale_lifecycle_outbox_sale_type.sql`
4. `202608311203_import_products_wholesale_fiscal_fields.sql`
5. `20260901_rpc_update_products_by_sku.sql`
6. `202609021000_fiscal_recipient_pj_fields.sql`
7. `202609031200_sales_modality_analytics_indexes.sql`
8. `202609040900_wholesale_site_foundation.sql`

**Corrigidas nesta fase**: nenhuma — auditoria não encontrou erro de ordem/schema nas migrations em si (achados de código, sim — ver Matriz).

**Achados da auditoria estática (item 2 do pedido), um por um**:
- *Referência a coluna antes de existir*: nenhuma encontrada. Verificação específica no cluster `20260828_*` (5 arquivos, mesmo prefixo, ordem decidida por alfabeto): `20260828_backfill_products_total.sql` roda ANTES de `20260828_rpc_create_sale_pricing_and_products_total.sql` alfabeticamente — parecia suspeito, mas `sales.products_total` já existe desde `20260613_shipping_fiscal_ready.sql`, então o backfill não depende da RPC. Não é bug.
- *Função redefinida por migration mais antiga depois de uma mais nova*: nenhuma. Tracei a linhagem completa de `rpc_create_sale`/`rpc_cancel_sale`/`rpc_return_sale`/`rpc_process_exchange`/`rpc_import_products_batch`/`rpc_claim_fiscal_emission` — a última definição de cada uma (por ordem de arquivo) é sempre a mais recente cronologicamente.
- *Assinatura duplicada de RPC*: nenhuma — `rpc_create_sale` 17→19 parâmetros sempre com `DROP FUNCTION` explícito da assinatura antiga antes do `CREATE`.
- *`DROP FUNCTION` incorreto*: nenhum — todos os `DROP FUNCTION` referenciam a assinatura exata sendo substituída.
- *Grants esquecidos*: nenhum — `202608311201` (assinatura mudou) reemite `REVOKE`/`GRANT`; `202608311202` (assinatura igual) documenta explicitamente por que não precisa (`CREATE OR REPLACE` preserva ACL quando a assinatura não muda — comportamento real do Postgres).
- *Enum/CHECK incompatível*: nenhum — `sales_channel` CHECK inclui `wholesale_site`; `payment_method` ganha `invoice` via `ALTER TYPE ... ADD VALUE` com guarda `IF NOT EXISTS`, nunca referenciado na mesma migration (regra do Postgres: precisa commitar antes de usar).
- *Índice duplicado*: nenhum — `idx_sales_company_saledate_saletype`/`idx_sales_company_saletype_channel_saledate` são nomes únicos; `idx_sales_company_sale_type` (Fase 1) não fica redundante (cobre um shape de query diferente, sem `sale_date`).
- *Mesmo timestamp*: nenhum dentro do grupo varejo/atacado — todos usam timestamp completo (`YYYYMMDDHHmm`) desde a correção da Fase 2.
- *Dependência circular*: nenhuma.
- *Funciona em banco vazio mas falha em banco populado*: nenhuma — toda `ADD COLUMN` nova é nullable ou tem `DEFAULT`; único `NOT NULL` novo (`sale_type`) tem `DEFAULT 'retail'`.

## B. Banco

Schema final (pendente de aplicação) documentado nas migrations 1-8 acima. RPCs vigentes confirmadas por linhagem (não por suposição): `rpc_create_sale` (19 params, `202608311201`), `rpc_cancel_sale`/`rpc_return_sale`/`rpc_process_exchange` (`202608311202`), `rpc_import_products_batch` (`20260812`, não tocada pelas fases de atacado), `rpc_update_products_by_sku_batch` (`20260901`). Índices: 2 novos avaliados e justificados por query real (Fase 7), nenhum duplicado.

## C. PDV

Retail/wholesale: **NÃO EXECUTADO contra banco real** nesta fase. Cobertura substituta: toda a lógica de preço/estoque/persistência já tem teste unitário (`buildProductSearchItem.test.ts`, `resolveSalePrice.test.ts`) e foi auditada linha a linha nas Fases 1-3 (ver `docs/varejo-atacado-fase3-pdv.md`). Nada foi alterado nessas rotas nesta fase 9.

## D. CSV

**NÃO EXECUTADO contra banco real.** Lógica de update-by-SKU/PATCH-semantics coberta por `import-parser.test.ts` (unitário) — nenhum CSV real processado nesta fase.

## E. Estoque

Compartilhamento/concorrência: **NÃO EXECUTADO contra banco real**. `wholesale_site_foundation.test.sql` (cenário 12→8→6, site+PDV) escrito e revisado, não rodado. Concorrência real (2 checkouts simultâneos brigando pelo mesmo saldo) exigiria duas conexões reais ao Postgres — impossível neste sandbox; a garantia de "nunca fica negativo" vem da própria RPC (`RAISE EXCEPTION` quando saldo insuficiente, dentro de uma transação — nunca auditada como corrigida ou quebrada nesta fase, comportamento pré-existente e não tocado).

## F. Site atacado

- **Catálogo/auth/checkout/pedidos**: **NÃO EXECUTADO em browser real** — `WHOLESALE_SITE_SYSTEM_USER_ID` não está configurada neste ambiente, e configurá-la exigiria apontar pra um `public.users` real (banco real).
- Cobertura substituta: 25 testes unitários novos nesta sessão (Fase 8) cobrindo exatamente os cenários de segurança pedidos aqui (preço forjado, tenant cruzado, staff-não-é-cliente, idempotência) — ver seção G.

## G. Segurança

- **Preço forjado**: testado (unitário) — `checkout.test.ts`, "preço é SEMPRE recarregado do banco". Nunca testado contra um SERVIDOR HTTP real rodando (isso exigiria `WHOLESALE_SITE_SYSTEM_USER_ID` + banco real) — a garantia estrutural é a mesma nos dois casos (o código que valida é o mesmo), mas "testado contra servidor real" continua NÃO EXECUTADO por instrução explícita de não confundir os dois.
- **Tenant cruzado**: testado (unitário) — variação de empresa B tratada como `not_found` na empresa A.
- **RLS**: revisão estática confirma deny-by-default nas tabelas relevantes. Item **não verificável sem banco**: comportamento de `current_company_id()`/`get_user_role()` para uma sessão cujo `auth.users.id` não tem linha em `public.users` (cliente do site) — a suposição de que retornam `NULL`/falso (portanto RLS nega) é consistente com a definição de `customers_select_company USING (company_id = current_company_id())`, mas a função em si não está em nenhuma migration rastreada (pré-existente ao histórico). **Recomendação de pré-GO**: `SELECT current_company_id(), get_user_role()` autenticado como um cliente de teste, confirmar `NULL`/vazio.
- **Idempotência**: testado (unitário, incl. claim concorrente simulado) — nunca testado com 2 requests HTTP simultâneas de verdade.

## H. Analytics

**NÃO EXECUTADO contra banco real.** Nenhuma lógica nova nesta fase (por design da Fase 7 — `sale_type`/`sales_channel` já fluem automaticamente).

## I. Fiscal

- **Comprovante**: NÃO EXECUTADO contra banco real. Lógica não tocada nesta fase.
- **NFC-e/NF-e homologação real**: **NÃO EXECUTADO — sem credenciais Focus configuradas neste ambiente** (confirmado: nenhuma env var `FOCUS_*`; a integração vive em `company_integrations`/tabela do banco, inacessível sem conexão real).
- **Emissão posterior / cancelamento com fiscal autorizado**: lógica não tocada nesta fase — bloqueio 409 já implementado na Fase Fiscal 6, revisado estaticamente aqui, sem regressão encontrada no código.

## J. Regressões

- **PDV**: nenhum código de PDV alterado nesta fase.
- **Nuvemshop**: `createSale()` ganhou um parâmetro **opcional** (`stockMode`, default `'main_store'` idêntico ao comportamento anterior) — nenhum caller existente (PDV, troca) foi alterado para passá-lo; o webhook Nuvemshop nem usa `createSale()` (chama a RPC direto). Verificado por leitura de código, zero mudança de comportamento possível pra chamadas existentes.
- **Financeiro/DRE**: não tocados.

## K. Validação automática

```
npx vitest run    → 987/987 passando (74 arquivos)
npm run typecheck → limpo
npm run build     → limpo, incl. todas as rotas /atacado e /api/wholesale no manifesto
npm run lint      → não configurado neste projeto (gap pré-existente, confirmado em todas as fases anteriores)
```

## L. Não executado (lista explícita)

Exige banco Postgres real (CLI/psql/DATABASE_URL ausentes neste sandbox): aplicar as 8 migrations; todos os `.sql` em `supabase/tests/`; qualquer cenário de PDV/CSV/estoque/checkout/auth contra dado real; `SELECT current_company_id()` como cliente.
Exige credenciais Focus NFe reais: NFC-e/NF-e homologação.
Exige `WHOLESALE_SITE_SYSTEM_USER_ID` configurada (que por sua vez exige um `public.users` real): tudo do site de atacado em browser.
Exige navegador real + servidor rodando: seção 29 (middleware em requisição real), inspeção de Network/JSON do catálogo público.

## M. Bugs encontrados

1. **`signupWholesaleCustomer` vazava mensagem crua do Postgres** — Causa: `createError?.message` repassado direto na resposta HTTP pública. Impacto: um erro de constraint/coluna poderia vazar detalhe de schema pra um visitante anônimo. Correção: mensagem genérica ao cliente + `logError` server-side com o detalhe técnico. Teste de regressão: `customerAuth.test.ts`, "Fase 9 hardening: falha de INSERT... nunca vaza".
2. **`checkoutWholesaleCart` catch genérico vazava `err.message` cru** — mesma causa/impacto/correção do item 1, aplicado ao fluxo de checkout. Teste: `checkout.test.ts`, "Fase 9 hardening: exceção inesperada nunca vaza".
3. **`ExchangeForm.tsx` sem fallback em `PAYMENT_LABELS[paymentMethod]`** — Causa: único dos 8 usos deste dicionário no projeto sem `?? fallback`. Impacto: hoje inalcançável (o dropdown da troca nunca oferece um método fora do dicionário) — corrigido por disciplina defensiva, não por regressão observada.

## N. Riscos restantes (concretos)

1. **`current_company_id()`/`get_user_role()` não verificados para identidade de cliente** (seção G) — risco teórico de vazamento de dado entre tenants SE algum dia uma tabela relevante ganhar uma policy aberta pra `authenticated` sem essa função devolver seguro para um cliente. Ação: 1 query de verificação antes do GO.
2. **Zero validação contra Postgres real em toda a stack varejo/atacado/fiscal/site** — todas as fases anteriores foram implementadas e testadas só com mocks/unitários. Ação: aplicar as 8 migrations em homologação real e rodar os `.sql` de teste listados na seção F antes de qualquer uso com dado real.
3. **`payment_method='invoice'` sem mapeamento fiscal** (decisão deliberada, Fase 8) — continua bloqueando emissão de forma clara, mas nenhum pedido do site poderá ter NF-e/NFC-e emitida até staff reconciliar o pagamento manualmente. Não é bug, é comportamento pretendido — registrado aqui como risco operacional, não técnico.

## O. GO / NO-GO

# **NO-GO**

Nenhuma migration foi aplicada e nenhum teste contra Postgres/Supabase real foi executado nesta fase — por instrução explícita do próprio pedido ("Não declare GO se migrations essenciais ou testes críticos do banco ainda estiverem sem validação"), isso por si só já impede GO, independente da qualidade do código.

**O que falta, especificamente, pra virar GO** (na ordem em que eu faria):
1. Confirmar com o dono que o projeto Supabase em `.env.local` é seguro para este uso (homologação isolada, não a base de produção da operação real).
2. `supabase db push` (ou aplicação manual, uma a uma, na ordem da seção A) num ambiente confirmado seguro.
3. Rodar os `.sql` de `supabase/tests/` listados na seção F contra esse banco.
4. `SELECT current_company_id(), get_user_role()` autenticado como cliente de teste (risco N.1).
5. Configurar `WHOLESALE_SITE_SYSTEM_USER_ID` com um `public.users` real e repetir os cenários de checkout/auth/segurança em browser real.
6. Se credenciais Focus de homologação existirem, uma emissão real de NFC-e e uma de NF-e.

Com 1-4 feitos e limpos, já seria defensável um GO condicional pra uso interno restrito; 5-6 são necessários pra GO completo do site de atacado.
