# Fase Fiscal 3 — Auditoria Completa do Fluxo Fiscal/NF-e

Documento de auditoria pura — **nenhum código foi alterado, nenhuma migration foi criada**. Todas as afirmações têm evidência (arquivo:linha) coletada por leitura direta do código nesta rodada. Onde uma decisão depende de regra de negócio, isso está marcado explicitamente como **DECISÃO NECESSÁRIA**, com opções e uma recomendação — não decidido silenciosamente.

---

## 1. Estado atual — o que já existe

### 1.1 Schema (confirmado por leitura das migrations)

**`company_fiscal_settings`** (`20260821_focus_nfe_fiscal_foundation.sql:132-164`, + `telefone`/`email` em `20260822`): `id`, `company_id` (UNIQUE FK), `cnpj`, `razao_social`, `nome_fantasia`, `inscricao_estadual`, `crt` (CHECK 1-4), `logradouro`, `numero_endereco`, `complemento`, `bairro`, `municipio`, `municipio_ibge`, `uf`, `cep`, `nfe_enabled` (default false), `nfe_environment` (CHECK homologacao/producao, default homologacao), `default_cfop_internal`, `default_cfop_interstate`, `consumer_final_default`, `telefone`, `email`, timestamps. RLS habilitada, **zero policies** (só `service_role`).

**`fiscal_documents`** (`20260821...sql:183-237` + `20260824...sql:45-49`): `id`, `company_id`, `sale_id` (FK, NOT NULL), `document_type` (CHECK só `'nfe'`), `provider` (CHECK só `'focus_nfe'`), `environment`, `provider_ref`, `status` (CHECK, 8 valores — ver §4), `number`, `series`, `access_key`, `authorization_protocol`, `status_sefaz`, `status_message`, `submission_error_code`, `submission_error_message`, `issued_at`, `authorized_at`, `cancelled_at`, `provider_payload` (JSONB), `request_payload` (JSONB), `fiscal_context_snapshot` (JSONB), `xml_path`, `danfe_path`, timestamps. Constraints: `UNIQUE(provider, provider_ref)`, `UNIQUE(access_key) WHERE access_key IS NOT NULL`, `UNIQUE(sale_id, document_type) WHERE status='authorized'`. Índices em `company_id`, `sale_id`, `status`. RLS habilitada, **zero policies**.

**`fiscal_document_items`** (`20260821...sql:278-307`): snapshot imutável por item — `ncm`, `cest`, `origem` (CHECK 0-8), `cfop`, `csosn_cst`, `tax_details` (JSONB), valores. RLS habilitada, **zero policies**.

**`ibge_municipios`** (`20260823...sql:22-31`): cache `(codigo_ibge PK, uf, nome, nome_normalizado)`. **Sem UNIQUE em `(uf, nome_normalizado)`** — só PK em `codigo_ibge`. RLS habilitada, **zero policies**.

**`company_integrations.provider`** CHECK inclui `'focus_nfe'` (`20260821...sql:122-124`).

**Débito técnico confirmado**: nenhuma das 4 tabelas acima existe em `database.types.ts` — todo acesso é `(admin as any)`.

### 1.2 Máquina de estados do documento fiscal — o que realmente está implementado

8 estados no CHECK (`20260821...sql:202-207`): `draft`, `validation_failed`, `pending`, `authorized`, `authorization_failed`, `submission_error`, `cancelled`, `cancellation_failed`.

**Achado crítico: cancelamento NÃO está implementado.** `httpClient.ts` expõe só 5 funções (`listFocusEmpresas`, `createFocusEmpresa`, `updateFocusEmpresa`, `consultFocusNfe`, `issueFocusNfe`) — **nenhum `DELETE /v2/nfe`**, confirmado por grep no repositório inteiro (zero código, só o próprio comentário admitindo a lacuna em `httpClient.ts:12-13`). Os estados `cancelled`/`cancellation_failed` só podem ser **refletidos passivamente** se uma consulta (`GET /v2/nfe/{ref}`) retornar esse status (ex.: alguém cancelou pelo painel da Focus) — nunca são **iniciados** por este ERP. Além disso, `cancelled_at` é uma coluna que **nunca é escrita por nenhum código**, mesmo no caminho passivo.

### 1.3 Focus HTTP client

| Função | Método | Path | Implementada |
|---|---|---|---|
| `listFocusEmpresas` | GET | `/v2/empresas?cnpj=` | ✅ |
| `createFocusEmpresa` | POST | `/v2/empresas` | ✅ |
| `updateFocusEmpresa` | PUT | `/v2/empresas/{id}` | ✅ |
| `consultFocusNfe` | GET | `/v2/nfe/{ref}` | ✅ |
| `issueFocusNfe` | POST | `/v2/nfe?ref=` | ✅ |
| Cancelar NF-e | DELETE | `/v2/nfe/{ref}` | ❌ não existe |
| Download XML/DANFE (conteúdo) | — | — | ❌ só URL é guardada (`xml_path`/`danfe_path`), nunca o conteúdo baixado |
| Webhook Focus | — | — | ❌ não existe (confirmado: nenhuma rota em `src/app/api/webhooks/` ou `src/app/api/integrations/*/webhook*` é da Focus — só existe Chatwoot e Nuvemshop) |

### 1.4 Payload/validação/transmissão

- `taxRules.ts`: só CRT 1 e 4 suportados — CRT 2/3 lançam `FiscalRuleNotImplementedError`.
- `buildNfePayload.ts`/`buildFiscalSnapshot.ts`: puros, lançam `FiscalBuildError` se faltar campo obrigatório.
- `validateFiscalReadiness.ts`: puro, **nunca lança** — devolve lista de erros.
- `loadSaleFiscalContext.ts`: único módulo de I/O — nunca inventa dado, campo ausente vira `null`.
- `resolveMunicipioIbge.ts`: nunca lança, devolve `null` em qualquer falha.
- `submitNfeHomologacao.ts` (idempotência):
  - `provider_ref` determinístico: `qarvon-{company_id}-{sale_id}-nfe`.
  - Backstop real é o **UNIQUE(provider, provider_ref)** do banco — não só checagem em aplicação.
  - `authorized`/`cancelled` → nunca reemite. `pending` → sempre consulta antes de reemitir. Demais estados → reaproveita a mesma linha/ref.
  - Timeout de rede → `pending` (resultado desconhecido), nunca `submission_error` — distinção correta.
  - **Nenhum lock de linha (`FOR UPDATE`)** — grep confirmou zero uso em `src/services/fiscal/`, `src/lib/fiscal/`. A única proteção de concorrência é o UNIQUE constraint no INSERT inicial.

### 1.5 Rotas e UI

Todas as 5 rotas fiscais (`empresa`, `health` [GET+POST], `nfe/consultar`, `nfe/emitir-homologacao`, `nfe/preview`) são `requireRole('admin')` — **nenhuma usa `gerente`**. Página `/configuracoes/fiscal` é `requirePageRole('admin')`. Card de emissão em `/vendas/[id]` só renderiza se `profile.role === 'admin'`, e a rota por trás re-valida admin de novo (defesa em profundidade real).

