# Delta da Auditoria Fiscal — Após Validação SQL

**Tipo:** documento de rastreamento. Lista exatamente o que mudou de status (confirmado / refutado / novo / ainda em aberto) entre os documentos publicados nas duas rodadas anteriores desta auditoria e os dados reais coletados nesta validação. **Nenhum documento anterior foi alterado silenciosamente** — este documento serve como o mapa do que precisa ser atualizado em cada um, para execução futura mediante autorização.

Fonte dos dados: [`fiscal-database-validation-results.md`](fiscal-database-validation-results.md).

---

## `fiscal-audit-report.md` — o que precisa ser atualizado

| Claim original | Seção | Novo status | Ação recomendada no arquivo |
|---|---|---|---|
| "`companies` não tem nenhum campo fiscal" | §4, Resumo Executivo | ✅ **Confirmado** (7 colunas reais, nenhuma fiscal) | Nenhuma mudança de conteúdo — apenas remover qualquer marcação de incerteza remanescente |
| "Mecanismo de sincronização de papel para JWT foi superseded" | (herdado da memo de infraestrutura da 1ª fase, não citado textualmente no relatório principal, mas influenciou a linguagem de RBAC) | ❌ **Refutado** — `sync_role_to_auth_metadata()`/`trg_sync_role` estão ativos, não superados | Se o relatório principal ou a arquitetura proposta repetirem essa afirmação em qualquer lugar, trocar "superseded"/"substituído" por "ativo, mas não consumido pelo middleware/API atual" |
| Numeração de venda usa `DEFAULT public.generate_sale_number()` em nível de coluna | §4 (Inventário do Banco), risco M1 do registro de riscos | ⚠️ **Parcialmente refutado / rebaixado para não confirmado** — mecanismo real é uma trigger `BEFORE INSERT` (`trg_set_sale_number` → `set_sale_number()`), com um overload de `generate_sale_number(date)` nunca lido | Marcar a conclusão de "`COUNT(*)+1` racy" como **não confirmada no mecanismo real** até o corpo de `set_sale_number()` ser lido — não apagar o achado, mas rebaixar a confiança e linkar para a consulta de acompanhamento em `fiscal-database-validation-results.md` §5 |
| RLS: "companies sem RLS; sale_items/product_variations com RLS sem policy; possíveis policies antigas permissivas coexistindo" | §6 (Riscos Críticos), item 8 | 🔴 **Confirmado e drasticamente ampliado** | Reescrever esse item — não é mais "possíveis policies antigas coexistindo", é uma confirmação de ~15 tabelas com acesso total via `authenticated_full_access`, incluindo `users` e `finance_entries`, mais ~40 tabelas com RLS totalmente desabilitado. Ver detalhamento completo em `fiscal-database-validation-results.md` §3. Este é o maior salto de severidade de toda a auditoria |
| Pedidos/pedidos_itens: "índice não-único, sem UNIQUE real, risco de duplicidade em concorrência" | §6, referenciado também em `fiscal-architecture-proposal.md` §5 | ❌ **Refutado** — `pedidos_external_id_source_key UNIQUE(external_id, source)` existe de fato | Remover a preocupação específica de "sem UNIQUE" — a proteção é mais forte do que avaliado. Manter a recomendação geral de que a idempotência fiscal deve usar `UNIQUE` real (continua válida como boa prática, só não é mais uma lacuna confirmada neste caso específico) |
| SKU: "`product_variations.sku_variation` — unicidade não verificada, achado em aberto do próprio time" | §6, §12 (herdado da auditoria de schema da 1ª fase) | ✅ **Confirmado positivamente** — a unicidade existe de fato (duas constraints `UNIQUE`) | Atualizar de "não verificado" para "confirmado: existe". Manter inalterada a conclusão sobre `products.sku` (continua sem `UNIQUE`, agora com números reais: 25 grupos duplicados, maior com 45 produtos) |

## `fiscal-risk-register.md` — mudanças de severidade

