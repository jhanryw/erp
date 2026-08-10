# Resultados da Validação SQL — Banco Real (Supabase)

**Tipo:** registro dos resultados reais retornados pelo usuário ao executar os blocos de [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql), seguindo [`fiscal-database-validation-guide.md`](fiscal-database-validation-guide.md). Nenhuma consulta de escrita foi executada — todos os retornos abaixo vieram de `SELECT`. Este documento organiza e interpreta os resultados; não altera nenhum documento anterior (ver [`fiscal-audit-delta-after-sql.md`](fiscal-audit-delta-after-sql.md) para o mapeamento exato do que precisa ser atualizado em cada documento existente).

**Nota de honestidade metodológica:** durante a análise, encontrei um **erro na minha própria consulta 4.2** (CHECK constraints) — não uma ausência real de constraints no banco. Está documentado na Seção 4 abaixo, com a causa exata e a consulta corrigida.

---

## 1. Schema real do banco (confirmações e novidades)

### `companies` — 7 colunas, confirmado, zero campos fiscais
`id, name, slug, plan, active, created_at, updated_at`. **Confirma integralmente** o achado C1 do registro de riscos: nenhum CNPJ/IE/IM/CRT/endereço. Apenas **1 linha existe**: `id=1, name='Santtorini', slug='santtorini', plan='professional', active=true, created_at='2026-05-12 13:27:54'`. **Confirma definitivamente** (não mais por inferência) que o sistema opera como single-tenant real, não só de fato via configuração de app.

### `customers` — 16 colunas, confirmado, zero campos PJ
`id, cpf, name, phone, birth_date, city, state, origin, notes, active, created_at, updated_at, created_by, company_id, email, is_anonymous`. **Achado novo relevante:** `company_id` tem `column_default = '1'` — ou seja, o hardcoding de single-empresa está gravado **no próprio schema da coluna**, não só em variável de ambiente (`ALERT_COMPANY_ID`) como documentado antes. Nenhum campo CNPJ/razão social/IE/CEP/logradouro/IBGE — confirma C2 integralmente.

### `pedidos` — achado novo importante: coluna `nf_status`
Schema real (união dos dois blocos de resultado que trouxeram `pedidos`): `id, external_id, source, status, total, customer_name, customer_email, created_at, nf_status, channel_status, operational_status, sale_id, customer_id, stock_processed, processing_lock, processing_claimed_at`.

**A coluna `nf_status` (text, nullable, default `'pending'`) não apareceu em nenhuma pesquisa anterior desta auditoria.** Verificação direta feita agora: `grep -rn "nf_status" src/` retorna **zero ocorrências** em código de aplicação; `grep -rln "nf_status" supabase/migrations/*.sql src/lib/db/migrations/**/*.sql` retorna **zero arquivos** — a coluna não está documentada em nenhuma migration rastreada, e não é lida nem escrita por nenhum código atual. É um campo órfão, criado antes do início do histórico de migrations rastreado (mesma classe de achado da Seção 1 de `migrations-divergence-analysis.md`), com um nome que sugere status de nota fiscal mas **sem nenhuma evidência de uso real hoje**. Registrado como item a decidir na Fase 1 (reaproveitar com significado formal, ou ignorar/descontinuar) — não presumir que já é "suporte fiscal existente".

### `pedidos_external_id_source_key` — refutação de um achado anterior
A consulta 6.1 confirma: `pedidos_external_id_source_key` — **`UNIQUE (external_id, source)`** — existe de fato no banco real. Isso **refuta** a preocupação levantada na auditoria anterior (`fiscal-architecture-proposal.md` §5 e a memo de pesquisa de webhooks/Nuvemshop) de que só um índice não-único (`idx_pedidos_external_source_lock`) protegia essa chave natural, com uma janela teórica de corrida para inserção duplicada. **A proteção é mais forte do que eu havia avaliado.** Igual ao caso de `nf_status`, esta constraint **não aparece em nenhuma migration rastreada** (`grep -rn "external_id_source_key\|UNIQUE.*external_id.*source"` → zero arquivos) — mais uma prova de que partes ativas e corretas do schema também predatam o histórico versionado, não só as incorretas.

