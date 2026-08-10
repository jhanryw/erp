# Auditoria de Prontidão Fiscal (NF-e/NFC-e) — ERP Santtorini

**Data:** 2026-08-04
**Tipo:** Auditoria técnica READ-ONLY. Nenhum código, migration, dependência, container, variável de ambiente ou configuração foi alterado nesta fase. Nenhuma consulta SQL foi executada contra o banco (o repositório não tinha, no momento desta auditoria, acesso autenticado à instância Supabase live — todas as consultas propostas estão em [`docs/fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) para execução manual e revisão prévia).
**Método:** leitura completa de `supabase/migrations/*.sql` (110 arquivos), `src/lib/db/migrations/**` (2 árvores), `DATABASE_SCHEMA.sql`, `ARCHITECTURE.md`, `BUSINESS_RULES.md`, `TECHNICAL_NOTES.md`, e leitura direta de código-fonte em `src/app/api/**`, `src/services/**`, `src/lib/**`, `src/app/(dashboard)/**`. Toda afirmação abaixo é acompanhada de `arquivo:linha`.
**Regra observada:** nenhuma implementação foi feita. Este relatório é o encerramento da Fase 1 (auditoria) e o início da espera por autorização expressa para a Fase 2.

Documentos complementares produzidos nesta mesma auditoria:
- [`fiscal-open-questions.md`](fiscal-open-questions.md) — perguntas em aberto, com responsável e impacto
- [`fiscal-accounting-checklist.md`](fiscal-accounting-checklist.md) — checklist para a contabilidade (Índice Contabilidade)
- [`fiscal-sefaz-rn-checklist.md`](fiscal-sefaz-rn-checklist.md) — checklist para a SEFAZ/RN
- [`fiscal-implementation-plan.md`](fiscal-implementation-plan.md) — plano de implementação por fases
- [`fiscal-risk-register.md`](fiscal-risk-register.md) — registro de riscos classificados
- [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md) — arquitetura proposta em detalhe
- [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) — consultas SQL somente leitura para fechar os pontos que exigem banco live

---

## 1. Resumo Executivo

### O que já existe
- Uma aplicação Next.js 14 / React 18 / TypeScript madura, com ~124 arquivos referenciando `company_id` — ou seja, uma disciplina real de multi-tenancy no código de acesso a dados, mesmo operando hoje como single-tenant de fato.
- Um mecanismo de vendas (`rpc_create_sale`, `rpc_cancel_sale`, `rpc_return_sale`, `rpc_process_exchange`) transacional, com locks `FOR UPDATE`, `SECURITY DEFINER`, e guardas de estado que impedem cancelamento/devolução duplicados.
- Suporte a pagamento múltiplo/misto por venda (`sale_payments`, N linhas por venda) com bandeira de cartão e "adquirente" como campos estruturados (embora texto livre, sem enum).
- Um início de cadastro fiscal de produto: `ncm`, `cest`, `origem`, `unidade_med` existem em `products` desde `20260615_products_fiscal_fields.sql`, são validados por regex no formulário e persistidos ponta a ponta.
- Padrões de infraestrutura reaproveitáveis: verificação HMAC-SHA256 constant-time para webhooks inbound (Nuvemshop), um padrão de lock atômico via `UPDATE ... WHERE processing_lock=false RETURNING id` para idempotência de processamento, armazenamento privado no Supabase Storage com chave `{company_id}/{uuid}.{ext}` e signed URLs de 5 minutos, notificações push (web-push/VAPID) já cabeadas por `company_id`+`role`, e uma tabela de auditoria genérica (`audit_logs`) já em uso.
- RBAC de 3 níveis (`admin` > `gerente` > `usuario`) consistente em toda API de vendas/caixa, com um segundo mecanismo de elevação (`authorization_tokens`) para operações sensíveis feitas por `usuario`.

### O que não existe
- **Nenhum dado fiscal do emitente.** A tabela `companies` não tem CNPJ, IE, IM, CRT/regime tributário, nem endereço fiscal estruturado — bloqueador absoluto para o `<emit>` de qualquer NF-e/NFC-e (§4, §5).
- **Nenhum suporte a destinatário pessoa jurídica.** `customers` é exclusivamente PF (CPF), sem CNPJ/razão social/IE — bloqueador para qualquer NF-e emitida para CNPJ (atacado, B2B).
- **Nenhum dado tributário de operação.** CFOP, CST (ICMS/PIS/COFINS), CSOSN, alíquotas, FCP, ICMS-ST, IBS, CBS: zero ocorrências em qualquer migration ou código de aplicação, nas duas árvores de migration.
- **Nenhum modelo de documento fiscal.** Nenhuma tabela `fiscal_documents`/`nfe`/`nfce`, nenhum enum de status fiscal, nenhuma coluna de chave de acesso — confirma que este módulo é 100% novo, não uma retomada de trabalho anterior (nenhuma menção a NF-e/NFC-e em nenhum dos 110+36 arquivos de migration nem em `TECHNICAL_NOTES.md`/roadmap).
- **Nenhuma impressão de cupom/DANFE.** O único mecanismo de impressão do sistema é `window.print()` para etiquetas de envio A4 — não existe geração de PDF, agente de impressão local, QZ Tray, WebUSB/WebSerial, nem qualquer infraestrutura capaz de imprimir silenciosamente em impressora térmica USB.
- **Nenhum ambiente de homologação.** Não há `STAGING`/`HOMOLOG`/`SANDBOX` em nenhuma variável de ambiente ou código; não há `supabase/config.toml`; não há CI/CD (`.github/workflows` não existe). Deploy é via Dockerfile + EasyPanel, aparentemente por push manual.
- **Nenhuma fila/worker persistente.** Não há Redis, BullMQ, pg-boss ou qualquer biblioteca de fila no `package.json`. Todo processamento assíncrono hoje é HTTP-triggered por cron externo (EasyPanel) com um segredo `CRON_SECRET` compartilhado, ou fire-and-forget dentro da própria requisição.

### O que pode ser reaproveitado
Ver §8 (Arquitetura proposta) e [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md) — resumidamente: o padrão de lock de idempotência (`pedidos.processing_lock`), o padrão de storage privado por empresa (Media Hub), a verificação HMAC de webhook (hoje só inbound Nuvemshop, precisa virar utilitário reusável), a tabela `audit_logs` genérica, o padrão de push notification, e o padrão "enforcement no banco + cron de limpeza best-effort" do cashback (`cashback-expire`/`cashback-release`) como modelo para jobs de retry fiscal.

### Achado técnico mais crítico (não é hipótese, é fato confirmado por leitura de código)
`sales.products_total` — a coluna criada especificamente como mapeamento para `vProd` da NF-e (`supabase/migrations/20260613_shipping_fiscal_ready.sql:15-19,33-39`) — foi populada corretamente por exatamente uma versão da função `rpc_create_sale` (a do próprio dia 2026-06-13) e, a partir da reescrita seguinte (`20260614_rpc_create_sale_main_store_only.sql`), nunca mais apareceu na lista de colunas do `INSERT INTO sales`. Confirmado em 6 reescritas subsequentes até a versão vigente (`20260704_fix_cashback_expiry_and_earn.sql:268-273`). Isso significa que, se o banco em produção reflete os arquivos de migration, **toda venda criada desde 2026-06-14 tem `products_total = NULL`**, silenciosamente, há quase 7 semanas até a data desta auditoria. Nenhum código de aplicação lê ou escreve essa coluna (`grep -rln "products_total" src/` → zero arquivos). Isso precisa de confirmação por consulta live (query 1 em `fiscal-audit-readonly.sql`) e correção antes de qualquer trabalho de emissão fiscal poder assumir que esse campo é confiável.

### Principais riscos
Ver §6 e [`fiscal-risk-register.md`](fiscal-risk-register.md) para a lista classificada completa. Os cinco mais relevantes:
1. **Preço unitário de item de venda é 100% confiado do cliente HTTP**, sem reconciliação contra um preço de catálogo em nenhuma camada (API nem RPC) — crítico para qualquer motor fiscal que assuma `sale_items.unit_price` como valor real de transação.
2. **`sales.products_total` NULL silencioso** (acima).
3. **`companies` sem nenhum dado fiscal e sem RLS habilitado.**
4. **Ausência total de ambiente de homologação** — bloqueador regulatório antes de qualquer emissão real.
5. **Duas árvores de migration divergentes**, com `src/lib/db/migrations/000_schema_completo.sql` comprovadamente errado em pontos específicos (unicidade de SKU, tabelas `pedidos`/`pedidos_itens` ausentes) pelo próprio histórico de commits do projeto.

### Estratégia recomendada
**Classificação: parcialmente preparado, com fundação técnica reaproveitável e bloqueadores externos/regulatórios dominantes sobre os técnicos.** Ver comparação completa em §7. Recomendação preliminar: começar pela Fase 0 (regularização externa + saneamento técnico interno, ver `fiscal-implementation-plan.md`) em paralelo com a decisão de integração direta vs. API fiscal terceirizada — essa decisão não bloqueia o saneamento interno (corrigir `products_total`, travar edição pós-conclusão, cadastro fiscal do emitente) e pode amadurecer enquanto os dados de cadastro (CRT, NCM completo, credenciamento SEFAZ) são levantados junto à contabilidade e à Santtorini.

---

## 2. Arquitetura Atual

### Diagrama textual

```
┌──────────────────────────────────────────────────────────────────────┐
│                     EasyPanel (Docker, VPS)                          │
│  Deploy: git push → build Dockerfile (multi-stage, node:20-alpine)   │
│  Sem CI/CD (.github/workflows não existe). Sem homologação separada. │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │        Next.js 14.2 standalone (porta 3000, `node server.js`) │   │
│  │  App Router (RSC + RCC) + API Routes (/api/*, Node.js)        │   │
│  └──────────────────────┬──────────────────────────────────────┘   │
│                          │                                            │
│  ┌───────────────────────▼──────────────────────────────────────┐   │
│  │  Cron externo (EasyPanel) → HTTP + Bearer CRON_SECRET          │   │
│  │  /api/jobs/refresh-views, /cashback-release, /cashback-expire  │   │
│  │  /api/alerts/daily (WhatsApp via Evolution API)                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬───────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  Supabase (self-hosted ou      │
                    │  cloud — não determinável do   │
                    │  repo, sem config.toml)         │
                    │  Auth │ Postgres │ Storage      │
                    └───────────────────────────────┘
                                    ▲
                                    │ webhook HMAC-SHA256
                    ┌───────────────────────────────┐
                    │  Nuvemshop (Tiendanube) —       │
                    │  único canal de e-commerce      │
                    │  integrado hoje                 │
                    └───────────────────────────────┘
```

Não há fila (Redis/BullMQ inexistentes), não há worker persistente, não há ambiente de homologação da aplicação, não há pipeline de CI. Todo processamento assíncrono é HTTP-cron ou fire-and-forget in-request.

### Stack confirmada
| Item | Versão | Fonte |
|---|---|---|
| Next.js | `^14.2.0` (instalado 14.2.35) | `package.json:16` |
| React / React DOM | `^18.3.0` | `package.json:19-20` |
| TypeScript | `^5.5.0` (instalado 5.9.3) | `package.json:35` |
| Node.js (deploy) | 20 (alpine) | `Dockerfile:1,25` |
| Gerenciador de pacotes | npm (`package-lock.json` v3) | raiz do repo |
| Validação | zod `^3.23.0` | `package.json` |
| Banco/Auth/Storage | `@supabase/supabase-js` `^2.45.0`, `@supabase/ssr` `^0.5.0` | `package.json` |
| HTTP client | axios `^1.13.6` | `package.json` |
| **Ausentes, relevantes para fiscal** | Sem lib XML/SOAP, sem lib de certificado A1/A3, sem lib de geração de PDF (`jspdf`/`pdfmake`/`react-pdf`), sem fila (Redis/BullMQ/pg-boss) | grep completo em `package.json` |

### Fluxo de venda (PDV)
`src/app/(dashboard)/vendas/nova/page.tsx` — wizard de 4 passos (Itens → Cliente → Pagamento → Confirmar) → `POST /api/vendas` (`src/app/api/vendas/route.ts`) → `src/services/vendas.service.ts:createSale()` → RPC `rpc_create_sale` (versão vigente: `supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql`). A venda nasce diretamente com `status='paid'` — o valor `'pending'` do enum nunca é usado na prática (`20260627_rpc_create_sale_v4.sql:209`). Detalhes completos em §3 e §4.

### Fluxo de pagamento
Multi-pagamento via array `payments[]`, uma linha por método em `sale_payments`. Sem reconciliação servidor de que a soma bate com o total da venda (só há gate no frontend, `src/app/(dashboard)/vendas/nova/page.tsx:349-354` — contornável via chamada direta à API). Cashback pago 100% não gera nenhuma linha em `sale_payments` (`payments: []`), ficando invisível a qualquer reconciliação que consulte só essa tabela.

### Fluxo da Nuvemshop
Único webhook inbound do sistema: `src/app/api/webhooks/nuvemshop/order/route.ts`. Verificação HMAC-SHA256 constant-time (`:12-20`), sempre falha fechado em produção se `NUVEMSHOP_CLIENT_SECRET` ausente. Re-busca o pedido completo via API REST da Nuvemshop (não confia só no payload do webhook). Idempotência via `pedidos.processing_lock` (claim atômico por `UPDATE ... WHERE processing_lock=false`). Ao confirmar pagamento, chama a mesma `rpc_create_sale` do PDV — ou seja, pedidos de e-commerce e vendas de loja física convergem para a mesma tabela `sales`/`sale_items`/`sale_payments`. Não existe nenhum canal de retorno de chave fiscal para a Nuvemshop (nenhuma chamada a endpoints `orders/*` existe em `src/lib/integrations/nuvemshop.ts`, só `products/*`).

### Fluxo de cancelamento
`rpc_cancel_sale`/`rpc_return_sale` (`supabase/migrations/20260722_rpc_cancel_return_sale_no_finance_entry.sql`) — transacional, `FOR UPDATE`, bloqueiam re-cancelamento/re-devolução em ambas as direções. Desde 22/07/2026 não geram mais linha em `finance_entries` (mudança deliberada — a reversão contábil passou a ser lida via `sales.status`/`cancelled_at` por uma view de DRE). Um caminho paralelo de troca (`rpc_process_exchange`) usa tabelas próprias (`exchanges`/`exchange_items`), distintas do par legado `returns`/`return_items` que ainda existe no schema mas parece não ser mais o caminho ativo.

### Permissões (RBAC real, não o documentado em `ARCHITECTURE.md`)
`ARCHITECTURE.md:74-107` (datado de 15/03/2026) descreve 2 papéis (`admin`/`vendedor`) com gate de rota no middleware. **Isso está desatualizado.** O código atual (`src/types/roles.ts:40-58`, `src/lib/supabase/session.ts`) implementa 3 papéis (`admin` > `gerente` > `usuario`, hierarquia numérica 3>2>1), e o middleware (`src/middleware.ts`) faz **apenas autenticação**, não autorização por papel — a autorização é feita rota a rota via `requireRole()`/`requirePageRole()`. Todas as rotas de vendas/caixa auditadas têm pelo menos um `requireRole()`; nenhuma rota sem guard foi encontrada. Ver tabela completa em §3 (Inventário técnico) e a seção de RBAC no inventário de banco.

### Banco
Ver §4 (Inventário do banco) — resumo: Postgres via Supabase, RLS existe mas é defesa-em-profundidade apenas (a aplicação usa exclusivamente `service_role`, que ignora RLS — isolamento real acontece em TypeScript via `.eq('company_id', ...)`).

### Infraestrutura e deploy
Dockerfile multi-stage (`node:20-alpine`), `output: 'standalone'` no `next.config.js:3`. **Achado de segurança a corrigir independentemente do módulo fiscal:** `SUPABASE_SERVICE_ROLE_KEY` e `CRON_SECRET` são declarados como `ARG` de build no Dockerfile (`Dockerfile:5-9,16-21,29-40`) e viram `ENV` gravado na imagem — se o pipeline de build logar ARGs, esses segredos vazam para logs. Sem CI/CD versionado no repo; deploy presumivelmente via push manual + build automático do EasyPanel.

---

## 3. Inventário Técnico

Tabela dos componentes de código mais relevantes para o módulo fiscal, sua função, relação com fiscal, estado, risco e alteração potencial futura (nenhuma alteração foi feita nesta auditoria).

| Arquivo/Componente | Função | Relação com fiscal | Estado | Risco | Alteração potencial (futura) |
|---|---|---|---|---|---|
| `src/app/api/vendas/route.ts` | Criação de venda (POST), valida payload via zod | Ponto de origem de todo dado que viraria NF-e/NFC-e | Ativo, preço não validado server-side | Alto | Adicionar reconciliação de preço; disparar emissão fiscal pós-criação |
| `src/services/vendas.service.ts` | Camada de serviço da venda (createSale, cancelSale, returnSale) | Idem acima | Ativo | Médio | Ponto de integração natural para chamar o serviço fiscal |
| `supabase/migrations/20260704_fix_cashback_expiry_and_earn.sql` (RPC `rpc_create_sale` v5, vigente) | Transação atômica de criação de venda | Não popula `products_total`; não valida preço | Ativo, vigente | Alto | Reintroduzir `products_total`; adicionar `p_price_check` |
| `src/app/api/vendas/[id]/editar/route.ts` | PATCH de venda finalizada (`sale_origin`, `notes`, `sale_date`) | `sale_date` pode ser usado como referência de competência fiscal | Ativo, **sem checagem de `status`** | Alto | Bloquear edição após emissão fiscal autorizada |
| `src/app/api/vendas/[id]/cancelar/route.ts` | Cancelamento de venda | Precisa virar gatilho de evento de cancelamento fiscal | Ativo, token de autorização só para `usuario` | Médio | Adicionar chamada ao motor de cancelamento fiscal |
| `src/app/api/vendas/[id]/devolucao/route.ts` | Devolução total | Idem — devolução com nota fiscal emitida exige NF-e de devolução | Ativo | Médio | Requer desenho de NF-e de devolução |
| `src/app/api/vendas/[id]/troca/route.ts` | Troca (parcial ou total) | Exchange parcial não fecha `sales.status` | Ativo | Médio | Requer modelagem de documento fiscal complementar |
| `src/lib/auth/requirePageRole.ts`, `src/lib/supabase/session.ts` | RBAC (3 papéis) | Base para permissões de emitir/consultar/cancelar nota fiscal | Ativo, consistente | Baixo | Adicionar novas ações (`emit_fiscal`, `cancel_fiscal`) ao padrão `authorization_tokens` |
| `src/lib/auth/validateAuthorizationToken.ts` | Token de autorização de gerente (uso único, atômico) | Modelo reaproveitável para autorizar cancelamento fiscal | Ativo | Baixo | Estender `action` enum para incluir ações fiscais |
| `src/app/api/webhooks/nuvemshop/order/route.ts` | Webhook inbound único do sistema | Modelo de verificação HMAC e idempotência (`processing_lock`) | Ativo | Baixo (como referência) | Extrair HMAC/lock para utilitário compartilhado |
| `src/services/media.service.ts` | Upload/Storage privado por `company_id` | Modelo direto para armazenamento de XML/DANFE | Ativo | Baixo | Reaproveitar bucket/padrão de chave para `fiscal_files` |
| `src/lib/push/send.ts` | Push notification (VAPID) por `company_id`+`role` | Reaproveitável para alertas fiscais (certificado expirando etc.) | Ativo | Baixo | Chamar a partir de jobs fiscais |
| `src/app/api/alerts/daily/route.ts` | Alerta diário via WhatsApp (Evolution API) | Reaproveitável, mas hardcoded a 1 empresa/1 telefone | Ativo | Médio (não escalável) | Generalizar para `company_id` |
| `src/lib/audit/log.ts` (`audit_logs`) | Log de auditoria genérico (`resource`/`action`/before/after) | Reaproveitável para `resource: 'fiscal_document'` | Ativo | Baixo | Adotar convenção de `resource_type` fiscal |
| `src/app/(dashboard)/produtos/novo/page.tsx`, `.../[id]/editar/page.tsx` | Formulário de produto | Único lugar onde NCM/CEST/Origem/Unidade são preenchidos hoje | Ativo, campos opcionais | Alto (dados incompletos) | Tornar obrigatório antes de venda fiscal; adicionar CFOP/CST/CSOSN/GTIN |
| `src/app/(dashboard)/clientes/novo/page.tsx`, `.../[id]/editar/page.tsx` | Formulário de cliente | Único PF, sem CNPJ/endereço estruturado | Ativo | Alto | Adicionar suporte PJ e endereço IBGE |
| `src/app/(dashboard)/vendas/[id]/imprimir/*` | Impressão de etiqueta A4 (não é cupom) | Não serve para DANFE térmica | Ativo, mas não relacionado a fiscal | — | Nova infraestrutura de impressão necessária (ver §8) |
| `src/app/api/jobs/*` (3 rotas) | Cron HTTP (`CRON_SECRET`) | Modelo de job para retry/expiração fiscal | Ativo | Baixo | Adicionar `fiscal-retry`/`fiscal-certificate-alert` seguindo o mesmo padrão |
| `Dockerfile` | Build/deploy | Segredos como build ARG (risco) | Ativo | Médio | Corrigir antes de introduzir segredos de certificado digital |
| `src/lib/db/migrations/000_schema_completo.sql` | "Schema consolidado" (árvore legada) | Comprovadamente desatualizado em pontos-chave | Obsoleto/não confiável | Alto (se usado como referência) | Não usar como fonte de verdade; considerar depreciar |

---

## 4. Inventário do Banco

Tabelas mais relevantes para o módulo fiscal. `company_id` = presença de coluna de multi-tenant. RLS = estado real da política (verificar com `fiscal-audit-readonly.sql`, query de `pg_policies`, antes de confiar cegamente nesta coluna).

| Tabela | Finalidade | PK | `company_id`? | RLS | Campos úteis p/ NF-e/NFC-e | Campos ausentes (fiscal) | Riscos |
|---|---|---|---|---|---|---|---|
| `companies` | Tenant/empresa | `id SERIAL` | (é a própria) | **Nenhuma policy encontrada; RLS não habilitado** | `name` | CNPJ, IE, IM, CRT, endereço fiscal completo, código IBGE | Bloqueador total do `<emit>` |
| `products` | Catálogo | `id SERIAL` | sim | SELECT company-scoped | `ncm`, `cest`, `origem`, `unidade_med` (todos nullable, sem CHECK) | CFOP, CST(ICMS/PIS/COFINS), CSOSN, alíquotas, FCP, ICMS-ST, IBS, CBS, GTIN | Dados fiscais incompletos e sem enforcement |
| `product_variations` | SKU/variação | `id SERIAL` | via `products` | **RLS habilitado, sem policy** | — (fiscal fica só no produto-pai) | GTIN por variação inexistente | Bloqueia diferenciação fiscal por variação se necessário |
| `customers` | Cliente | `id SERIAL` | sim | ALL company-scoped | `name`, `cpf` (nullable), `email`, `city`, `state` | CNPJ, razão social, IE, indicador IE, CEP, logradouro, código IBGE | Bloqueia venda B2B/CNPJ; endereço não estruturado p/ NF-e |
| `sales` | Venda | `id SERIAL` | sim | SELECT company-scoped | `sale_number`, `total`, `subtotal`, `discount_amount`, `shipping_charged`, `sale_date`, `cancelled_at/by`, `returned_at/by` | Nenhum vínculo a documento fiscal | `products_total` (vProd) NULL desde 14/06/2026 (ver Resumo Executivo) |
| `sale_items` | Item de venda | `id SERIAL` | via `sales` | **RLS habilitado, sem policy** | `unit_price`, `quantity`, `discount_amount`, `total_price` | Sem snapshot de NCM/CST/CFOP no momento da venda (buscaria live de `products`) | Preço não validado contra catálogo |
| `sale_payments` | Pagamento (N por venda) | `id BIGSERIAL` | sim | SELECT admin/gerente | `method`, `card_brand`, `acquirer`, `installments`, `net_amount` | NSU, código de autorização, CNPJ da adquirente (só em `metadata` JSONB não populado) | Soma não reconciliada com `sales.total` no servidor |
| `pedidos`/`pedidos_itens` | Staging de pedido Nuvemshop | — | sim | não auditado em detalhe | `payment_method` mapeado da Nuvemshop | — | **`CREATE TABLE` não existe em nenhuma migration versionada — drift de schema confirmado** |
| `produto_map` | Crosswalk produto ERP↔Nuvemshop | `id BIGSERIAL` | não (é global) | não auditado | — | — | Sem dado de pagamento (é só produto) |
| `exchanges`/`exchange_items` | Troca | `id SERIAL` | sim | não auditado em detalhe | `returned_amount`, `credit_issued` | Sem vínculo a documento fiscal de devolução | Caminho paralelo a `returns`/`return_items` legado, ambos no schema |
| `returns`/`return_items` | Devolução (legado?) | `id SERIAL` | não direto | não auditado em detalhe | — | — | Não fica claro qual tabela é autoritativa hoje |
| `cashback_transactions` | Cashback | `id SERIAL` | sim | não auditado em detalhe | — | — | Cashback não aparece em `sale_payments` |
| `audit_logs` | Auditoria genérica | `id BIGSERIAL` | via `resource`/contexto | RLS habilitado (`archive/001_rls_and_audit.sql`) | `action`, `resource`, `before_data`, `after_data` | — | Reaproveitável para trilha fiscal |
| `stock_lots`/`stock_balances`/`stock_movements` | Estoque | — | sim | SELECT scoped | — | — | Corrida em `consume_stock_fifo` documentada em `TECHNICAL_NOTES.md` como risco não mitigado |

**Sobre as duas árvores de migration:** `supabase/migrations/*.sql` (110 arquivos, ativa) é a fonte de verdade para tudo criado/alterado a partir de meados de maio de 2026. `src/lib/db/migrations/000_schema_completo.sql` (árvore legada, "schema consolidado") contém a única cópia rastreada do `CREATE TABLE` de `companies`, `products`, `customers`, `sales`, mas **foi comprovadamente errado em pelo menos 3 pontos por admissão do próprio time** (unicidade de `products.sku`, tabela `stock`/`stock_balances`, e `rpc_stock_initialize` — citado em `supabase/migrations/202607302600_pim_product_sku_identity.sql:12-18`) e **não contém `pedidos`/`pedidos_itens`** — tabelas ativamente usadas e alteradas. Nenhuma das duas árvores contém o schema-base real (`CREATE TABLE companies/products/customers/pedidos` não aparece em `supabase/migrations/`, e a versão em `000_schema_completo.sql` já foi desmentida). **Recomendação, já registrada na auditoria anterior e reforçada aqui: um `pg_dump --schema-only` do banco real deve preceder qualquer desenho definitivo do módulo fiscal.**

---

## 5. Gap Analysis Fiscal

Legenda: ✅ Existe · 🟡 Existe parcialmente · ❌ Não existe · ❓ Não foi possível confirmar sem banco live

| Requisito | Status | Risco | Ação necessária | Responsável |
|---|---|---|---|---|
| CNPJ/IE/IM/CRT/endereço fiscal do emitente | ❌ | Crítico | Criar campos em `companies` (ou tabela `fiscal_establishments`) | Dev + Santtorini + contabilidade |
| Código IBGE do município (emitente e destinatário) | ❌ | Crítico | Adicionar coluna + tabela de referência IBGE | Dev |
| CNPJ/razão social/IE do destinatário PJ | ❌ | Crítico (bloqueia NF-e p/ CNPJ) | Estender `customers` para PJ | Dev |
| Endereço estruturado do destinatário (logradouro/número/bairro/CEP) | ❌ | Alto | Estender `customers` | Dev |
| NCM | 🟡 (nullable, sem enforcement, dados incompletos confirmados por flag de qualidade existente `product_no_ncm`) | Alto | Tornar obrigatório antes de venda fiscal + campanha de preenchimento | Santtorini + contabilidade |
| CEST | 🟡 (idem NCM) | Médio | Idem | Santtorini + contabilidade |
| Origem da mercadoria (0-8) | 🟡 (nullable) | Médio | Tornar obrigatório | Dev + contabilidade |
| Unidade comercial/tributável | 🟡 (só uma unidade, sem distinção comercial/tributável) | Médio | Avaliar se precisa de 2ª coluna | Dev + contabilidade |
| GTIN/EAN comercial e tributável | ❌ | Alto (obrigatório informar "SEM GTIN" corretamente se ausente) | Adicionar campo, mesmo que opcional/"sem GTIN" | Dev |
| CSOSN | ❌ | Crítico | Depende do CRT confirmado; modelar tabela de regras tributárias | Contabilidade define, dev modela |
| CST ICMS/PIS/COFINS | ❌ | Crítico | Idem | Contabilidade define, dev modela |
| CFOP | ❌ | Crítico | Modelar matriz de decisão por operação/UF/canal | Contabilidade + dev |
| Alíquotas (ICMS/PIS/COFINS) | ❌ | Alto | Depende do CRT/regime | Contabilidade |
| Benefícios fiscais / código de benefício | ❓ | Médio | Perguntar à contabilidade se aplicável | Contabilidade |
| FCP | ❌ | Médio | Depende de UF de destino | Contabilidade |
| ICMS-ST | ❌ | Médio | Depende de NCM/categoria | Contabilidade |
| IBS/CBS (Reforma Tributária) | ❌ | Alto (cronograma 2026+) | Acompanhar leiaute vigente antes de codificar | Dev, consultando fonte oficial |
| Numeração/série de NF-e/NFC-e | ❌ | Crítico | Criar `fiscal_document_series` com reserva transacional (não `MAX()+1`) | Dev |
| Certificado digital | ❌ (empresa não possui) | Crítico/bloqueador externo | Providenciar certificado + definir armazenamento seguro | Santtorini |
| CSC (NFC-e) | ❌ | Crítico/bloqueador externo | Providenciar junto à SEFAZ/RN | Santtorini |
| Credenciamento SEFAZ/RN | ❓ (empresa não sabe se está credenciada) | Crítico/bloqueador externo | Confirmar com SEFAZ/RN | Santtorini |
| Ambiente de homologação (SEFAZ) | ❌ | Crítico | Modelar ambiente + credenciais separadas | Dev + Santtorini |
| Ambiente de homologação (aplicação) | ❌ | Crítico | Criar staging separado antes de testar emissão real | Dev |
| Armazenamento de XML/DANFE | ❌ (mas padrão de storage reaproveitável existe) | Alto | Criar bucket/estrutura dedicada + política de retenção legal | Dev |
| Idempotência de emissão fiscal | ❌ (mas padrão de lock reaproveitável existe) | Alto | Modelar chave de idempotência por venda+modelo+série+finalidade | Dev |
| Trava de edição pós-emissão | ❌ (endpoint de edição hoje não checa status) | Alto | Bloquear edição de venda após nota autorizada | Dev |
| RBAC para emitir/consultar/cancelar fiscal | 🟡 (infra de 3 papéis + token de autorização já existe, falta a ação específica) | Baixo | Estender enum de `authorization_tokens.action` | Dev |
| Impressão de DANFE/cupom térmico | ❌ | Alto | Nova infraestrutura de impressão (ver §8) | Dev |
| Webhook de eventos fiscais (assinado, com retry) | ❌ (padrão HMAC inbound existe, mas não outbound com retry) | Médio | Construir do zero, reaproveitando o padrão HMAC | Dev |
| Diferenciação contribuinte/não-contribuinte/consumidor final | ❌ | Alto | Modelar na camada de regras de operação | Dev + contabilidade |
| Matriz de decisão NF-e vs NFC-e por canal | ❌ | Alto | Desenhar com base em modelo de operação, não em nome do canal | Dev + contabilidade |
| Retorno de chave fiscal para Nuvemshop | ❌ | Médio (não bloqueia PDV) | Nova integração (endpoint `orders/*` nunca usado hoje) | Dev |

---

## 6. Riscos Críticos

Classificação completa e detalhada em [`fiscal-risk-register.md`](fiscal-risk-register.md). Resumo por severidade:

**Crítico (bloqueiam qualquer emissão real):**
- Ausência total de dados fiscais do emitente (`companies`).
- Ausência de suporte a destinatário PJ.
- Ausência de CFOP/CST/CSOSN/alíquotas em qualquer lugar do sistema.
- Ausência de certificado digital, CSC e confirmação de credenciamento SEFAZ/RN (bloqueadores externos, não técnicos).
- Ausência de ambiente de homologação (aplicação e SEFAZ).

**Alto:**
- `sales.products_total` (vProd) silenciosamente NULL desde 14/06/2026.
- Preço unitário de item de venda não validado contra catálogo.
- Endpoint de edição de venda (`/api/vendas/[id]/editar`) sem trava de status — permite editar `sale_date`/`notes`/`sale_origin` de venda cancelada/devolvida.
- Ausência de infraestrutura de impressão térmica/DANFE.
- Duas árvores de migration divergentes, uma comprovadamente errada em pontos estruturais.
- `products.sku` sem UNIQUE real (admitido pelo próprio time em migration datada).

**Médio:**
- Numeração de venda (`generate_sale_number`) é `COUNT()+1` global (não por empresa), com corrida latente mitigada só por `UNIQUE` (falha dura, sem retry).
- Split de pagamento não reconciliado contra o total da venda no servidor.
- Cashback não aparece em `sale_payments`, dificultando reconciliação.
- `RLS` habilitado sem policy em `sale_items` e `product_variations`; `companies` sem RLS nenhuma.
- Segredos (`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`) como build ARG no Dockerfile.
- Trocas parciais não fecham `sales.status`, deixando o registro "paid" mesmo com parte do valor revertido.

**Baixo:**
- Falta de CI/CD (afeta qualidade geral, não é fiscal-específico, mas eleva o risco de regressão em qualquer mudança futura no motor de vendas).
- `webhook_log`/idempotência de webhook outbound com checagem não-atômica em uma das duas versões existentes (v1 do webhook N8N).

---

## 7. Comparação: Integração Direta vs. API Fiscal Terceirizada

| Critério | Estratégia A — Direta com SEFAZ | Estratégia B — API fiscal terceirizada |
|---|---|---|
| Prazo relativo | Longo — exige implementar geração de XML, assinatura, SOAP, schemas, contingência, DANFE do zero | Curto/médio — provedor já resolve XML/schema/assinatura/contingência |
| Complexidade | Alta — equipe pequena (uso próprio, sem time fiscal dedicado) absorve manutenção contínua de notas técnicas e leiautes | Baixa/média — complexidade delegada ao provedor, ERP consome API REST/webhook |
| Risco fiscal | Alto no curto prazo (equipe sem histórico de emissão fiscal, primeira implementação) | Menor — provedor já homologado e testado por múltiplos clientes |
| Custo inicial | Baixo em licença, alto em horas de desenvolvimento e testes | Custo de setup do provedor, geralmente menor em horas de dev |
| Custo recorrente | Baixo (sem mensalidade de terceiro), mas custo oculto em manutenção contínua | Mensalidade/por-nota, previsível |
| Manutenção | Interna, permanente — cada nota técnica da SEFAZ e a Reforma Tributária exigem atualização própria | Delegada ao provedor (mas depende do SLA e da qualidade do provedor) |
| Lock-in | Nenhum (controle total do XML/assinatura) | Existe — depende de política de exportação de XML e portabilidade do provedor |
| Controle completo | Total | Parcial — depende do que o provedor expõe |
| Adequação ao volume atual (~200 vendas/mês) | Tecnicamente viável, mas desproporcional ao esforço de manutenção para esse volume | Bem adequado — a maioria dos provedores tem planos para esse volume |
| Adequação ao crescimento | Escala bem tecnicamente, mas o custo de manutenção cresce com a complexidade fiscal (Simples Nacional hoje, mas cenário pode mudar) | Escala financeiramente (custo por nota), tecnicamente delegado |
| Suporte a NFC-e + NF-e simultaneamente | Precisa implementar ambos os modelos do zero | A maioria dos provedores relevantes já suporta ambos |
| Suporte à Reforma Tributária (IBS/CBS) | Responsabilidade 100% interna de acompanhar cronograma e schemas | Normalmente já roadmapeado pelo provedor — mas **confirmar isso é obrigatório antes de decidir**, não presumir |

**Recomendação preliminar, fundamentada nos critérios de prioridade definidos (menor risco fiscal > implementação mais rápida > controle > custo mensal > manutenção > volume):** para uma operação de ~200 vendas/mês, sem time fiscal dedicado, sem histórico de emissão, e com o PDV físico como prioridade operacional, a **Estratégia B (API fiscal terceirizada)** tende a atender melhor os dois primeiros critérios (menor risco fiscal e implementação mais rápida), que têm prioridade sobre custo mensal na ordem definida pelo usuário. Isso é uma recomendação preliminar para direcionar a pesquisa de fornecedores (não uma contratação) — a decisão final deve vir depois de: (a) confirmar CRT/regime junto à contabilidade, (b) levantar pelo menos 2-3 provedores com suporte confirmado a NFC-e modelo 65 + SEFAZ/RN + Simples Nacional + IBS/CBS roadmap, comparando SLA, armazenamento de XML, portabilidade e webhooks. Nenhum fornecedor foi contratado ou integrado nesta fase.

---

## 8. Arquitetura Proposta

Ver documento completo: [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md). Resumo dos componentes:

- **Séries e numeração:** tabela `fiscal_document_series` por empresa+modelo+ambiente, com reserva de número via `UPDATE ... RETURNING` transacional (nunca `MAX()+1`), seguindo o mesmo padrão de `sale_number` mas corrigindo sua fraqueza (§4, §6).
- **Documentos e eventos:** `fiscal_documents` (cabeçalho + snapshot fiscal imutável pós-autorização), `fiscal_document_items` (snapshot de NCM/CST/CFOP/alíquota no momento da emissão — não reler de `products` depois), `fiscal_document_events` (autorização, rejeição, cancelamento, inutilização), `fiscal_transmission_attempts` (histórico de tentativas, para retry com backoff).
- **Cadastro fiscal:** `fiscal_establishments` (dados do emitente por empresa, hoje ausentes em `companies`), `fiscal_credentials` (referência a segredo de certificado/CSC, nunca o segredo em si), `fiscal_tax_profiles`/`fiscal_operation_rules` (separação entre dado intrínseco do produto e regra tributária da operação, conforme pedido no prompt-mestre §10).
- **Idempotência:** reaproveitar o padrão `processing_lock` de `pedidos`, mas com `UNIQUE` real (não apenas índice) na chave natural (`sale_id`+`document_type`+`purpose`).
- **Storage:** reaproveitar `src/services/media.service.ts` — bucket privado, chave `{company_id}/{environment}/{document_type}/{ano}/{mes}/{uuid}.{ext}`, signed URL de curta duração para DANFE.
- **Fila/retry:** como não há Redis/worker hoje, propor um job HTTP-cron (`/api/jobs/fiscal-retry`) seguindo o padrão de `cashback-expire`, com backoff calculado em SQL (não em memória) e um estado `dead_letter` explícito após N tentativas.
- **Webhooks/eventos:** extrair a verificação HMAC do Nuvemshop para um utilitário compartilhado; novo sistema de webhook outbound assinado (`fiscal.document.authorized` etc.) com secret por assinante, timestamp, idempotência e histórico — não existe hoje, precisa ser construído.
- **Homologação:** variável de ambiente nova (`FISCAL_ENVIRONMENT=homologacao|producao`), tabela `fiscal_document_series` particionada por ambiente, sem impacto nas séries de produção.
- **Impressão:** avaliar 3 caminhos (impressão via página dedicada + PDF gerado no servidor; agente local tipo QZ Tray; ou impressão HTML direta) — nenhum existe hoje, requisitos mínimos descritos no documento de arquitetura.

---

## 9. Modelo de Dados Proposto

Ver documento completo: [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md). Somente proposta — nenhuma migration criada nesta fase. Entidades sugeridas, nomeadas para aderir ao padrão do projeto (snake_case, prefixo `fiscal_`):

- `fiscal_establishments` — dados fiscais do emitente por `company_id` (CNPJ, IE, IM, CRT, endereço, IBGE)
- `fiscal_credentials` — referência ao segredo do certificado/CSC (nunca o valor em si)
- `fiscal_document_series` — série/numeração por empresa+modelo+ambiente
- `fiscal_documents` — cabeçalho do documento fiscal + snapshot imutável pós-autorização
- `fiscal_document_items` — snapshot de item (NCM/CST/CFOP/alíquotas no momento da emissão)
- `fiscal_document_payments` — snapshot de pagamento vinculado ao documento
- `fiscal_document_events` — eventos (autorização, rejeição, cancelamento, inutilização, contingência)
- `fiscal_transmission_attempts` — histórico de tentativas de transmissão (para retry/backoff)
- `fiscal_tax_profiles` — regras tributárias por operação/UF/regime (separado do dado intrínseco do produto)
- `fiscal_operation_rules` — matriz de decisão NF-e vs NFC-e por canal/operação/destinatário
- `fiscal_product_profiles` (ou extensão de `products`) — NCM/CEST/origem/unidade/GTIN completos + CSOSN/CST/CFOP padrão do produto
- `fiscal_files` — metadado de XML/DANFE armazenado (reaproveitando o Storage já existente)
- `fiscal_webhook_deliveries` — histórico de entrega de webhook fiscal assinado
- `fiscal_audit_logs` — pode reaproveitar `audit_logs` existente com convenção de `resource_type`, em vez de tabela nova

---

## 10. Máquina de Estados Proposta

Ver detalhamento completo em [`fiscal-architecture-proposal.md`](fiscal-architecture-proposal.md). Estados sugeridos para `fiscal_documents.status`:

```
draft → pending_validation → validation_failed
                            → ready → queued → processing → submitted
                                                            → authorized
                                                            → rejected
                                                            → pending_consultation
                                                            → contingency
authorized → cancellation_pending → cancelled
authorized → technical_failure (falha após autorizado, ex.: falha ao gerar DANFE)
```

Regras: transição só via função transacional (mesmo padrão de `rpc_cancel_sale`, com `FOR UPDATE`); `authorized` é imutável para os campos de snapshot fiscal (qualquer erro pós-autorização segue procedimento fiscal formal — carta de correção ou cancelamento —, nunca UPDATE direto); nenhum estado permite retransmissão sem antes consultar a situação quando há timeout (evitar duplicidade).

---

## 11. Plano de Implementação por Fases

Ver documento completo: [`fiscal-implementation-plan.md`](fiscal-implementation-plan.md). Resumo:

- **Fase 0 — Regularização e dependências externas:** credenciamento SEFAZ/RN, certificado digital, CSC, endereço fiscal definitivo, CRT confirmado pela contabilidade, planilha fiscal de produtos, ambiente de homologação. Em paralelo: saneamento técnico interno (corrigir `products_total`, travar edição pós-conclusão de venda, validar preço server-side, reconciliar schema real via `pg_dump`).
- **Fase 1 — Fundação técnica:** modelo de dados fiscal, segurança de segredos, séries/numeração, storage, logs, RBAC estendido, idempotência.
- **Fase 2 — Cadastro fiscal:** produtos (NCM/CEST/CFOP/CST/CSOSN completos), clientes (PJ, endereço IBGE), validação, importação em massa.
- **Fase 3 — NFC-e em homologação:** PDV, emissão manual, consulta, DANFE, cancelamento, contingência, testes.
- **Fase 4 — NF-e em homologação:** e-commerce, atacado, CNPJ, interestadual, Nuvemshop, DANFE, eventos.
- **Fase 5 — Produção controlada:** piloto, monitoramento, rollback, aprovação da contabilidade, liberação gradual.

---

## 12. Checklist para a Santtorini

Resumo (ver detalhamento cruzado com contabilidade/SEFAZ nos documentos dedicados):
- Confirmar/obter certificado digital (recomendação técnica de tipo em `fiscal-architecture-proposal.md`).
- Confirmar situação de credenciamento na SEFAZ/RN para NF-e e NFC-e.
- Obter/confirmar CSC de homologação e de produção para NFC-e.
- Concluir alteração do endereço fiscal para o endereço da loja física (ou confirmar que o endereço atual é o definitivo).
- Validar com a contabilidade o CRT e o enquadramento completo no Simples Nacional.
- Providenciar planilha fiscal de produtos (NCM/CEST/CFOP/CST/CSOSN por categoria) junto à contabilidade.
- Decidir, com apoio técnico, entre integração direta e API fiscal terceirizada (ver §7).
- Autorizar formalmente o início da Fase 2 (implementação) somente após este relatório ser revisado.

## 13. Checklist para a Contabilidade

Ver documento dedicado completo: [`fiscal-accounting-checklist.md`](fiscal-accounting-checklist.md) — modelo pronto para envio à Índice Contabilidade.

## 14. Checklist para a SEFAZ/RN

Ver documento dedicado completo: [`fiscal-sefaz-rn-checklist.md`](fiscal-sefaz-rn-checklist.md).

## 15. Perguntas Ainda Não Respondidas

Ver documento dedicado completo: [`fiscal-open-questions.md`](fiscal-open-questions.md) — cada pergunta com motivo, responsável, impacto e se bloqueia ou não a implementação.

---

## Notas Finais desta Fase

- Este relatório não implica autorização para qualquer alteração de código, migration, dependência ou infraestrutura. Nenhuma mudança foi feita.
- Vários achados desta auditoria dependem de confirmação por consulta SQL somente leitura contra o banco real — essas consultas estão prontas em [`fiscal-audit-readonly.sql`](fiscal-audit-readonly.sql) para revisão e execução manual, e não foram executadas automaticamente.
- Um achado técnico (regressão de `products_total`) e um achado estrutural (divergência entre as duas árvores de migration) são independentes da decisão fiscal em si e podem ser corrigidos antes ou em paralelo à Fase 0, mediante autorização expressa separada — eles não fazem parte desta auditoria como "corrigidos", apenas "identificados".