**Achado**: `POST /api/fiscal/empresa` (sincroniza cadastro + certificado com a Focus) **não é chamado por nenhuma tela** — só alcançável via chamada HTTP direta (o script `focus-nfe-integration-setup.mjs` ou uma ferramenta tipo Postman).

### 1.6 Numeração

Reconfirmado: nenhum código envia `numero`/`serie` no payload de emissão (grep no payload inteiro — só existem `numero_item`/`numero_destinatario`, que são outra coisa). **A Focus controla numeração de NF-e integralmente.**

### 1.7 RPCs de venda — comportamento atual (fonte: `20260817_sale_rpcs_emit_outbox_events.sql`, definição vigente confirmada)

| RPC | Transição de status | Estoque | Financeiro | Evento outbox | Referencia `fiscal_documents`? |
|---|---|---|---|---|---|
| `rpc_create_sale` | cria com `status='paid'` direto (sem estado `pending` intermediário nesta RPC) | debita | `finance_entries` income | `sale.completed` | **Não — zero hits** |
| `rpc_cancel_sale` | qualquer status ⇒ `cancelled` (bloqueado só se já `cancelled`/`returned`) | restaura 100% | **nenhuma** `finance_entries` (comentário explícito: "competência passa a ser `sales.status/cancelled_at`, consumida por `vw_dre_mensal`") | `sale.cancelled` | **Não — zero hits** |
| `rpc_return_sale` | **só venda inteira** (sem parâmetro de item/quantidade) ⇒ `returned` | restaura 100% | via `cashback_transactions` | `sale.refunded` (`source=rpc_return_sale`) | **Não — zero hits** |
| `rpc_process_exchange` | parcial via `exchange_items`; só marca `sales.status='returned'` **e só emite evento** quando a soma devolvida cobre 100% do original | restaura por item | crédito só via `cashback_transactions` (nunca dinheiro) | `sale.refunded` condicional (`source=rpc_process_exchange`) | **Não — zero hits** |

**Nenhuma janela de prazo de cancelamento existe em nenhuma das 4 RPCs** (grep exaustivo, zero lógica de data/dias).

**Troca (`rpc_process_exchange`)**: a "nova venda" (item recebido em troca) é criada por uma **RPC totalmente separada** (`rpc_create_sale`, chamada por `src/app/api/vendas/[id]/troca/route.ts`), ligada à venda original só por **texto livre numa nota** (`Troca — Venda #X`) — **não existe FK entre a nova `sales` e a original**. `exchanges.original_sale_id` (FK) e `cashback_transactions.exchange_id` (FK) existem, mas não em `sales`.

### 1.8 Outbox/jobs/reconciliação

- `integration_outbox` roteia `sale.completed`/`cancelled`/`refunded` **só para `'chatwoot'`** (`destinationsForEvent`, hardcoded). `focus_nfe` é um `IntegrationProvider` reconhecido (guarda credencial), mas **não é um `OutboxDestination`** — zero fan-out fiscal.
- 4 jobs cron existem (`cashback-expire`, `refresh-views`, `cashback-release`, `integrations/run`), todos `CRON_SECRET`-gated, agendados fora do repo (Easypanel). **Nenhum é fiscal.**
- **Zero reconciliação automática** — `consultNfeStatus`/`consultFocusNfe` só são chamados por clique manual do admin (mais o uso interno já existente dentro do próprio `submitNfeHomologacao` antes de reemitir). Confirmado pelo próprio código/testes: *"não há loop, não há setInterval, não há job agendado"*.
- Infraestrutura reaproveitável já comprovada: `rpc_claim_outbox_events` (`FOR UPDATE SKIP LOCKED`, claim-and-lease) e o padrão de backoff `DELIVERY_BACKOFF_MINUTES=[1,5,15,60]` + `DELIVERY_MAX_ATTEMPTS=5` (`deliveries.service.ts`), com estados `permanent`/`retryAfterSeconds`/`skipped`/`requeue preserva attempts`.

### 1.9 Produtos e clientes — qualidade de dado fiscal

- `products.ncm`/`cest`/`origem`: **sem constraint de banco nenhuma** (só `unidade_med` tem `NOT NULL DEFAULT 'UN'`). Validação de formato (regex NCM 8 dígitos, CEST `00.000.00`) existe só em `src/lib/validators/index.ts`, usada só nas 2 rotas de API de produto — qualquer outro caminho de escrita (script, SQL direto) não é validado.
- Já existe `vw_data_quality_issues` com regra `product_no_ncm` (severidade fixa `'medium'`, com `TODO: tornar critical quando NF-e for ativada` **nunca aplicado**, mesmo com NF-e já existindo desde a Fase 1). Essa view **não filtra por `company_id`** — achado à parte, não fiscal, mas real (ver §2).
- **CEST é tratado como sempre-opcional** — não existe, em lugar nenhum do projeto, o conceito de "este NCM/produto exige CEST" (substituição tributária). `validateFiscalReadiness.ts` nunca valida `cest`.
- `customers`: **sem CNPJ, sem indicador de tipo de pessoa** — só `is_anonymous`. Endereço não é 1:1 (`customer_addresses` é tabela separada); o endereço usado na nota vem de `shipments.address_id` — **venda de balcão sem remessa cadastrada não tem endereço nenhum**, e `validateFiscalReadiness` bloqueia corretamente (sem crash, sem dado inventado).

### 1.10 Permissões e multiempresa

- Todas as ações fiscais são **estritamente admin** — `gerente` não tem acesso a nada fiscal hoje (nem leitura), embora tenha acesso a `/inteligencia/auditoria` (não-fiscal).
- RLS nas 4 tabelas fiscais é **deny-by-default sem policy nenhuma** — só `service_role` acessa. É um backstop real, mas não é "cada empresa só vê a sua" — é "ninguém além do backend vê nada".
- Toda query de serviço fiscal auditada filtra por `company_id` na resolução inicial. **Nuance**: alguns `UPDATE`/`DELETE` subsequentes em `submitNfeHomologacao.ts` usam só `.eq('id', ...)` sem re-checar `company_id` — não é vazamento hoje (o `id` sempre vem de uma consulta já escopada), mas é uma lacuna de defesa em profundidade.

---

## 2. Problemas encontrados

### CRÍTICO