### `product_variations.sku_variation` — achado resolvido (era uma pergunta em aberto do próprio time)
Confirmado por `pg_constraint`: **duas constraints `UNIQUE` reais existem** — `product_variations_sku_variation_key UNIQUE(sku_variation)` e `unique_sku_per_company UNIQUE(sku_variation, company_id)`. Isso **resolve a favor** o "ACHADO AINDA EM ABERTO" que o próprio autor de `202607302600_pim_product_sku_identity.sql` deixou registrado (não confirmara se essa unicidade era real). **Confirmado: é real.** Nenhuma constraint `UNIQUE` equivalente existe para `products.sku` — só `products_pkey` (PK em `id`) aparece na mesma consulta, confirmando que `products.sku` de fato **não** tem `UNIQUE`, exatamente como o próprio time já havia documentado.

### Duplicidade real de `products.sku` — confirmada empiricamente
25 grupos de SKU duplicado encontrados, maior grupo com **45 produtos** compartilhando o SKU `0202000026` (todos `company_id=1`). Levemente acima do "44" citado na migration `202607302600` — diferença mínima, plausivelmente um produto novo criado no mesmo grupo desde que aquela migration foi escrita; não muda a conclusão, apenas confirma que o fenômeno é real, atual e mensurável.

### `users` — apenas 3 usuários, e nenhum com papel `gerente`
`role: admin=2, seller=1`. Achado operacional relevante: **hoje não existe nenhum usuário com papel `gerente`** no sistema real — só `admin` (2) e o papel legado `seller` (mapeado para `usuario` no app, 1 usuário). Isso significa que, na prática atual, qualquer elevação via `authorization_tokens` (cancelar/devolver/trocar por um `usuario`) só pode ser autorizada por um `admin`, nunca por um `gerente` — reforça que a recomendação já registrada em `fiscal-architecture-proposal.md` §14 (cancelamento fiscal restrito a `admin`, não `gerente`) está alinhada com a realidade operacional atual, não é uma restrição artificial.

---

## 2. Funções e triggers efetivamente vigentes — achados novos importantes

### `rpc_create_sale` — confirmação da versão vigente + descoberta de um segundo overload vivo
O catálogo `pg_proc` confirma **dois overloads simultâneos** de `public.rpc_create_sale`:

1. **16 parâmetros** (`p_customer_id ... p_stock_mode ... p_responsible_seller_id`) — **corresponde exatamente** à assinatura da versão vigente já identificada em `products-total-regression-analysis.md` (`20260704_fix_cashback_expiry_and_earn.sql`). **Confirmado: minha análise da versão vigente estava correta.**
2. **12 parâmetros**, começando por `p_accumulate_cashback boolean` — uma assinatura **mais antiga**, que não corresponde a nenhuma das 12 versões que tracei cronologicamente no relatório de regressão.

**Investigação feita agora, direto no repositório:** esse segundo overload **não é um "zumbi" acidental** — é um **wrapper de compatibilidade deliberado**. `supabase/migrations/20260522_rpc_create_sale_cash_session.sql:14,23` documenta explicitamente: *"Assinatura do wrapper de compatibilidade (p_accumulate_cashback)... O wrapper (12-param com p_accumulate_cashback) não muda — chama a nova função."* O wrapper foi recriado (`CREATE OR REPLACE`) em pelo menos três migrations — `20260522_rpc_create_sale_cash_session.sql:397-398`, `20260522_rpc_create_sale_payments.sql:392-393`, e por último em `supabase/migrations/20260610_multi_estoque.sql:858-859`.