| # | Risco | Severidade anterior | Nova severidade | Motivo |
|---|---|---|---|---|
| M5/M6 | RLS habilitado sem policy / policies antigas permissivas possivelmente ainda ativas | Médio | **🔴 Crítico** | Confirmado como fato, não hipótese — ~15 tabelas centrais (incluindo `users` e `finance_entries`) com acesso total via `authenticated`, mitigado hoje só pelo uso exclusivo de `service_role` pela aplicação. Ver `fiscal-database-validation-results.md` §3 |
| A6 | `products.sku` sem UNIQUE real | Alto | **Alto, mantido** — confirmado empiricamente (25 grupos, máx. 45) em vez de só citado pela migration | Sem mudança de severidade, só de confiança (de "citado pelo time" para "medido diretamente") |
| — (novo) | Wrapper de compatibilidade `rpc_create_sale` (12 parâmetros) potencialmente congelado desde 10/06/2026, sem confirmação de uso ou de correção interna | — | **Médio (novo)** | Existe, é deliberado, mas não atualizado após pelo menos 4 correções de cashback/estoque/numeração conhecidas. Sem evidência de uso pela aplicação atual, mas continua chamável via API do Supabase por qualquer credencial válida |
| — (novo) | `trigger_generate_cashback()` — segunda via de geração de cashback, corpo não lido, risco de duplicação não descartado | — | **Alto (novo, não confirmado)** | Potencial de gerar cashback em duplicidade a cada `INSERT`/`UPDATE` em `sales` — não confirmado nem descartado, precisa de leitura do corpo da função antes de qualquer conclusão. Tratado como bloqueador do backfill de `products_total` em massa até ser lido (ver `products-total-remediation-plan.md` Parte 3) |
| — (novo) | Tabela órfã `audit_log` (singular), 4.577 linhas, acesso total via `authenticated_full_access`, não usada pelo código de aplicação atual | — | **Médio (novo)** | Exposição de dado de auditoria + peso morto no schema. Baixo risco funcional (app não usa), risco de exposição se algum client `authenticated` for usado diretamente |
| M1 | Numeração de venda `COUNT(*)+1` global, sem lock | Médio | **Rebaixado para "não confirmado"** | O mecanismo real é uma trigger cujo corpo não foi lido — a conclusão anterior partiu do texto de uma `DEFAULT` de coluna que não é o mecanismo vigente. Não descartar o risco, só suspender a conclusão até confirmação |
| — (item novo, informativo) | `pedidos_external_id_source_key` — proteção de idempotência mais forte do que avaliado | Médio (implícito em achados de webhook) | **Rebaixado / fechado** | `UNIQUE` real confirmado — a lacuna teórica de corrida em inserção duplicada de pedido novo não existe |

## `fiscal-architecture-proposal.md` — o que precisa ser revisado

- **§5 (Idempotência):** o parágrafo que descreve `pedidos.processing_lock` como protegido "apenas por índice, não por `UNIQUE` real" está **desatualizado** — a constraint `UNIQUE(external_id, source)` existe de fato. A recomendação de usar `UNIQUE` real na tabela `fiscal_documents` continua válida como boa prática (não deixa de fazer sentido), mas o texto não deve mais citar `pedidos` como exemplo do problema — deve citar como exemplo de que a solução correta (`UNIQUE` real) **já existe** em outro lugar do sistema e pode ser copiada diretamente.
- **§14 (RBAC Fiscal):** a recomendação de restringir cancelamento fiscal a `admin` (não `gerente`) ganha reforço empírico — hoje não existe nenhum usuário com papel `gerente` no sistema real (2 admins, 1 seller/usuario). Vale adicionar essa constatação como justificativa adicional, não como mudança de recomendação (a recomendação já era essa).
- **Novo ponto a adicionar, não presente na versão atual:** antes de desenhar `fiscal_documents`/qualquer nova função `rpc_*`, confirmar que não existe um padrão equivalente ao "wrapper de compatibilidade de `rpc_create_sale`" sendo criado sem necessidade — ou seja, ao criar novas funções fiscais, evitar deixar overloads antigos para trás sem um plano explícito de quando serão removidos.

## `migrations-divergence-analysis.md` — o que precisa ser revisado