1. **Cancelamento fiscal não existe.** Se uma venda com NF-e `authorized` for cancelada/devolvida hoje via `rpc_cancel_sale`/`rpc_return_sale`, a venda muda de estado comercialmente e a NF-e continua `authorized` para sempre — nenhum aviso, nenhuma pendência rastreada, nenhuma tentativa de reconciliar. Isso é exatamente a "divergência silenciosa entre estado comercial e fiscal" que a instrução do pedido proíbe explicitamente.
2. **Nenhum documento fiscal de devolução existe.** Devolução/troca de mercadoria com NF-e autorizada legalmente não é "cancelamento" — é normalmente uma nova operação (entrada/devolução, CFOP próprio) ou uma NF-e complementar/cancelamento dentro do prazo. O ERP hoje não modela nenhuma dessas possibilidades — `rpc_return_sale`/`rpc_process_exchange` são 100% cegos ao fiscal.
3. **Ausência de lock de concorrência real na transmissão.** Duas chamadas concorrentes de `submitNfeHomologacao` para a MESMA venda nova (sem `fiscal_documents` prévio) podem ambas passar da fase de criação/reuso de linha e ambas tentar `POST /v2/nfe` com a mesma `ref` antes que o status mude de `draft`. O dano é limitado pela própria idempotência da Focus (`already_processed`), mas o ERP hoje trataria esse retorno como erro genérico (`submission_error`), o que é enganoso — na verdade seria um sinal de que a idempotência funcionou.

### ALTO

4. **`FiscalRuleNotImplementedError` (CRT 2/3) é engolido.** Tanto o preview quanto a emissão real capturam esse erro específico só como `err instanceof FiscalBuildError` (falso) e caem no fallback genérico `"Falha inesperada ao montar o payload"` — a mensagem real e útil ("CRT=2 não tem regra implementada") nunca chega ao operador.
5. **Nenhum alerta de vencimento de certificado A1.** A Focus retorna `certificado_valido_ate` na resposta de empresa, mas nada no ERP lê/exibe/alerta sobre isso hoje.
6. **`vw_data_quality_issues` (não-fiscal, mas achado real de auditoria) não filtra `company_id`** — vaza contagem de produtos sem NCM entre empresas na página `/inteligencia/auditoria`. Fora do escopo fiscal estrito, mas descoberto durante esta auditoria e vale correção.
7. **Severidade do alerta de NCM ausente nunca foi promovida** apesar do comentário `TODO: tornar critical quando NF-e for ativada` já estar obsoleto (NF-e existe desde a Fase 1).
8. **Nenhuma reconciliação automática.** Uma NF-e que fica `pending` só é resolvida se um admin clicar manualmente em "Verificar status" — se ninguém lembrar, fica pendente indefinidamente.

### MÉDIO

9. **`cancelled_at` nunca é escrito**, mesmo no único caminho (passivo) que poderia chegar a `status='cancelled'`.
10. **CEST tratado como sempre-opcional** — correto para o catálogo atual (sem ST), mas é uma lacuna se/quando um produto sujeito a ST entrar no catálogo; hoje não há nem alerta.
11. **`ibge_municipios` sem UNIQUE em `(uf, nome_normalizado)`** — uma corrida rara poderia inserir duas linhas cacheando o mesmo nome/UF com `codigo_ibge` diferentes (baixa probabilidade, sem impacto funcional imediato já que a busca usa `LIMIT`/primeira correspondência, mas é uma inconsistência latente).
12. **`POST /api/fiscal/empresa` sem UI** — só operável via chamada HTTP direta/script.
13. **`gerente` não tem nenhuma visibilidade fiscal**, nem leitura — pode ser intencional, mas vale confirmar (ver Decisão Necessária, §10).

### BAIXO

14. Nenhum TODO/FIXME literal encontrado nos diretórios fiscais — o código está limpo desse tipo de marcador (positivo, registrado aqui só para completude do pedido).
15. Download/arquivamento do conteúdo de XML/DANFE não implementado (documentado como decisão consciente, não bug).

---

## 3. Matriz de cenários fiscais

Legenda de colunas: **Pode emitir/agir** · **Validação** · **Quem bloqueia** · **Mensagem ao usuário** · **Config. fiscal necessária** · **Risco fiscal**.

### A. Emissão