**Achado de risco real:** não encontrei nenhuma migration **posterior a 20260610** que redefina esse wrapper de 12 parâmetros. Isso significa que, se ele ainda chama internamente para uma versão "antiga" da lógica (nos termos exatos do próprio comentário, "chama a nova função" — "nova" relativa a maio/10 de junho de 2026), o wrapper pode estar **congelado desde antes de**: a correção de cashback earn de `20260612_fix_cashback_earn.sql`, a adição fiscal (e sua regressão) de `20260613`/`20260614`, o modo de estoque de `20260617`, a correção de saldo de cashback de `20260626_fix_cashback_balance.sql`, e a correção de expiração/earn de `20260704`. **Não há evidência de que o código de aplicação atual chame essa assinatura** (`src/services/vendas.service.ts` monta o payload com os nomes de parâmetro da versão de 16 params, confirmado na auditoria anterior) — mas a função continua **viva e chamável** via `supabase.rpc('rpc_create_sale', {...})` por qualquer client com credencial válida que envie exatamente esse conjunto de 12 chaves. Registrado como risco novo na Seção "Riscos que mudaram de severidade" abaixo.

### `set_sale_number()` / trigger `trg_set_sale_number` — mecanismo real diferente do documentado
O catálogo de triggers confirma: `sales / trg_set_sale_number / BEFORE INSERT / EXECUTE FUNCTION set_sale_number()`. **Isso é uma trigger `BEFORE INSERT`, não a `DEFAULT public.generate_sale_number()` em nível de coluna** que `src/lib/db/migrations/000_schema_completo.sql:731` documenta. Além disso, `generate_sale_number` aparece **com dois overloads**: um sem parâmetros (o que eu já havia lido em `000_schema_completo.sql:289-303`) e um **com `p_sale_date date`** — que não está em nenhuma migration rastreada (`grep -rln "set_sale_number\|trg_set_sale_number"` nas duas árvores → **zero arquivos**).

**Consequência para o achado M1 do registro de riscos (numeração de venda `COUNT()+1` global, sem lock):** minha análise anterior leu o mecanismo a partir do texto da migration (`DEFAULT`), mas o mecanismo real e vigente é uma função de trigger cujo corpo **eu não li** (não está em nenhum arquivo). **Não posso confirmar nem negar, com o que tenho hoje, se a lógica interna de `set_sale_number()`/`generate_sale_number(date)` ainda usa o padrão `COUNT(*)+1` que descrevi, ou se foi corrigida/alterada em algum momento não documentado.** Isso rebaixa minha confiança na conclusão anterior de "Médio" risco confirmado para "não confirmado, precisa de leitura do corpo da função" — ver consulta de acompanhamento proposta na Seção 5.

### `trigger_generate_cashback()` — achado potencialmente sério, não confirmado
Trigger `sales / trg_generate_cashback / AFTER INSERT OR UPDATE / EXECUTE FUNCTION trigger_generate_cashback()` existe e está ativa. **Isso é uma SEGUNDA via de geração de cashback**, além da lógica de cashback já lida inline dentro do corpo de `rpc_create_sale` (variável `v_eff_cashback`, inserção de transação `earn`, linhas ~419-471 da versão vigente). `grep -rln "trigger_generate_cashback\|trg_generate_cashback"` nas duas árvores de migration → **zero arquivos**. Não tenho o corpo desta função — **não posso confirmar se ela gera cashback duplicado, se está desativada por alguma condição interna, ou se é dead code que nunca dispara na prática.** Isto é registrado como uma **pergunta em aberto de prioridade alta** (ver Seção 5) — não devo, e não vou, presumir nem que é inofensiva nem que é um bug ativo sem ler o corpo da função.

### `sync_role_to_auth_metadata()` — correção de uma afirmação anterior
O relatório de infraestrutura da primeira fase desta auditoria sugeriu que esse mecanismo de sincronização de papel para o JWT havia sido **"superseded"** (substituído) pela checagem via banco (`getUserProfile()`/`requireRole()`). **Isso precisa ser corrigido.** Confirmado agora: a função existe (`src/lib/db/migrations/archive/001_rls_and_audit.sql`, replicada em `000_schema_completo.sql`) **e está ativa em produção** — trigger `trg_sync_role` em `users`, `AFTER INSERT OR UPDATE`. O mecanismo de sincronização de papel para `raw_user_meta_data` **continua rodando a cada mudança de papel de usuário**, mesmo que o middleware/API não leia esse claim do JWT hoje. Não é um bug, só uma imprecisão a corrigir no relatório principal (ver `fiscal-audit-delta-after-sql.md`).