- **Escopo do problema estava subestimado.** A análise original tratava a lacuna de "objetos que predatam o histórico" como majoritariamente estrutural (tabelas, colunas, constraints estáticas). A validação real mostrou que **funções e triggers ativos e com efeito em dados de negócio a cada venda** (`set_sale_number`, `trigger_generate_cashback`) também estão nessa categoria — isso é qualitativamente mais sério, pois significa que ninguém consegue hoje ler, em nenhum arquivo do repositório, exatamente como a numeração de venda ou parte da geração de cashback funcionam.
- A recomendação de `pg_dump --schema-only` (§9 do documento original) continua correta, mas deve ser reclassificada de "recomendação de boa prática" para "**pré-requisito antes de qualquer alteração em `rpc_create_sale`, `sales`, numeração, ou cashback**" — não é mais só sobre ter uma referência mais confiável, é sobre não conseguir avaliar o impacto de uma mudança sem antes ler funções cujo corpo é hoje desconhecido.
- Ver detalhamento completo da atualização em [`database-source-of-truth-plan.md`](database-source-of-truth-plan.md), que já incorpora esses achados.

## `products-total-regression-analysis.md` — o que precisa ser revisado

- A Seção 7 ("Quantas vendas podem estar afetadas — estimativa") deve ser substituída pelo número real: **300**, não mais uma estimativa. Ver [`products-total-remediation-plan.md`](products-total-remediation-plan.md) para o número já incorporado.
- Todo o resto da análise de causa raiz, linha do tempo, e fórmula de reconstrução **foi confirmado, não refutado**, pelos dados reais — nenhuma mudança de conteúdo necessária além da atualização do número estimado para o número medido.

## `fiscal-database-validation-guide.md` — o que precisa ser revisado

- A consulta 4.2 (CHECK constraints) tem um erro de construção (comparação de `regclass::text` sem considerar `search_path`) — precisa ser substituída pela versão corrigida (comparando contra `'public.tabela'::regclass` diretamente, não `::text`). Ver a consulta corrigida em `fiscal-database-validation-results.md` §4. **Isto é uma correção de uma consulta minha, não um achado sobre o sistema auditado** — registrado por transparência.

---

## Resumo por categoria

### O que foi confirmado (sem mudança de conteúdo, só de confiança — de "por leitura de código" para "por dado real")
- `companies` sem nenhum campo fiscal, única linha, single-tenant real.
- `customers` sem PJ, `company_id` hardcoded até no `DEFAULT` da coluna.
- Regressão de `products_total`: causa raiz, linha do tempo, fórmula de reconstrução, ausência de interferência de cashback/frete/acréscimo.
- `products.sku` duplicado na prática (25 grupos, máx. 45).
- Nenhum enum, tabela ou função fiscal existe hoje.

### O que foi refutado (precisa correção nos documentos)
- Idempotência de `pedidos` é mais forte do que avaliado (`UNIQUE` real existe).
- `product_variations.sku_variation` tem `UNIQUE` real confirmado (era uma dúvida do próprio time do projeto).
- Sincronização de papel para JWT está ativa, não superada.
- Numeração de venda: mecanismo real é trigger, não `DEFAULT` de coluna — conclusão de risco rebaixada até confirmação do corpo da função.

### O que é novo (não estava em nenhum documento anterior)
- `pedidos.nf_status`, coluna órfã, não usada, não documentada.
- Segundo overload de `rpc_create_sale` (wrapper de 12 parâmetros), possivelmente desatualizado desde 10/06/2026.
- `trigger_generate_cashback()`, corpo desconhecido, risco não descartado de duplicação de cashback.
- Tabela `audit_log` (singular), órfã, 4.577 linhas, totalmente aberta a qualquer `authenticated`.
- Escopo real do problema de RLS: ~15 tabelas com acesso total (incluindo `users`, `finance_entries`), ~40 tabelas com RLS totalmente desabilitado — muito mais amplo do que as 5 tabelas originalmente suspeitas.

### O que continua sem resposta
- Corpo de `set_sale_number()`, `generate_sale_number(date)`, `trigger_generate_cashback()`, `audit_cash_trigger()` — não lido, consulta proposta e não executada.
- Distribuição de status (cancelada/paga/devolvida) entre as 300 vendas afetadas por `products_total` nulo.
- Se vendas Nuvemshop e pagamento misto seguem a mesma regra de `products_total` — alta confiança por desenho do código, não confirmado empiricamente.
- Existência e conteúdo de uma tabela de controle de migrations do Supabase CLI (`supabase_migrations.schema_migrations` ou equivalente) — não verificada.
- Estado real das CHECK constraints de `sales`/`sale_items`/`sale_payments`/`products`/`product_variations`/`customers` — minha consulta teve um bug, resultado inconclusivo, consulta corrigida proposta.