| # | Cenário | Pode emitir? | Validação | Quem bloqueia | Mensagem | Config. necessária | Risco |
|---|---|---|---|---|---|---|---|
| 1 | Venda concluída sem NF-e | Sim (é o caso normal) | `validateFiscalReadiness` | — | — | Sim (empresa+integração) | Baixo |
| 2 | Todos os dados válidos | Sim | passa | — | — | Sim | Baixo |
| 3 | Produto sem NCM | **Não** | `item_ncm_missing` | `validateFiscalReadiness` (já implementado) | "Produto X sem NCM cadastrado" | — | Alto se não bloqueasse (implementado) |
| 4 | NCM inválido (formato) | **Não**, na criação/edição do produto | Zod regex `/^\d{8}$/` | rota `/api/produtos` | erro de validação do form | — | Médio — só bloqueia na origem, não há checagem de formato dentro de `validateFiscalReadiness` em si (assume-se já validado ao salvar o produto) |
| 5 | Produto sem origem | **Não** | `item_origem_missing` | `validateFiscalReadiness` | "Produto X sem origem" | — | Implementado |
| 6 | Produto sem unidade | **Não** | `item_unidade_missing` | `validateFiscalReadiness` | "Produto X sem unidade" | — | Implementado |
| 7 | Produto exige CEST e não tem | **Emite mesmo assim hoje** | **não existe checagem** | ninguém | nenhuma | — | **Alto — lacuna real, ver Problema #10** |
| 8 | CFOP ausente | N/A — CFOP é sempre calculado por `resolveCfop`, nunca lido de cadastro | — | — | — | — | — |
| 9 | CSOSN/CST ausente/incompatível | N/A — sempre calculado (`resolveIcmsCsosn`), mas só CRT 1/4 | CRT 2/3 lança erro (mal formatado, ver Problema #4) | `taxRules.ts` | mensagem genérica hoje (deveria ser específica) | — | Médio |
| 10 | Emitente com cadastro incompleto | **Não** | `emitente_*_missing` (cnpj/razão/IE/CRT/endereço/IBGE) | `validateFiscalReadiness` | mensagens específicas por campo | Sim | Implementado |
| 11 | Cliente sem CPF/CNPJ | **Não** | `destinatario_documento_missing` | `validateFiscalReadiness` | "Destinatário sem CPF nem CNPJ" | — | Implementado |
| 12 | Cliente PF | Sim (único caso suportado) | — | — | — | — | Baixo |
| 13 | Cliente PJ | **Bloqueado estruturalmente** — `customers` não tem CNPJ | schema | — | indireto (nunca há CNPJ pra usar) | — | Médio — lacuna de produto, não de emissão |
| 14 | Cliente sem endereço | **Não** | `destinatario_endereco_incompleto` | `validateFiscalReadiness` | "Endereço do destinatário incompleto" | — | Implementado |
| 15 | Cliente de outro estado | Sim | CFOP interestadual calculado corretamente (6102/6108 conforme CRT) | — | — | — | Baixo |
| 16 | Consumidor final | Sim (único cenário implementado) | `consumidorFinal=1` fixo no contexto | — | — | — | Baixo |
| 17 | Venda presencial | Sim, mas `presenca_comprador` tem que ser informado corretamente | `presencaComprador` é parâmetro explícito, sem default automático por canal | operador/API | — | — | Médio — depende de quem chama passar o valor certo |
| 18 | Venda e-commerce | Sim, idem acima (default do loader é `2`) | idem | — | — | — | Baixo |
| 19 | Venda da Nuvemshop | Estruturalmente possível, mas **nenhuma automação liga Nuvemshop→emissão** | manual | — | — | — | — |
| 20 | Retirada em loja | Sem `shipment` → sem endereço → **bloqueado** (ver §1.9) | `destinatario_endereco_incompleto` | `validateFiscalReadiness` | — | — | Médio — pode ser falso-bloqueio se juridicamente NF-e de retirada não precisar do endereço completo do mesmo jeito (não confirmado) |
| 21 | Entrega local | Sim, se endereço existir via `shipments` | — | — | — | — | Baixo |
| 22 | Venda com frete | Sim — `modalidade_frete` vem de `shipments.mod_frete` | — | — | — | — | Baixo |
| 23 | Desconto por item | Sim — `valor_desconto` por item, enviado só quando > 0 | — | — | — | — | Baixo |
| 24 | Desconto no total | **Não modelado separadamente** — `sales.discount_amount` existe mas o payload só soma descontos por item | — | — | — | — | Médio — pode haver divergência entre desconto total da venda e soma dos descontos por item enviados |
| 25 | Acréscimo | **Não modelado no payload fiscal** — `sales.surcharge_amount` existe no domínio comercial mas não aparece em `buildNfePayload` | — | — | — | — | Médio |
| 26 | Múltiplas formas de pagamento | Payload de pagamento **não é montado nem enviado hoje** — `buildNfePayload` não tem bloco `formas_pagamento` | — | — | — | — | **Alto — bloco de pagamento obrigatório na NF-e real, ausente do builder atual** |
| 27-30 | PIX/dinheiro/crédito/débito | idem #26 | — | — | — | — | Alto (mesmo gap) |
| 31 | Venda parcelada | idem #26 + número de parcelas não modelado | — | — | — | — | Alto |
| 32 | Cupom/desconto promocional | Tratado como desconto por item, se refletido em `sale_items.discount_amount` | — | — | — | — | Baixo, se a origem do desconto já cair em `discount_amount` |

> **Achado novo desta auditoria, fora da lista original do pedido mas crítico**: `buildNfePayload.ts` **não monta o bloco de formas de pagamento** (`formas_pagamento[]`), que é **obrigatório** no schema real da NF-e (confirmado na doc Focus em fases anteriores). Isso significa que o payload atual, mesmo com todos os outros dados corretos, **provavelmente seria rejeitado pela Focus/SEFAZ por falta desse bloco** — nunca testado porque a emissão real (`POST /v2/nfe`) nunca foi de fato exercitada com uma venda real ainda (só a consulta a uma ref inexistente, que confirma autenticação, não confirma um payload de emissão completo). Ver Lacunas §5 e Fases §13.

### B. Duplicidade e idempotência

| # | Cenário | Comportamento atual |
|---|---|---|
| 1 | Duplo clique em "Emitir" | Segunda chamada encontra a linha já criada pela primeira; se `pending`, consulta em vez de reemitir; se `authorized`, devolve na hora. **Race estreita** se ambas chegarem antes do status mudar de `draft` (Problema Crítico #3). |
| 2 | Retry do navegador | Mesmo tratamento — `provider_ref` determinístico garante que a Focus veria a mesma `ref`. |
| 3 | Request chega duas vezes | idem |
| 4 | Worker executa duas vezes | N/A hoje — não há worker de emissão (só o botão manual). Relevante só quando a Fase 13 automatizar. |
| 5 | `integration_outbox` entrega duas vezes | N/A — outbox não está ligado ao fiscal ainda. |
| 6 | Focus recebe, ERP sofre timeout | `status='pending'` com mensagem "resultado desconhecido" — próxima chamada consulta antes de reemitir. **Correto, implementado.** |
| 7 | Focus autoriza, resposta nunca chega | Idêntico ao caso 6 até a reconciliação (manual hoje) resolver. |
| 8 | Aplicação reinicia durante emissão | Se o `UPDATE` de `request_payload`/`issued_at` já foi persistido antes do `POST`, a linha fica em `draft` com payload salvo — próxima tentativa reconstrói o contexto do zero (não reusa o payload salvo) e tenta de novo com a mesma ref. Comportamento aceitável, mas não há teste automatizado desse caso específico. |
| 9 | Duas instâncias emitindo simultaneamente | Mesma race do Crítico #3 — sem lock, só o UNIQUE constraint do banco. |

**Garantias reais hoje**: `UNIQUE(provider, provider_ref)` e `UNIQUE(sale_id, document_type) WHERE status='authorized'` — **uma venda nunca terá duas NF-e autorizadas**, isso está genuinamente garantido no nível de banco, independente de bug de aplicação. O que não está garantido é "nunca duas chamadas HTTP simultâneas à Focus para a mesma tentativa" (Crítico #3) — dano limitado, mas existe.

### C. Venda cancelada antes da NF-e

| # | Cenário | Comportamento recomendado (não implementado hoje — `rpc_cancel_sale` é cego ao fiscal) |
|---|---|---|
| 1 | Concluída, NF-e nunca emitida → cancelar | Cancelamento comercial livre, sem impedimento (nenhum documento fiscal existe pra reconciliar) |
| 2 | Emissão pendente (`draft`) → cancelar venda | Permitir cancelamento comercial; marcar o `fiscal_documents` associado como obsoleto/não-mais-necessário (precisa de um estado ou flag — ver Lacunas) |
| 3 | Enviada à Focus, sem resultado (`pending`) → cancelar venda | Mesma situação — só se resolve quando a consulta trouxer o resultado real; se vier `authorized` depois do cancelamento comercial, cai no cenário D (crítico) |
| 4 | Rejeitada (`authorization_failed`) → cancelar venda | Livre — não há NF-e válida |
| 5 | Erro técnico (`submission_error`) → cancelar venda | Livre |

### D. Venda cancelada depois da NF-e — **DECISÃO NECESSÁRIA**

Este é o ponto mais crítico do pedido. Opções apresentadas literalmente como pedido pelo usuário:

- **A. Bloquear até a NF-e ser cancelada** — rígido demais: se o prazo legal de cancelamento (normalmente 24h para NF-e) já passou, ou a Focus/SEFAZ está fora do ar, o operador fica **permanentemente impedido** de registrar uma realidade comercial já consumada (cliente devolveu o produto, quer o dinheiro de volta). Tecnicamente errado além de operacionalmente ruim: passado o prazo, a resposta fiscal correta não é mais "cancelar a NF-e" (nem sempre é permitido), é emitir um documento de devolução — um instrumento diferente.
- **B. Cancelar fiscalmente primeiro, comercialmente depois** — mesmo problema de A, só reordenado.
- **C. Cancelar comercialmente e deixar pendência fiscal explícita e rastreada** — a venda muda de estado imediatamente (estoque/financeiro refletem a realidade sem depender da SEFAZ), e uma pendência fiscal fica **visível e rastreável** (nunca escondida) até ser resolvida por uma de duas ações: (i) cancelamento fiscal de fato, se ainda dentro do prazo e a Focus/SEFAZ aceitar; (ii) emissão de um documento de devolução, se o prazo já passou.
- **D. Outro modelo** — não identificado nenhum modelo genuinamente melhor que C para este contexto.

**Recomendação: opção C.** Justificativa: (1) é o único modelo que nunca trava o operador por causa de uma falha/prazo fora do controle dele; (2) reflete a prática fiscal brasileira real — cancelamento e devolução são instrumentos distintos com prazos distintos; (3) atende literalmente a regra do pedido "não permita divergência silenciosa" — a chave é que a divergência (venda cancelada comercialmente + NF-e ainda `authorized`) precisa ficar **visível** (uma consulta simples `sales.status IN ('cancelled','returned') AND fiscal_documents.status='authorized'` já detecta isso, sem precisar de coluna nova), não que ela nunca possa existir temporariamente.

**Implementação proposta (não fazer agora, só desenhar)**: `rpc_cancel_sale`/`rpc_return_sale` continuam mudando `sales.status` sem esperar nada fiscal. Um novo mecanismo (job/dashboard/alerta) varre pendências (join simples, sem necessidade de coluna nova a princípio) e oferece duas ações ao admin: "tentar cancelamento fiscal" (chama o `DELETE /v2/nfe` — ainda não existe, precisa ser construído) ou "emitir devolução" (novo `document_type`, ver Lacunas).

### E. Devolução

`rpc_return_sale` hoje: só venda inteira, sem distinção fiscal. **Devolução não é fiscalmente equivalente a cancelamento** — juridicamente, se a mercadoria já circulou/saiu do estabelecimento e o prazo de cancelamento (tipicamente 24h) passou, a devolução exige um documento fiscal próprio (nota de entrada/devolução, referenciando a chave da NF-e original), não um cancelamento da nota original.

| # | Cenário | Documento fiscal necessário |
|---|---|---|
| 1 | Devolução integral, sem NF-e | Nenhum |
| 2 | Devolução parcial, sem NF-e | Nenhum |
| 3 | Devolução integral, NF-e autorizada | Cancelamento (se dentro do prazo) OU nota de devolução (se fora do prazo) — **DECISÃO NECESSÁRIA, ver §D** |
| 4 | Devolução parcial, NF-e autorizada | Nota de devolução parcial (referenciando só os itens/valores devolvidos) — cancelamento total não se aplica a uma devolução parcial |
| 5 | Devolução após prazo de cancelamento | Nota de devolução, obrigatoriamente (cancelamento não é mais uma opção fiscal válida) |
| 6-7 | 1 item / várias unidades | Mesma lógica de #4, granularidade por item |
| 8 | Restituição em dinheiro | Não muda a exigência fiscal — é um detalhe financeiro |
| 9 | Crédito na loja (cashback) | idem — já é o modelo atual (`rpc_process_exchange`), mas sem contraparte fiscal |
| 10 | Devolução de venda do e-commerce | Mesma lógica, mais a necessidade de sincronizar com Nuvemshop (ver §Q) |

**Nenhum destes documentos de devolução existe hoje.** `fiscal_documents.document_type` só aceita `'nfe'` — precisaria de um novo valor (ex. `'nfe_devolucao'`) quando essa fase for implementada.

### F. Trocas

`rpc_process_exchange` hoje: modela bem o lado comercial/estoque/cashback (granular por item, cumulativo, crédito automático), mas é **100% cego ao fiscal** — nenhum documento é gerado nem pro item devolvido nem pro item novo.

| Efeito | Comercial | Estoque | Financeiro | Fiscal |
|---|---|---|---|---|
| Item devolvido | `exchange_items` registra quantidade | Restaurado | `cashback_transactions` (crédito) | **Nenhum documento — lacuna** |
| Item novo | Nova `sales` (RPC separada, sem FK à original) | Debitado (fluxo normal de `rpc_create_sale`) | Pago com crédito + eventual diferença | **Nenhuma NF-e associada automaticamente — teria que ser emitida manualmente como uma venda comum, se o operador lembrar** |

Troca acima do prazo de cancelamento tem a mesma implicação de devolução tardia (§E, item 5).

### G. Cancelamento parcial

**Não existe conceito de cancelamento parcial de NF-e neste ERP nem na Focus/SEFAZ em geral** — cancelamento de NF-e é sempre integral (a nota inteira ou nada). O que existe (ou deveria existir) para "parcial" é: manter a NF-e original autorizada como está, e emitir uma **nota de devolução parcial** para os itens efetivamente devolvidos — nunca uma nova NF-e "corrigida" substituindo a original (que já foi autorizada e é imutável por design).

### H. Rejeições SEFAZ

Já modeladas as colunas certas: `status_sefaz`, `status_message` (mensagem real, nunca reinterpretada), `submission_error_code`/`submission_error_message` (erro síncrono, antes da SEFAZ ver a tentativa). Isso cobre estruturalmente NCM/CFOP/CSOSN/CNPJ/CPF/IE/IBGE/CEP/certificado/duplicidade/schema/totalização/tributação inválidos — a Focus devolve o código+mensagem real em qualquer um desses casos e o ERP já persiste ambos sem reinterpretar.

**O que pode ser armazenado**: código de rejeição, mensagem, payload enviado (`request_payload` — nunca tem segredo, confirmado por leitura do código), resposta completa (`provider_payload`), horário, contagem de tentativa (`attempts`, se implementado — ver Lacunas).
**O que NÃO pode**: token Focus, header `Authorization`, certificado (.pfx), senha do certificado — nenhum desses jamais passa perto de `fiscal_documents` (confirmado: `buildNfePayload`/`loadSaleFiscalContext` nunca recebem credencial como entrada).

### I. Timeout/indisponibilidade

Já corretamente implementado para o caminho síncrono da chamada de emissão: timeout/rede → `pending`, nunca `submission_error`. **Faltando**: reconciliação automática (§J) para resolver esses `pending` sem depender de alguém lembrar de clicar "Verificar status".

### J. Webhook/polling/reconciliação

Hoje: 100% síncrono + polling manual. **Nenhum webhook, nenhum job.** Estratégia proposta (ver §11).

### K. Certificado

Focus já retorna `certificado_valido_ate`/`certificado_valido_de` na resposta de empresa (tipo já existe em `FocusEmpresa`), mas **nada no ERP lê/alerta sobre isso hoje** (Problema Alto #5). Certificado nunca é persistido no ERP (confirmado nas Fases 2A/2B) — `.pfx`/senha só passam em memória durante o upload.

### L. Homologação × produção

Já bem guardado: `company_fiscal_settings.nfe_environment` é checado em `submitNfeHomologacao` (403 se não for `'homologacao'`) e a integração resolvida também precisa ter `environment='homologacao'` (dupla checagem). URLs diferentes por ambiente (`FOCUS_BASE_URLS`). **Nenhum código deste projeto jamais chamou o endpoint de produção.** Não existe switch de ambiente na UI (nem deveria, nesta fase).

### M. Produtos sem dados fiscais

`vw_data_quality_issues` já existe com a regra `product_no_ncm`, mas: severidade desatualizada (nunca virou `critical`), sem `company_id` (vaza entre empresas), e sem checar `cest`/`origem`/`unidade_med` além do NCM. `validateFiscalReadiness` já entrega a mensagem certa por venda (`"Produto X sem NCM"`), mas não existe uma listagem proativa "produtos sem dados fiscais" fora do contexto de uma venda específica.

### N. Snapshot fiscal

**Já implementado corretamente.** `fiscal_document_items` é um snapshot imutável (NCM/CEST/CFOP/CSOSN/origem/unidade/valores no momento da emissão) — mudar `products.ncm` depois não afeta documentos já emitidos. `fiscal_context_snapshot` (JSONB, Fase 2B) guarda o contexto inteiro usado para montar o payload, incluindo dados do emitente/destinatário no momento.

### O. Numeração/série

Confirmado (§1.6): só a Focus controla.

### P. DANFE/XML/chave

`fiscal_documents` já tem `access_key`, `number`, `series`, `authorization_protocol` (extraído corretamente de `protocolo_nota_fiscal.numero_protocolo`), `xml_path`, `danfe_path`. O que falta: baixar/arquivar o **conteúdo** (não só a URL) — decisão consciente de adiar, mas a chave de 44 dígitos já fica disponível pra uso futuro (ex. Nuvemshop/logística).

### Q. E-commerce/Nuvemshop

Hoje: nenhuma automação — pedido Nuvemshop → venda ERP já existe (fora do escopo fiscal), mas emissão continua manual, e não há nenhum código que envie a chave de acesso de volta à Nuvemshop.

### R. Auditoria

`fiscal_context_snapshot`/`request_payload`/`provider_payload` já dão uma trilha rica. **Faltando**: quem (usuário) solicitou a emissão — `submitNfeHomologacao` recebe `companyId`/`saleId`, não recebe/persiste o `user.id` de quem clicou. Isso é uma lacuna real de auditoria (ver Lacunas).

### S. Permissões

Confirmado (§1.10): tudo admin-only, sem exceção.

### T. Concorrência

Já coberto no Crítico #3 e em §B.

---

## 4. Máquina de estados

### Venda (`sales.status`, enum real, 6 valores confirmados)

`pending` → `paid` → `shipped` → `delivered` (fluxo normal) · `cancelled` (terminal) · `returned` (terminal). `rpc_create_sale` sempre cria em `paid` diretamente (não usa `pending` como estado inicial nesta RPC).

### Documento fiscal (8 estados do CHECK, com o que realmente os alcança hoje)

```
draft ──(validação falha)──> validation_failed [terminal]
draft ──(POST falha síncrono, 400/422)──> submission_error [retentável]
draft ──(POST ok, processando)──> pending
draft ──(POST ok, já autorizado síncrono)──> authorized [terminal]
pending ──(consulta: autorizado)──> authorized [terminal]
pending ──(consulta: erro_autorizacao)──> authorization_failed [retentável]
pending ──(consulta: ainda processando)──> pending [inalterado]
pending ──(consulta: cancelado — reflexo passivo, nunca iniciado por este ERP)──> cancelled [terminal, NUNCA alcançado hoje na prática]
authorized ──(nenhum código chega aqui hoje)──> cancelled / cancellation_failed
```

`authorization_failed`/`submission_error`/`cancellation_failed` → reaproveitam a mesma linha/ref numa nova tentativa (`submitNfeHomologacao` trata como "seguro reemitir").

### Matriz venda × documento fiscal → ações permitidas hoje

| Venda | Fiscal | Cancelar venda? | Devolver? | Trocar? | Editar? | Emitir outra NF-e? |
|---|---|---|---|---|---|---|
| `paid` | nenhum documento | Sim (RPC permite) | Sim | Sim | Sim | Sim (é o caso normal) |
| `paid` | `draft`/`validation_failed`/`submission_error` | Sim (RPC não checa fiscal) | Sim | Sim | Sim | Sim (reaproveita a linha) |
| `paid` | `pending` | Sim (RPC não checa fiscal — **ponto cego real**) | Sim (idem) | Sim (idem) | Sim | Bloqueado pela idempotência (consulta antes) |
| `paid` | `authorized` | Sim, mas **gera divergência não rastreada hoje** (Crítico #1) | idem | idem | Sim, mas sem nenhum aviso de que já existe NF-e autorizada | Bloqueado pelo UNIQUE parcial (correto) |
| `cancelled` | qualquer | — (já cancelada) | Bloqueado por `rpc_cancel_sale` (`já foi cancelada`) | N/A | Indefinido — não auditado nesta rodada | Nenhuma validação fiscal impede reemissão pra uma venda cancelada (**lacuna**: `submitNfeHomologacao` não checa `sales.status` antes de emitir) |
| `returned` | qualquer | Bloqueado por `rpc_cancel_sale` (`já foi devolvida`) | — | Depende (exchange cumulativo) | Indefinido | Mesma lacuna acima |

**Lacuna nova identificada aqui**: `submitNfeHomologacao.ts` nunca verifica `sales.status` antes de emitir — tecnicamente pode-se emitir uma NF-e para uma venda já `cancelled`/`returned`, o que não faz sentido fiscal nenhum. Isso deveria ser uma validação adicional em `validateFiscalReadiness`.

---

## 5. Lacunas (o que falta implementar, sem duplicar o que já está no §2)

1. Bloco `formas_pagamento[]` no payload de emissão (achado crítico do §3.A).
2. Validação de `sales.status` antes de permitir emissão (venda cancelada/devolvida não deveria poder gerar NF-e nova).
3. Cancelamento fiscal real (`DELETE /v2/nfe`) + fluxo de decisão (§3.D).
4. Documento de devolução (`document_type` novo) + fluxo de decisão (§3.E).
5. Reconciliação automática de `pending` (job).
6. Detecção/alerta de divergência comercial×fiscal (venda cancelada com NF-e ainda autorizada).
7. Alerta de vencimento de certificado.
8. Checagem de CEST-obrigatório (quando/se produtos com ST entrarem no catálogo).
9. Auditoria de "quem" solicitou cada ação fiscal (usuário, não só empresa/venda).
10. Contagem de tentativas (`attempts`) em `fiscal_documents` — hoje não existe coluna equivalente à do outbox.
11. UI para cadastro de empresa/certificado (rota já existe, tela não).
12. Correção do erro engolido de CRT 2/3 (Problema Alto #4).
13. Lock de concorrência na transmissão (Problema Crítico #3).

---

## 6. Arquitetura proposta (visão de fluxo, sem implementar)

```
Frontend (botão "Emitir"/"Cancelar"/"Verificar status", sempre admin-only)
   │
   ▼
API Route (/api/fiscal/nfe/*) — valida role, nunca aceita dado fiscal arbitrário do cliente
   │
   ▼
Service layer (submitNfeHomologacao / futuro cancelNfeHomologacao / futuro emitirDevolucao)
   │  ├─ validateFiscalReadiness (inclui nova checagem de sales.status)
   │  ├─ buildNfePayload / futuro buildFormasPagamento
   │  ├─ lock (novo: pg_advisory_xact_lock ou SELECT FOR UPDATE por (company_id, sale_id))
   │  └─ persistência em fiscal_documents/fiscal_document_items (idempotente, já implementado)
   │
   ▼
Focus HTTP client (POST/GET/futuro DELETE /v2/nfe)
   │
   ▼
SEFAZ (via Focus)
   │
   ▼
Reconciliação (novo: job periódico HTTP-cron, mesmo padrão de /api/jobs/*, varrendo status='pending' com backoff igual ao de deliveries.service.ts)
   │
   ▼
Detecção de divergência (novo: query/dashboard comparando sales.status × fiscal_documents.status)
```

`integration_outbox` **não** entra neste fluxo nesta fase — emissão continua 100% manual (ver Decisão §V abaixo).

---

## 7. Alterações de banco necessárias (proposta — não aplicar agora)

Só o que a auditoria acima realmente exige, evitando tabela nova sempre que uma coluna resolve:

- `fiscal_documents.document_type` — estender CHECK pra incluir um valor de devolução (ex. `'nfe_devolucao'`), quando a Fase de devolução for aprovada.
- `fiscal_documents.attempts INT DEFAULT 0` — contagem de tentativas de transmissão, mesmo padrão de `integration_outbox`.
- `fiscal_documents.available_at`, `locked_at`, `locked_by` — só se a reconciliação virar um worker com claim-and-lease (reaproveitando `rpc_claim_outbox_events` como modelo) em vez de um job simples de varredura.
- `fiscal_documents.requested_by UUID REFERENCES users(id)` — auditoria de quem solicitou (Lacuna 9).
- `ibge_municipios` — adicionar `UNIQUE(uf, nome_normalizado)` (corrige Problema Médio #11).
- `products.cest_required BOOLEAN DEFAULT false` (ou equivalente) — só se/quando a Decisão do §CEST optar por flag manual em vez de tabela de NCM×ST.
- **Nenhuma tabela nova parece necessária** para o que já foi mapeado — `fiscal_documents`/`fiscal_document_items` cobrem o essencial; um segundo `document_type` no mesmo par de tabelas é suficiente pra devolução, evitando duplicar schema.

RLS/índices/FKs de qualquer coluna nova devem seguir exatamente o padrão já estabelecido (deny-by-default, `company_id` sempre presente e indexado).

---

## 8. Alterações de código necessárias (mapa de arquivos, proposta)

| Módulo | Arquivo(s) | Mudança proposta |
|---|---|---|
| Pagamentos no payload | `src/lib/integrations/focus/nfePayload.types.ts`, `src/services/fiscal/buildNfePayload.ts` | Adicionar bloco `formas_pagamento[]` |
| Validação de status da venda | `src/services/fiscal/validateFiscalReadiness.ts` | Novo check: venda não pode estar `cancelled`/`returned` |
| Erro CRT engolido | `src/services/fiscal/submitNfeHomologacao.ts`, `src/app/api/fiscal/nfe/preview/route.ts` | Capturar `FiscalRuleNotImplementedError` explicitamente |
| Lock de concorrência | `src/services/fiscal/submitNfeHomologacao.ts` | `pg_advisory_xact_lock` ou RPC com `FOR UPDATE` por `(company_id, sale_id)` |
| Cancelamento Focus | `src/lib/integrations/focus/httpClient.ts` (novo `cancelFocusNfe`), novo service `src/services/fiscal/cancelNfeHomologacao.ts`, nova rota `/api/fiscal/nfe/cancelar-homologacao` | Novo — depende da Decisão §D |
| Devolução fiscal | novo `src/services/fiscal/emitirDevolucaoHomologacao.ts` + payload próprio | Novo — depende da Decisão §E |
| Reconciliação | novo `src/app/api/jobs/fiscal-reconciliation/route.ts` | Novo job, mesmo padrão `CRON_SECRET` |
| Divergência comercial×fiscal | novo endpoint/consulta de leitura, ou seção na página `/configuracoes/fiscal` | Novo |
| Alerta de certificado | `src/services/fiscal/health.service.ts` | Ler `certificado_valido_ate` e expor no health |
| Auditoria de usuário | `src/services/fiscal/submitNfeHomologacao.ts`, rota de emissão | Passar `user.id` do `requireRole` adiante |
| UI cadastro empresa | novo form em `src/app/(dashboard)/configuracoes/fiscal/` | Novo |
| `vw_data_quality_issues` | migration de correção da view | `company_id` + severidade `product_no_ncm` |

---

## 9. Estratégia de idempotência (consolidada)

Já implementada corretamente na maior parte: `provider_ref` determinístico, UNIQUE constraints reais no banco, distinção `pending`(desconhecido)/`submission_error`(rejeição síncrona confirmada)/`authorization_failed`(SEFAZ processou e rejeitou). **Falta apenas** fechar a janela de corrida na primeira transmissão (Crítico #3) — proposta: `pg_advisory_xact_lock(hashtext(company_id || ':' || sale_id))` no início de `submitNfeHomologacao`, liberado automaticamente ao fim da transação, seguindo a mesma filosofia de lock já usada em `rpc_create_sale` (`stock_balances ... FOR UPDATE`).

---

## 10. Estratégia de cancelamento/devolução/troca (consolidada)

Recomendação central: **modelo C** (§3.D) — comercial nunca espera fiscal, divergência sempre visível e rastreável, nunca escondida. Dois novos fluxos precisam ser construídos (cancelamento fiscal real; emissão de devolução), ambos represados atrás de decisões de regra de negócio que precisam de confirmação explícita antes de implementar:

- **DECISÃO NECESSÁRIA — prazo de cancelamento**: bloquear o botão de cancelamento fiscal no cliente após N horas (hardcoded), ou sempre tentar e deixar a Focus/SEFAZ rejeitar (`erro_cancelamento`) se o prazo passou? **Recomendação**: sempre tentar e detectar pela resposta — evita fixar no código um prazo que pode variar/ter exceção, e a UI já sabe mostrar `status_sefaz`/`status_message` reais.
- **DECISÃO NECESSÁRIA — modelagem exata da nota de devolução**: CFOP de devolução, se é uma NF-e de entrada gerada pelo próprio ERP ou se depende do cliente (pessoa física normalmente não emite nota — nesse caso o padrão de mercado costuma ser o PRÓPRIO estabelecimento emitir a nota de entrada referenciando a chave original). Isso precisa de confirmação com o contador da empresa antes de desenhar o payload, mesmo padrão já seguido em fases anteriores para PIS/COFINS.
- **DECISÃO NECESSÁRIA — automação (integration_outbox)**: `sale.completed` deveria emitir automaticamente? **Recomendação: não ainda.** Motivos: bloco de pagamento ausente do payload (§3.A), cobertura de NCM do catálogo ainda incompleta, cancelamento/devolução fiscal ainda não existem (uma emissão automática sem forma de desfazer é mais arriscada que uma manual). Reavaliar depois que Fases 3A-3D (abaixo) estiverem estáveis em homologação real.

---

## 11. Estratégia de retries/reconciliação (proposta)

Reaproveitar, não inventar: mesmo padrão de `rpc_claim_outbox_events` (`FOR UPDATE SKIP LOCKED`) e `DELIVERY_BACKOFF_MINUTES=[1,5,15,60]`/`DELIVERY_MAX_ATTEMPTS=5` de `deliveries.service.ts`. Um novo job HTTP-cron (`CRON_SECRET`, mesmo padrão de `/api/jobs/*`) varre `fiscal_documents WHERE status='pending'`, chama `consultNfeStatus` pra cada um, respeitando o backoff. Nunca mais que N tentativas antes de marcar como "precisa de atenção manual" (não necessariamente `authorization_failed` — pode ser um estado de alerta separado, ou simplesmente uma listagem de "pendências antigas" sem mudar o `status` do documento).

---

## 12. Plano de testes

**Unitários** (padrão já usado no projeto, `vitest`, mock de Focus): CFOP/CSOSN/PIS-COFINS/IPI/IBS-CBS por CRT (já existem), validação de status de venda (novo), lock de concorrência (novo, com dois `Promise.all` disparando `submitNfeHomologacao` pra mesma venda), erro CRT 2/3 não mais engolido.

**Integração/banco/RPC**: teste SQL (`supabase/tests/*.test.sql`, mesmo padrão já usado em `fiscal_documents_constraints.test.sql`) garantindo que UNIQUE constraints seguram sob concorrência real (`BEGIN`/`SAVEPOINT`), e que uma venda `cancelled`/`returned` não permite nova linha de `fiscal_documents`.

**Idempotência/concorrência**: dois clientes chamando `submitNfeHomologacao` pro mesmo `sale_id` em paralelo (`Promise.all`) — já parcialmente coberto pelos testes existentes de "duplo clique", precisa de um teste específico simulando a janela de corrida do Crítico #3 depois do lock ser implementado.

**Focus mock**: já é o padrão de todos os testes fiscais existentes — manter.

**Focus homologação real**: roteiro manual abaixo.

**E2E**: fluxo completo venda→emitir→autorizar (mock)→cancelar comercialmente→ver divergência sinalizada — hoje não testável (funcionalidade não existe).

### Roteiro de homologação manual

1. Confirmar `company_fiscal_settings`/integração/certificado já configurados (dado do contexto: `company_id=1`, `company_integrations.id=2`, ambiente `homologacao`, `active`).
2. Criar uma venda de teste com produto com NCM/CEST/origem/unidade completos.
3. Clicar "Emitir NF-e de homologação".
4. Confirmar autorização (ou erro real — o payload provavelmente falha hoje por falta do bloco de pagamento, ver §3.A — **este é o primeiro teste real que vai expor essa lacuna**).
5. Consultar (`/api/fiscal/nfe/consultar`) e confirmar que reflete o mesmo status.
6. Tentar emitir de novo pra mesma venda — confirmar que não duplica (deve devolver o resultado existente).
7. (Fase futura) Cancelar a venda comercialmente e confirmar que a divergência fica visível.
8. (Fase futura) Simular devolução.
9. (Fase futura) Simular troca.
10. Simular produto sem NCM numa venda nova — confirmar bloqueio com mensagem específica (já deve funcionar hoje).
11. Simular timeout (ex. derrubar a rede momentaneamente ou usar um mock local) — confirmar que fica `pending`, nunca `submission_error`.
12. (Fase futura) Rodar reconciliação manualmente e confirmar que resolve um `pending` real.

---

## 13. Plano de implementação por fases

Cada fase pequena, testável, reversível — nenhuma depende de decisão de negócio ainda não confirmada além da sua própria.

- **Fase Fiscal 3A — Fechar o payload de emissão.** Adicionar bloco `formas_pagamento[]`; validar `sales.status` antes de emitir; corrigir captura de `FiscalRuleNotImplementedError`. Sem mudança de schema. **Pré-requisito pra qualquer emissão real funcionar.**
- **Fase Fiscal 3B — Concorrência e observabilidade.** Lock de transmissão; coluna `attempts`/`requested_by`; alerta de certificado no health. Migration pequena e aditiva.
- **Fase Fiscal 3C — Primeira emissão real de homologação.** Rodar o roteiro manual (§12) contra a Focus de verdade, com uma venda real de teste, corrigindo o que aparecer.
- **Fase Fiscal 3D — Detecção de divergência comercial×fiscal.** Query/dashboard, sem mudar comportamento de `rpc_cancel_sale`/`rpc_return_sale` ainda — só visibilidade.
- **Fase Fiscal 3E — Cancelamento fiscal real.** `DELETE /v2/nfe`, endpoint, UI — depende da Decisão §D já estar confirmada com o usuário antes de começar.
- **Fase Fiscal 3F — Devolução fiscal.** Novo `document_type`, payload próprio — depende de confirmação de regra fiscal (contador) sobre o modelo exato.
- **Fase Fiscal 3G — Reconciliação automática.** Job cron, sem automatizar emissão ainda — só resolve `pending` órfãos.
- **Fase Fiscal 3H — (futura, não priorizada agora) Automação via outbox.** Só depois de 3A-3G estarem validados em homologação real por um período — decisão explícita, nunca silenciosa.

---

## 14. Critérios para liberar produção (checklist)

- [ ] Fase 3A-3D concluídas e testadas.
- [ ] Pelo menos N emissões reais de homologação bem-sucedidas via roteiro manual, incluindo pelo menos um caso de rejeição real da SEFAZ tratado corretamente.
- [ ] Cancelamento fiscal (3E) implementado e testado, ou decisão explícita de adiar registrada.
- [ ] 100% do catálogo ativo com NCM/origem/unidade preenchidos (ou processo de correção contínua rodando) — `vw_data_quality_issues` corrigida (company_id + severidade).
- [ ] Contador da empresa confirmou CST de PIS/COFINS/IPI e modelo de devolução (pendências herdadas das Fases 2A/2B).
- [ ] Token/certificado de produção configurados **separadamente** do de homologação, nunca reaproveitados.
- [ ] Nenhum botão/rota permite trocar de ambiente sem uma ação deliberada e auditada.
- [ ] Reconciliação automática (3G) rodando e testada com pelo menos um caso real de `pending` resolvido automaticamente.
- [ ] Auditoria de "quem solicitou" cada emissão implementada.
- [ ] Revisão de segurança confirmando: nenhum segredo em log, nenhum certificado no repositório, RLS+company_id revisados nas tabelas fiscais.