### Auditoria automática já cobre `sales` via trigger, além do log manual da aplicação
`audit_sales` trigger (`AFTER INSERT/UPDATE/DELETE`, `audit_trigger_function()`) está ativo em `sales`. Isso significa que **toda alteração em `sales` — inclusive as feitas pelo endpoint `/api/vendas/[id]/editar` que não trava por status (achado A3 do registro de riscos)** — já fica automaticamente registrada no nível de banco, além do `auditLog()` manual que o próprio endpoint já chama. **Não corrige o problema de permitir a edição indevida, mas reduz um pouco a severidade prática** (a rastreabilidade é mais forte do que eu havia avaliado, mesmo que a prevenção continue ausente).

---

## 3. Estado real das policies RLS — o achado mais crítico desta rodada de validação

**Confirmação máxima do pior cenário já cogitado no registro de riscos (M6): as policies antigas e permissivas (`USING (true)`) nunca foram removidas, e coexistem hoje com as policies novas por `company_id`.**

Como RLS no Postgres combina policies permissivas com `OR`, a presença de qualquer policy `USING (true)` numa tabela **anula completamente** o filtro de qualquer outra policy mais restritiva na mesma tabela, para qualquer client que não seja `service_role`.

**Tabelas confirmadas com uma policy `authenticated_full_access` (`ALL`, `qual: true`, `with_check: true`) — ou seja, acesso total e irrestrito, entre empresas, para qualquer cliente autenticado (não só `service_role`):**

`companies`* , `customers`, `product_variations`, `products`, `sale_items`, `sales`, `cashback_transactions`, `categories`, `collections`, `finance_entries`, `marketing_costs`, `stock`, `stock_lots`, `suppliers`, `users`, `audit_log` (singular).

*(`companies` não tem essa policy especificamente, mas não tem **RLS habilitado de forma alguma** — resultado equivalente: acesso total sem nenhuma restrição de linha.)*

**O achado mais grave dentro desse grupo: `users` tem `authenticated_full_access`.** Isso significa que qualquer cliente com um JWT autenticado válido (não precisa ser `service_role`) pode, via chamada direta ao PostgREST/Supabase (contornando completamente a API Next.js), **ler e escrever livremente na tabela `users` de qualquer empresa — inclusive a coluna `role`.** Combinado com o fato de que `trg_sync_role` sincroniza `role` para o JWT (Seção 2), isso é, em tese, um caminho de escalação de privilégio: um usuário autenticado de baixo privilégio poderia, via chamada direta à API do Supabase (não pela aplicação Next.js), atualizar seu próprio `role` para `'admin'`.

**O segundo achado grave: `finance_entries` também tem `authenticated_full_access`**, apesar de também ter policies mais restritas (`finance_entries_select`/`finance_entries_insert` exigindo `admin`/`gerente`) — a policy permissiva anula essa restrição para qualquer usuário autenticado.

**Achado adicional: existe uma segunda tabela de auditoria, `audit_log` (singular, diferente de `audit_logs` plural)**, com **4.577 linhas** e a mesma policy `authenticated_full_access` — completamente aberta. Todo o código de aplicação já auditado nesta investigação grava em `audit_logs` (plural, com policy restrita a `admin` via `audit_logs_select`). `audit_log` (singular) parece ser uma tabela legada, possivelmente da mesma origem que as policies antigas de `archive/001_rls_and_audit.sql` — não investigada em profundidade nesta rodada (fora do escopo original das 8 tabelas-alvo do Bloco 3), mas relevante o suficiente para registrar como achado novo.

**Tabelas confirmadas SEM a policy permissiva, ou seja, corretamente protegidas para o papel `authenticated`:** `sale_payments` (só a policy `sale_payments_company`, exigindo `admin`/`gerente` + `company_id`), `audit_logs` (plural, só `admin` via `audit_logs_select`), toda a família `crm_*` (só company-scoped), `post_sale_automation_events`, `push_subscriptions`, `webhook_log`, `cash_movements`/`cash_register_sessions` (só leitura company-scoped), `stock_balances`/`stock_locations` (só leitura company-scoped), `finance_cash_links` (só leitura company-scoped).

**Escopo mais amplo do que o Bloco 3 original cobriu:** o Bloco 5.10 (inventário geral de RLS) revelou que **RLS está completamente desabilitado** (nenhuma policy relevante, acesso governado só por GRANTs de tabela) em um número muito maior de tabelas do que as 5 originalmente suspeitas (`companies`, `pedidos`, `pedidos_itens`, `returns`, `return_items`). A lista completa inclui também: `brands`, `campaigns`, `cashback_config`, `category_attributes`, `category_models`, `customer_addresses`, `customer_metrics`, `customer_preferences`, `error_logs`, `import_batches`, `inventory_count_items`, `inventory_counts`, `media`, `media_renditions`, `media_usages`, `monthly_sales_goals`, `nuvemshop_sync_logs`, `payment_fee_settings`, `product_attribute_values`, `product_models`, `product_sku_identities`, `product_types`, `product_variation_attributes`, `produto_map`, `repasse_batches`, `sale_shipping`, `sellers`, `shipment_events`, `shipments`, `shipping_origins`, `shipping_rules`, `shipping_zones`, `tax_icms_rates`, `tax_simulation_settings`, `type_attribute_values`, `type_attributes`, `variation_types`, `variation_values`, mais 3 tabelas de backup datadas (`backup_sale_items_20260408`, `backup_sales_20260408`, `backup_stock_movements_20260408`).

**Mitigação que continua válida, reafirmada:** a aplicação usa exclusivamente `service_role` (que ignora RLS por completo) para toda operação — nenhuma exposição foi confirmada através do uso normal do app hoje. **O risco é latente, não ativamente explorado pela aplicação atual.** Ele se torna relevante no momento em que: (a) qualquer chave `anon`/`authenticated` do Supabase for usada para chamar a API diretamente (por engano, por uma integração futura, ou por vazamento de credencial), ou (b) um futuro provedor fiscal, ferramenta de BI, ou integração externa receber acesso `authenticated` em vez de uma credencial de serviço dedicada e escopada.

---

## 4. Erro identificado na minha própria consulta (transparência necessária)

A consulta 4.2 (CHECK constraints de `products`, `product_variations`, `customers`, `sales`, `sale_items`, `sale_payments`) retornou **"Success. No rows returned"**. **Isso não significa que essas tabelas não têm CHECK constraints** — eu já havia lido, diretamente no texto das migrations, pelo menos 3 delas (`sales`: `CHECK (total >= 0)`, `CHECK (discount_amount >= 0 AND discount_amount <= subtotal)`, `CHECK (cashback_used >= 0)`; `sale_items`: `CHECK (quantity > 0)`, `CHECK (unit_price > 0)`; `sale_payments`: 10 constraints `sp_*`).

**Causa provável identificada:** minha consulta comparava `conrelid::regclass::text` (que, com `public` no `search_path` — o padrão do Postgres/Supabase — renderiza **sem** o prefixo de schema, ex. `sales`, não `public.sales`) contra uma lista de strings **com** o prefixo (`'public.sales'`). Isso faz a comparação falhar silenciosamente para toda linha, mesmo que as constraints existam. **Erro de construção da minha consulta, não um achado sobre o banco.**

**Consulta corrigida, para nova execução** (ainda somente leitura):
```sql
SELECT conrelid::regclass AS tabela, conname AS nome_constraint, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE contype = 'c'
  AND conrelid IN (
    'public.products'::regclass, 'public.product_variations'::regclass,
    'public.customers'::regclass, 'public.sales'::regclass,
    'public.sale_items'::regclass, 'public.sale_payments'::regclass
  )
ORDER BY tabela;
```
Este item permanece **não confirmado** até essa consulta corrigida ser executada — não deve ser tratado como "achado", nem positivo nem negativo, até lá.

---

## 5. Perguntas que continuam em aberto após esta rodada (consultas de acompanhamento propostas, não executadas)

Somente leitura, nenhuma foi rodada:

```sql
-- Corpo das funções de trigger cujo comportamento não pôde ser confirmado nesta rodada
SELECT proname, pg_get_functiondef(oid)
FROM pg_proc
WHERE proname IN ('set_sale_number', 'generate_sale_number', 'trigger_generate_cashback', 'audit_cash_trigger')
ORDER BY proname;

-- Distribuição de status entre as 300 vendas afetadas por products_total NULL
SELECT status, count(*) FROM public.sales
WHERE sale_date >= '2026-06-14' AND products_total IS NULL
GROUP BY status ORDER BY status;

-- Vendas afetadas que têm origem Nuvemshop (via pedidos) vs. PDV direto
SELECT (p.sale_id IS NOT NULL) AS veio_de_pedido_nuvemshop, count(*)
FROM public.sales s
LEFT JOIN public.pedidos p ON p.sale_id = s.id
WHERE s.sale_date >= '2026-06-14' AND s.products_total IS NULL
GROUP BY 1;

-- Vendas afetadas com pagamento misto (mais de uma linha em sale_payments)
SELECT (cnt > 1) AS pagamento_misto, count(*) FROM (
  SELECT s.id, count(sp.id) AS cnt
  FROM public.sales s
  LEFT JOIN public.sale_payments sp ON sp.sale_id = s.id
  WHERE s.sale_date >= '2026-06-14' AND s.products_total IS NULL
  GROUP BY s.id
) t
GROUP BY 1;

-- CHECK constraints corrigido (Seção 4)
SELECT conrelid::regclass AS tabela, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'c' AND conrelid IN (
  'public.products'::regclass, 'public.product_variations'::regclass,
  'public.customers'::regclass, 'public.sales'::regclass,
  'public.sale_items'::regclass, 'public.sale_payments'::regclass
);
```

Nenhuma dessas foi executada nesta rodada — ficam propostas para uma próxima validação, se o usuário optar por rodá-las.

---

## Resumo cruzado: o que os números confirmam sobre `products_total`

Consolidado aqui porque alimenta diretamente [`products-total-remediation-plan.md`](products-total-remediation-plan.md):

- **300 vendas** com `products_total IS NULL` desde a regressão (`sale_date >= 2026-06-14`).
- **171 vendas** anteriores, **100% preenchidas** — nenhuma exceção, nenhum nulo pré-existente.
- **0 vendas** posteriores à regressão foram corrigidas organicamente — 100% nulas, sem exceção.
- Amostra de 20 vendas recentes confirma, linha a linha, que `subtotal` e `discount_amount` continuam sempre preenchidos, sempre não-negativos, sempre com `discount_amount ≤ subtotal` (consistente com a fórmula original), e que `products_total` reconstruído (`subtotal - discount_amount`) **nunca precisa ser igual a `total`** — a diferença observada entre eles em várias linhas da amostra é explicada por `shipping_charged`/`surcharge_amount`, exatamente como a fórmula original prevê (`total = subtotal - discount + surcharge + shipping - cashback`).
- Nenhum valor negativo ou inconsistente foi observado na amostra.
- **Cashback não altera `subtotal` nem `discount_amount`** — confirmado tanto pela leitura do código (cashback só entra no cálculo de `total`, nunca de `subtotal`) quanto pela ausência de qualquer padrão inconsistente na amostra.
- **Frete e acréscimo (`surcharge`) também não alteram `subtotal`/`discount_amount`** — mesma conclusão, mesma evidência.
- **Vendas canceladas / Nuvemshop / pagamento misto**: ainda não isoladas empiricamente nesta rodada — consultas de acompanhamento propostas acima, não executadas.
