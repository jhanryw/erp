# Fase Fiscal 4 — NFC-e modelo 65: auditoria e proposta de arquitetura

Documento de auditoria + proposta — **nenhum código foi alterado, nenhuma migration foi criada**. Toda afirmação sobre o ERP tem evidência `arquivo:linha`; toda afirmação sobre a Focus tem evidência do OpenAPI real (`doc.focusnfe.com.br/reference/*.md`, obtido via `curl` bruto + `python3` — nunca resumo de fetch por IA, mesma disciplina das fases anteriores). Onde a fonte é insuficiente ou depende de confirmação empírica, está marcado **A CONFIRMAR**, nunca presumido.

---

## 1. Campos reais — retirada / entrega / origem

| Conceito | Campo real | Valores confirmados | Evidência |
|---|---|---|---|
| Origem da venda | `sales.sale_origin` (enum Postgres `customer_origin`) | `'instagram'`, `'referral'`, `'paid_traffic'`, `'website'`, `'store'`, `'other'` | Cast `::customer_origin` em [20260522_rpc_create_sale_payments.sql:225](../supabase/migrations/20260522_rpc_create_sale_payments.sql#L225) e replicado em todas as versões subsequentes de `rpc_create_sale`; obrigatório no formulário manual: [`/api/vendas/route.ts:186`](../src/app/api/vendas/route.ts#L186) |
| Retirada vs. entrega | `shipments.delivery_mode` | `'pickup'` \| `'delivery'` | [`src/types/shipping.types.ts:1`](../src/types/shipping.types.ts#L1); usado em `WHERE delivery_mode = 'pickup'` ([20260613_shipping_fiscal_ready.sql:125](../supabase/migrations/20260613_shipping_fiscal_ready.sql#L125)) e `<> 'delivery'` ([20260613_rpc_pagar_repasse_lote.sql:117](../supabase/migrations/20260613_rpc_pagar_repasse_lote.sql#L117)) |
| Frete/modalidade NF-e | `shipments.mod_frete` | `0`=CIF, `1`=FOB, `9`=sem frete | [20260613_shipping_fiscal_ready.sql:79-86](../supabase/migrations/20260613_shipping_fiscal_ready.sql#L79-L86) |
| Vínculo venda↔envio | `shipments.order_id` → `sales.id` | — | [`shipping.types.ts:79`](../src/types/shipping.types.ts#L79) (`order_id: number`); consumido em [`loadSaleFiscalContext.ts:96`](../src/services/fiscal/loadSaleFiscalContext.ts#L96) `.eq('order_id', saleId)` |
| Venda presencial (PDV/manual) | `/api/vendas` — rota manual, exige `sale_origin` e `delivery_mode` no corpo | `delivery_mode` default `'delivery'` no schema, mas é campo explícito preenchido por quem lança a venda | [`route.ts:185-186`](../src/app/api/vendas/route.ts#L185-L186) |
| Ecommerce/site | `sale_origin = 'website'` | hardcoded pelo webhook, nunca vem do payload Nuvemshop | [`nuvemshop/order/route.ts:530`](../src/app/api/webhooks/nuvemshop/order/route.ts#L530) `p_sale_origin: 'website'` |
| Nuvemshop | mesmo `sale_origin='website'` — **não existe** um valor distinto `'nuvemshop'` no enum | `customer_origin` não tem `'nuvemshop'` como opção | Enum completo listado acima; grep confirma zero uso de `'nuvemshop'` como valor de `sale_origin` |
| Endereço de entrega | `customer_addresses` via `shipments.address_id` | — | [`loadSaleFiscalContext.ts:107-112`](../src/services/fiscal/loadSaleFiscalContext.ts#L107-L112) |

### Achado crítico #1 — Nuvemshop NUNCA cria `shipments`

Busquei `shipments`/`delivery_mode`/`address`/`shipping` no webhook inteiro de pedidos Nuvemshop: **zero ocorrências** de criação de `shipments`. O webhook chama `rpc_create_sale` diretamente ([`nuvemshop/order/route.ts:525-540`](../src/app/api/webhooks/nuvemshop/order/route.ts#L525-L540)) — essa RPC (confirmado em [20260617_rpc_create_sale_stock_mode.sql](../supabase/migrations/20260617_rpc_create_sale_stock_mode.sql), a versão mais recente) **não aceita `p_delivery_mode` e não cria `shipments` internamente**. Quem cria `shipments` é o CALLER — a rota manual faz isso explicitamente ([`route.ts:361-368`](../src/app/api/vendas/route.ts#L361-L368)); o webhook Nuvemshop não faz.

**Consequência: hoje, uma venda `sale_origin='website'` (Nuvemshop) não tem `delivery_mode` nem `shipments` — o campo que hoje distingue retirada/entrega simplesmente não existe pra essas vendas.**

### Achado crítico #2 — Nuvemshop NUNCA captura endereço de entrega

`findOrCreateCustomer` (usado pelo webhook) só grava `name`/`email`/`cpf`/`phone` ([`nuvemshop/order/route.ts:84-87`](../src/app/api/webhooks/nuvemshop/order/route.ts#L84-L87)). Busquei `customer_addresses`/`shipping_address`/`billing_address`/`address` no arquivo inteiro do webhook: **zero ocorrências**. O único dado de frete capturado é o VALOR (`order.total_shipping` → `shipping_charged`), nunca o endereço físico.

**Consequência prática, já hoje, sem nenhuma mudança de arquitetura: `loadSaleFiscalContext.ts` (que resolve endereço via `shipments.address_id` → `customer_addresses`) não encontra `shipments` para uma venda Nuvemshop, então `address` fica `null`, e todo o bloco `destinatario.*` de endereço fica `null`. `validateFiscalReadiness` já bloqueia essas vendas hoje por `destinatario_endereco_incompleto`/`destinatario_municipio_ibge_missing`.** Isso não é um blocker introduzido por NFC-e — é um blocker **pré-existente e mais urgente que a decisão de documento**, porque impede NF-e de vendas de site mesmo sem nenhuma mudança arquitetural.

---

## 2. Matriz de decisão — NF-e × NFC-e

| # | origem | modalidade (`delivery_mode`) | entrega? | cliente identificado? | documento sugerido | motivo |
|---|---|---|---:|---:|---|---|
| 1 | `store` (PDV) | `pickup` | não | não (CPF opcional) | **NFC-e** | Balcão, retirada — cenário padrão da NFC-e |
| 2 | `store` (PDV) | `delivery` | sim | depende | **NF-e** | Tem endereço de destino a informar — NFC-e permite `presenca_comprador=4` (entrega a domicílio) tecnicamente, mas NF-e é o padrão de mercado pra venda com frete próprio e permite modelar frete/transportador — ver nota abaixo |
| 3 | `other`/`instagram`/`referral`/`paid_traffic` (venda manual) | `pickup` | não | — | **NFC-e** | Mesma lógica de balcão — a origem de marketing não muda o fato de ser retirada presencial |
| 4 | `other`/`instagram`/`referral`/`paid_traffic` (venda manual) | `delivery` | sim | sim (endereço exigido) | **NF-e** | Entrega exige destinatário identificável |
| 5 | `website` (site, com `shipments` futuro) | `delivery` | sim | sim | **NF-e** | Ecommerce com entrega — cenário padrão pedido |
| 6 | `website` (site) + retirada na loja | `pickup` | não | — | **NF-e** (ver "não assuma" abaixo) — **DECISÃO NECESSÁRIA**, recomendação com ressalva | Ver análise dedicada abaixo |
| 7 | `website` = Nuvemshop hoje (não existe valor distinto) | indefinido (sem `shipments`) | — | — | **blocked** hoje | Sem `delivery_mode`/endereço, não há como decidir com segurança nem montar NF-e — precisa do Achado crítico #2 resolvido primeiro |
| 8 | Nuvemshop + retirada | mesmo caso 7 | — | — | **blocked** hoje | idem |
| 9 | venda sem `shipments` e sem `delivery_mode` (nem toda venda passa pela rota `/api/vendas`; ex.: RPCs antigas chamadas fora dela) | indefinido | — | — | **blocked** | Nunca inferir — ausência de sinal não é "retirada por padrão" |
| 10 | `sale_origin='website'` **com** `delivery_mode='pickup'` registrado (inconsistência aparente) | `pickup` | não | — | **NF-e**, recomendação — ver análise abaixo | Origem ecommerce prevalece sobre modalidade, por razão fiscal (não logística) — ver justificativa |

### "Site + retirada" — investigação pedida, não presumida

O pedido explicitamente pede pra não presumir isso. Investiguei três ângulos:

1. **層 técnica Focus/SEFAZ**: NFC-e no schema real (`NFCeRequest`, ver §7) permite `presenca_comprador` só `1` (presencial) ou `4` (entrega a domicílio) — **não existe um valor pra "venda não presencial com retirada posterior"**. Uma venda que nasceu como ecommerce (`presenca_comprador` semanticamente "não presencial") não tem representação limpa em NFC-e, cujo modelo assume presença física no momento da emissão (mesmo quando `4`=entrega, a nota nasce vinculada a uma operação de venda presencial/consumo imediato).
2. **Camada de negócio**: uma venda ecommerce com retirada na loja ainda é, do ponto de vista fiscal/documental, uma venda "não presencial" — o cliente comprou remotamente; retirar fisicamente depois é só a modalidade logística de entrega do bem, não muda a natureza da operação de venda documentada. NF-e modela isso naturalmente (`presenca_comprador=2`, já usado hoje, [`testFixtures.ts:76`](../src/services/fiscal/testFixtures.ts#L76)).
3. **Precedente prático**: grandes varejistas com "compre online, retire na loja" (BOPIS) emitem **NF-e**, não NFC-e, justamente porque a venda se originou fora do balcão — é o padrão observado no mercado, não uma regra SEFAZ explícita e centralizada que eu tenha conseguido confirmar num texto único.

**Recomendação (não implementar sem sua aprovação): origem `website` sempre força NF-e, independentemente de `delivery_mode`.** Ou seja, **origem prevalece sobre modalidade logística** pra decidir o tipo de documento. Isso é uma regra de negócio, marco explicitamente como **DECISÃO NECESSÁRIA** — a evidência técnica (item 1 acima) apoia fortemente essa recomendação, mas não existe uma fonte SEFAZ que eu tenha lido dizendo isso em termos absolutos pra este caso específico.

---

## 3. Escolha manual — quando (se alguma vez) permitir override

Concordo com a diretriz: **nenhum dropdown "Emitir NF-e ou NFC-e?"** pra fluxo normal — a função `resolveFiscalDocumentType(saleContext)` decide.

Cenário legítimo de override identificado: **correção operacional pós-erro de cadastro**. Exemplo real: vendedora lançou a venda como `delivery_mode='pickup'` por engano (era entrega), e a venda já foi paga/concluída antes de perceber. Sem override, o sistema tentaria NFC-e pra uma venda que deveria ter sido NF-e. Duas soluções possíveis, ambas preferíveis a um dropdown de emissão:
- (a) permitir **corrigir a venda** (`delivery_mode`/endereço) antes de emitir — resolve na origem, sem tocar a decisão fiscal;
- (b) só se (a) não for viável operacionalmente: um **override explícito, admin-only, com motivo obrigatório registrado** (auditoria) — nunca um dropdown livre pra qualquer vendedor, e sempre com o resultado normal (`resolveFiscalDocumentType`) visível ao lado como referência, pra deixar claro que é uma exceção.

Recomendo (a) como padrão e NÃO implementar (b) nesta fase — só documentar que existe esse cenário, decidir depois se a frequência real justificar.

---

## 4-5. NFC-e sem destinatário identificado + endereço — readiness separado

### O que a Focus/NFC-e realmente exige (evidência: `NFCeRequest`, `doc.focusnfe.com.br/reference/emitir_nfce`)

Campos **obrigatórios** em `NFCeRequest`: `cnpj_emitente`, `data_emissao`, `presenca_comprador`, `modalidade_frete`, `local_destino`, `natureza_operacao`, `items`, `formas_pagamento`. **Nenhum campo de destinatário está na lista de obrigatórios.**

Campos de destinatário existentes no schema, todos **opcionais**: `nome_destinatario`, `cnpj_destinatario`, `cpf_destinatario`, `indicador_inscricao_estadual_destinatario`. **Não existe nenhum campo de endereço de destinatário em `NFCeRequest`** (nada equivalente a `logradouro_destinatario`/`codigo_municipio_destinatario` da NF-e) — confirmado por leitura de todas as `properties` do schema completo, não por ausência de busca.

Isso bate exatamente com a regra de negócio pedida:
- **Balcão sem CPF** → payload sem nenhum campo de destinatário. Válido.
- **Balcão com CPF** → só `cpf_destinatario` preenchido. Válido — nenhum outro dado exigido.
- **Nunca existe "endereço obrigatório" em NFC-e** no nível de payload — a arquitetura atual de `validateFiscalReadiness` bloquear por `destinatario_endereco_incompleto`/`destinatario_municipio_ibge_missing` é **inteiramente uma regra de NF-e**, nunca deveria valer pra NFC-e.

### Proposta: `validateNfeReadiness` + `validateNfceReadiness`, sem duplicar

`validateFiscalReadiness.ts` hoje mistura 4 blocos: (a) estado da venda, (b) integração Focus, (c) emitente, (d) destinatário, (e) itens, (f) pagamentos. Dos 6, **(a)/(b)/(c)/(e)/(f) são idênticos pros dois documentos** — só (d) destinatário diverge de verdade (e "endereço do emitente"/`local_destino` têm nuance mínima).

Proposta de arquitetura (não implementar ainda):

```
validateFiscalDocumentReadiness(ctx, documentType: 'nfe' | 'nfce'): FiscalValidationError[]
  ├─ validateCommonReadiness(ctx)       // (a) venda, (b) Focus, (c) emitente, (e) itens, (f) pagamentos — reaproveitado 100%
  └─ if documentType === 'nfe'  → validateNfeDestinatario(ctx)   // regras atuais de (d), sem alteração
     if documentType === 'nfce' → validateNfceDestinatario(ctx) // NOVA: só valida CPF SE informado (formato), nunca exige nome/endereço/IBGE
```

Isso evita duplicar as ~80% das regras que são idênticas, e isola exatamente a parte que muda (destinatário) em duas funções pequenas e nomeadas — sem um `if (documentType === 'nfce') return []` disperso dentro do bloco de destinatário atual (o que ficaria confuso de ler/manter).

### `municipio_ibge` do destinatário — como resolver sem pedir IBGE manual

Já resolvido pra NF-e: `resolveMunicipioIbge(uf, cidade)` ([`resolveMunicipioIbge.ts`](../src/services/fiscal/resolveMunicipioIbge.ts)) — cache local (`ibge_municipios`) + API pública do IBGE como fallback, nunca pede ao operador digitar código. **Para NFC-e, esse campo não existe no payload** (não há endereço de destinatário), então essa resolução simplesmente não é necessária pra NFC-e — só continua sendo necessária pra NF-e (entrega/site), onde já funciona.

---

## 6. Reaproveitamento da infraestrutura atual

| Componente | Reaproveitável como está? | Nota |
|---|---|---|
| `fiscal_documents` (tabela) | ✅ Sim, com 1 mudança de CHECK | Ver §13 |
| `document_type` | ⚠️ Precisa aceitar `'nfce'` | `CHECK (document_type IN ('nfe'))` → `IN ('nfe', 'nfce')` — [20260821...sql:188-189](../supabase/migrations/20260821_focus_nfe_fiscal_foundation.sql#L188-L189) |
| `rpc_claim_fiscal_emission` | ✅ Sim, sem alteração | Já é genérica sobre `document_type` — o `WHERE ... AND document_type = 'nfe'` está **hardcoded** dentro da função (confirmado: `AND document_type = 'nfe'` aparece 2× no corpo, [20260826...sql](../supabase/migrations/20260826_fiscal_emission_claim.sql)) — precisa virar parâmetro `p_document_type`, não uma reescrita de lógica |
| `rpc_begin_fiscal_transmission` | ✅ Sim, sem alteração nenhuma | Não referencia `document_type` — opera só por `id`+`claim_token`+lease |
| `rpc_complete_fiscal_emission` | ✅ Sim, sem alteração nenhuma | Idem — nenhuma referência a `document_type` |
| claim / lease / `submission_started_at` / idempotência / reconciliation | ✅ 100% reaproveitável | Toda a máquina de concorrência é agnóstica ao tipo de documento fiscal — opera sobre a linha `fiscal_documents`, nunca sobre o payload |
| `integration_secrets` (token Focus) | ✅ Sim, mesmo token/CNPJ | NFC-e usa a mesma autenticação Basic Auth com o mesmo token de API — confirmado no OpenAPI (`securitySchemes.BasicAuth`, idêntico ao já documentado pra NF-e) |
| Focus HTTP client (`httpClient.ts`) | ⚠️ Precisa 2-3 funções novas | `issueFocusNfce`, `consultFocusNfce`, (futuramente) `cancelFocusNfce` — mesmo padrão de `issueFocusNfe`/`consultFocusNfe`, paths diferentes (§7) |
| `fiscal_context_snapshot`/`request_payload`/`provider_payload` (JSONB) | ✅ Sim, sem alteração de schema | Campos genéricos, já armazenam qualquer payload |
| XML/DANFE (`xml_path`/`danfe_path`) | ⚠️ Nome de campo é ambíguo mas reaproveitável | NFC-e chama o impresso de "DANFCe", não DANFE, e o formato é `.html` (confirmado na resposta `NFCeAutorizadaResponse.caminho_danfe`), não PDF como a NF-e — o CAMPO pode ser o mesmo, só o conteúdo/formato muda |
| Pagamentos (`sale_payments`, `paymentRules.ts`) | ⚠️ Precisa validar tabela de códigos pra NFC-e | Ver §7 — `forma_pagamento` da NFC-e é a mesma tabela nacional tPag, mas isso precisa confirmação empírica antes de assumir |
| NCM / origem / unidade (`fiscal_document_items`) | ✅ Sim | Mesmos campos, mesma tabela nacional de NCM |
| Auditoria (`created_at`/`updated_at`/triggers) | ✅ Sim | Genérico |
| `validateFiscalReadiness`/`buildNfePayload` | ⚠️ Split necessário | Ver §4-5 — grande parte reaproveitável, destinatário precisa dividir |

**Conclusão: a infraestrutura de transmissão (claim/lease/begin/complete/reconciliação/idempotência) é 100% reaproveitável sem nenhuma alteração de lógica — só precisa aceitar `document_type` como parâmetro em vez de hardcoded.** O que precisa de código novo é estritamente a camada de *builder*/*validação* específica de NFC-e, e 2-3 funções novas no HTTP client.

---

## 7. Focus — endpoints e payload NFC-e (pesquisa real, `doc.focusnfe.com.br`)

Fonte: `curl` bruto (user-agent de browser — o CDN bloqueia requisições sem UA) contra `https://doc.focusnfe.com.br/reference/{emitir_nfce,consultar_nfce,cancelar_nfce}.md`, que devolve o OpenAPI spec real em JSON embutido no markdown. Parseado com `python3`/`json`, nunca resumo de IA.

| Item | NF-e (já implementado) | NFC-e (real, confirmado) |
|---|---|---|
| Emissão | `POST /v2/nfe?ref=` | `POST /v2/nfce?ref=` — mesmo padrão de path, `ref` como query param |
| Consulta | `GET /v2/nfe/{ref}` | `GET /v2/nfce/{referencia}` |
| Cancelamento | não implementado | `DELETE /v2/nfce/{referencia}`, corpo `{justificativa}` (15-255 caracteres, obrigatório) |
| Síncrono/assíncrono | síncrono (autorizado/erro na mesma resposta) | **síncrono também** — mesmo modelo, nenhuma mudança de arquitetura de polling necessária |
| Servidores | `api.focusnfe.com.br/v2` / `homologacao.focusnfe.com.br/v2` | **idênticos** — mesmo host, mesma distinção homologação/produção |
| Autenticação | Basic Auth, usuário=token, senha vazia | **idêntica** |
| `presenca_comprador` | intervalo completo (0,1,2,3,4,5,9) | **restrito a `1` (presencial) ou `4` (entrega a domicílio)** — NFC-e não representa venda não-presencial "pura" |
| Destinatário obrigatório | sim (nome, documento, endereço) | **não** — todos os campos de destinatário são opcionais, e não existe NENHUM campo de endereço no schema |
| `codigo_municipio_destinatario` | existe, obrigatório | **não existe no schema NFC-e** |
| Itens — campos extra | `codigo_ncm`, `unidade_comercial`, `quantidade_comercial`, `valor_unitario_comercial`, `valor_bruto` | **mesmos + NOVOS**: `quantidade_tributavel`, `valor_unitario_tributavel`, `unidade_tributavel`, `valor_total_tributos` — campos que o builder de NF-e atual NÃO usa (ver nota abaixo) |
| `forma_pagamento` (tabela de códigos) | tPag nacional, confirmado empiricamente (`pix`→`'20'`, `cash`→`'01'`, `credit_card`→`'03'`, `debit_card`→`'04'`) | Schema documenta só `01,02,03,04,05,10-13,99` na descrição (truncada) — **A CONFIRMAR empiricamente antes de implementar**: não presumir que `pix→'20'` vale igual pra NFC-e sem golden sample real, mesma disciplina que exigiu 2 XMLs reais pra confirmar isso na NF-e |
| Numeração/série | Focus atribui automaticamente, nunca enviada por nós | **igual** — `numero`/`serie` opcionais em `NFCeRequest`, API atribui se omitido |
| Contingência offline | não existe conceito | **existe**: parâmetro `forma_emissao=offline`, campo `codigo_unico` (tag `cNF`), resposta tem `contingencia_offline`/`contingencia_offline_efetivada` — **fora de escopo nesta fase**, não implementar |
| CSC (Código de Segurança do Contribuinte) | não se aplica | Existe e é exigido — mas **não é campo do payload de emissão** (confirmado: ausente de `NFCeRequest`). Erro documentado: `"Código CSC não configurado. Solicite ao suporte técnico."` — configuração é feita **do lado da Focus**, por contato com o suporte deles, não algo que enviamos por API. **A CONFIRMAR operacionalmente com a Focus antes de habilitar** (não achei endpoint de configuração de CSC na API pública) |
| ID Token CSC | não se aplica | Mesma situação — não aparece como campo de request. A CONFIRMAR com a Focus se existe algum endpoint de configuração via API ou se é 100% manual via suporte |
| QR Code | não se aplica | `qrcode_url` na resposta de autorização — **campo novo**, sem equivalente em `fiscal_documents` hoje (mais próximo de `xml_path`/`danfe_path` — precisaria de uma coluna `qrcode_url` nova, ou reaproveitar `provider_payload` já que é o bruto da resposta) |
| XML | `caminho_xml_nota_fiscal` | mesmo campo/nome na resposta NFC-e |
| DANFE/DANFCe | `.pdf` (implícito, não confirmado nesta rodada — herdado de fases anteriores) | `caminho_danfe`, mas **formato `.html`**, chamado de DANFCe — confirmado explicitamente na descrição do campo (`"Formato .html (DANFCe)"`) |
| Erros específicos NFC-e | — | `empresa_nao_configurada` ("Empresa não configurada para emissão de NFCe") e `ambiente_nao_configurado` são **erros distintos dos de NF-e** — confirma que a habilitação de NFC-e é uma configuração SEPARADA da de NF-e do lado da Focus, mesmo pra uma empresa que já emite NF-e |

**Nota sobre campos tributáveis novos (`quantidade_tributavel`/`valor_unitario_tributavel`/`unidade_tributavel`/`valor_total_tributos`)**: são campos REAIS do layout NFC-e (distinção entre unidade comercial e unidade tributável existe também na NF-e no layout oficial da SEFAZ, mas o builder atual de NF-e não os usa — provavelmente porque nunca houve produto com essa distinção real no catálogo até agora). Preciso investigar se isso é uma lacuna JÁ existente no builder de NF-e (usando comercial=tributável sempre) ou algo específico de NFC-e antes de decidir se replico ou household herdo o mesmo padrão simplificado — **marcado para a fase de implementação, não decidido aqui**.

---

## 8. Configuração fiscal da empresa — o que falta

| Config | Já existe pra NF-e | Necessário adicional pra NFC-e |
|---|---|---|
| Token Focus (API) | ✅ `integration_secrets` (`api_token`) | Reaproveita — mesmo token |
| Ambiente (homologação/produção) | ✅ `company_fiscal_settings.nfe_environment` | Precisa `nfce_environment` OU um campo único `fiscal_environment` compartilhado — **DECISÃO NECESSÁRIA**: um ambiente por empresa ou por tipo de documento? Recomendo único (mais simples, evita estado inconsistente "NF-e em produção, NFC-e em homologação" por engano) |
| Habilitação | ✅ `nfe_enabled` | Precisa `nfce_enabled` — confirmado que a Focus trata como configuração SEPARADA (`empresa_nao_configurada` é erro específico de NFC-e) |
| Série | Não existe coluna — Focus atribui | Mesma abordagem funciona pra NFC-e (`numero`/`serie` opcionais, API atribui) — **nenhuma coluna nova necessária**, a menos que a operação real exija controle manual de série (não indicado até agora) |
| CSC / ID Token CSC | não se aplica | **A CONFIRMAR com a Focus** se precisamos armazenar algo no nosso lado — pela documentação pública, não é campo de request, é config do lado deles. Se a Focus confirmar que existe mesmo assim algum identificador que precisamos guardar (ex.: pra exibir/auditoria), o modelo seguro é reaproveitar `integration_secrets` (mesma tabela, nova `key`, ex. `'csc_id'`) — **nunca uma coluna nova em texto puro**, mesma disciplina de segredo já usada pro token |
| Certificado A1 | ✅ já configurado do lado da Focus pra NF-e (mesmo CNPJ) | Reaproveita — é o mesmo certificado/CNPJ, não há "certificado por tipo de documento" |
| Config específica do RN | Nenhuma encontrada até agora | Nenhuma identificada nesta pesquisa — CSC/NFC-e são regras nacionais (SEFAZ/Convênio), não há indicação de particularidade estadual na documentação Focus consultada |

**Nenhum secret novo é implementado nesta fase** — isso é auditoria, e o achado é que provavelmente não precisamos de nenhum secret novo (CSC parece ser 100% do lado da Focus). Confirmar com o suporte da Focus antes da primeira habilitação é o próximo passo operacional, não de código.

---

## 9. Matriz de readiness — NF-e 55 × NFC-e 65

| Validação | NF-e 55 | NFC-e 65 |
|---|---:|---:|
| NCM | obrigatório | obrigatório (mesmo `normalizeNcm`, mesma regra) |
| origem | obrigatório | obrigatório |
| unidade comercial | obrigatório | obrigatório |
| CFOP/CSOSN/CRT suportado | obrigatório (bloqueia CRT 2/3) | obrigatório (mesma regra — `SUPPORTED_CRT` é sobre o emitente, não sobre o documento) |
| CPF do cliente | conforme operação (sempre exigido pra NF-e, já que endereço/documento é obrigatório) | **opcional** — só valida formato SE informado, nunca exige |
| Nome do destinatário | obrigatório | opcional (só se CPF/CNPJ informado, faz sentido nomear; sem documento, sem nome exigido) |
| Endereço do cliente | obrigatório quando destino exige | **nunca exigido** — payload não tem campo pra isso |
| Município IBGE do destinatário | obrigatório (via `resolveMunicipioIbge`) | **não aplicável** — não existe campo |
| `presenca_comprador` | intervalo completo | restrito a presencial/entrega a domicílio — validação nova: bloquear se a venda for logicamente não-presencial sem entrega (ex.: site sem `delivery_mode`) |
| pagamento | obrigatório, soma bate com total | obrigatório, mesma regra (tabela de códigos a confirmar, §7) |
| emitente (CNPJ/IE/CRT/endereço) | obrigatório | obrigatório — mesmo bloco, reaproveitado 100% |
| certificado (via Focus) | obrigatório | obrigatório, mesmo certificado |
| CSC | não se aplica | **não é campo de payload** (ver §7/§8) — não validável no nosso lado; erro vem da Focus se não configurado |
| habilitação específica (`nfce_enabled`) | `nfe_enabled` | `nfce_enabled` — validação nova |
| venda cancelada/devolvida | bloqueia | bloqueia (mesma regra, reaproveitada) |

---

## 10. Impacto na UI

Conceito confirmado como viável com o que já existe: `SubmitNfeResult`/card de emissão já mostram status textual; a mudança é decidir o `documentType` ANTES de montar o texto/botão, e trocar as mensagens de erro condicionalmente (nunca mostrar "Código IBGE do destinatário ausente" quando `documentType === 'nfce'`, porque esse código de erro nem deveria ser gerado nesse caminho — resolvido na origem pela separação de readiness do §4, não por filtro na UI).

Pontos de atenção de UX:
- "Documento recomendado" deve deixar claro que é uma DECISÃO do sistema, não um convite a escolher — sem controle interativo pra trocar (exceto o cenário de correção do §3).
- Exibir CPF mascarado (`Maria • CPF ***`) quando presente — dado sensível, mesmo cuidado já aplicado em `SubmitNfeResult` (nunca vaza segredo/token).
- Estado "consumidor não identificado" precisa ser um estado visual de PRIMEIRA CLASSE (não um "faltou preencher"), já que é o caminho feliz mais comum de NFC-e — mensagens diferentes de "erro" vs. "informação".

---

## 11. Emissão sobre venda já concluída — confirmado, sem efeito colateral

Auditei `submitNfeHomologacao.ts` inteiro por todo `.from(`/`.rpc(` fora do bloco fiscal: **zero ocorrências** — só toca `fiscal_documents`, `fiscal_document_items`, `company_fiscal_settings` (leitura), e as 3 RPCs fiscais (que, auditadas na Fase 3B/residual #2, só tocam `fiscal_documents`). `loadSaleFiscalContext.ts` é **só leitura** (confirmado por sua própria natureza — nenhum `.insert()`/`.update()`/`.delete()` em todo o arquivo, mesma auditoria da Fase 2A).

**Confirmado, com evidência de código, não suposição**: emitir documento fiscal sobre uma venda já concluída **não** movimenta estoque, não cria pagamento, não altera caixa, não altera comissão, não recria a venda. Só cria/atualiza `fiscal_documents`/`fiscal_document_items`. Isso vale igualmente pra NFC-e (mesma infraestrutura, §6) — nenhuma mudança introduz um novo ponto de escrita fora do fiscal.

---

## 12. Cancelamento — arquitetura preparada, não implementada

Não implementado nesta fase (nem NF-e nem NFC-e). Pontos que a arquitetura atual JÁ garante, e que continuam válidos pra um cancelamento futuro de qualquer um dos dois documentos:
- **Nenhuma RPC comercial faz HTTP** — claim/lease/begin/complete são todas transações curtas, sem chamada de rede dentro de uma transação de banco (confirmado nas Fases 3B e no fechamento do risco residual #2). Um `rpc_claim_fiscal_cancellation` futuro seguiria o MESMO padrão, sem acoplar a chamada `DELETE /v2/nfce`/`DELETE /v2/nfe` a nenhuma RPC de venda.
- `status` já tem `cancelled`/`cancellation_failed` no CHECK (ambos documentos, já que é o mesmo enum de `fiscal_documents.status`) — só falta a RPC de cancelamento e o cliente HTTP (`cancelFocusNfe`/`cancelFocusNfce`), nenhuma mudança de schema de status necessária.
- Devolução/troca/pendência fiscal ficam como conceitos SEPARADOS do documento fiscal em si (não modelar dentro de `fiscal_documents` — são processos comerciais que podem ou não desencadear um cancelamento/nova emissão fiscal depois).

---

## 13. Migrações necessárias — delta de schema (auditoria, não aplicar)

### `fiscal_documents`

```sql
-- 1. document_type precisa aceitar 'nfce'
ALTER TABLE public.fiscal_documents DROP CONSTRAINT <nome_atual_do_check>;
ALTER TABLE public.fiscal_documents ADD CONSTRAINT ... CHECK (document_type IN ('nfe', 'nfce'));
-- (nome exato da constraint precisa ser confirmado via \d fiscal_documents ou
--  information_schema — a migration original usa CHECK inline sem nome
--  explícito, então o Postgres gerou um nome automático que precisa ser
--  consultado no banco real antes de qualquer ALTER)

-- 2. considerar (DECISÃO NECESSÁRIA, não decidido aqui): reforçar
--    uq_fiscal_documents_sale_authorized pra impedir NF-e E NFC-e
--    simultaneamente autorizadas pra mesma venda, se essa for de fato uma
--    invariante desejada (hoje o índice é (sale_id, document_type), então
--    tecnicamente permite as duas). Recomendo MANTER como está nesta fase
--    (resolveFiscalDocumentType já deveria prevenir isso na origem) e só
--    reforçar no banco se aparecer um caso real de tentativa de emitir os
--    dois pra mesma venda.

-- 3. possível coluna nova pra QR Code (NFC-e não tem equivalente NF-e)
ALTER TABLE public.fiscal_documents ADD COLUMN IF NOT EXISTS qrcode_url TEXT;
```

### `company_fiscal_settings`

```sql
ALTER TABLE public.company_fiscal_settings
  ADD COLUMN IF NOT EXISTS nfce_enabled BOOLEAN NOT NULL DEFAULT false;
  -- nfce_environment: só se a decisão do §8 for "ambiente por tipo de
  -- documento" em vez de único — recomendo NÃO adicionar, reaproveitar
  -- nfe_environment renomeado conceitualmente (não é NF-e-específico hoje,
  -- é só "ambiente fiscal da empresa")
```

### `rpc_claim_fiscal_emission`

Não é uma migration de schema, mas uma migration de FUNÇÃO: `AND document_type = 'nfe'` (hardcoded, 2 ocorrências no corpo da função) precisa virar `AND document_type = p_document_type`, com o novo parâmetro `p_document_type text` adicionado à assinatura. Isso muda a assinatura da função (novo parâmetro) — precisa dropar/recriar como sempre, e **todo chamador em `submitNfeHomologacao.ts`/futuro `submitNfceHomologacao.ts` precisa passar o parâmetro novo**.

### `provider_ref`

`buildProviderRef(companyId, saleId)` hoje devolve `qarvon-{company_id}-{sale_id}-nfe` — sufixo hardcoded `-nfe`. Pra NFC-e, precisa de uma ref DETERMINÍSTICA e DISTINTA (nunca a mesma ref de uma eventual NF-e da mesma venda, já que `UNIQUE(provider, provider_ref)` é global por provider): `qarvon-{company_id}-{sale_id}-nfce`. Isso é mudança de CÓDIGO (`buildProviderRef` receber o tipo), não de migration — mas listo aqui porque afeta diretamente a constraint de unicidade.

### Série

Nenhuma coluna de série própria necessária — mesma decisão já tomada pra NF-e (deixar a Focus atribuir), documentada no comentário original da migration.

### CSC

Nenhuma migration necessária a menos que a Focus confirme que precisamos armazenar algo — nesse caso, reaproveita `integration_secrets` (tabela existente, só uma `key` nova), sem alteração de schema.

---

## 14. Testes propostos (não implementados)

### Resolução do tipo (`resolveFiscalDocumentType`)
- `delivery_mode='pickup'`, `sale_origin` qualquer exceto `website` → `nfce`
- `delivery_mode='delivery'` → `nfe`
- `sale_origin='website'` → `nfe` (independente de `delivery_mode`, pela recomendação do §2 — sujeito à sua aprovação)
- sem `shipments`/`delivery_mode` indefinido → `blocked`
- `sale_origin` ausente/inválido → `blocked`
- venda `cancelled`/`returned` → `blocked` (reaproveita regra existente)

### NFC-e (readiness + payload)
- consumidor anônimo (sem CPF) → válido, payload sem bloco de destinatário
- CPF informado → válido, só `cpf_destinatario` no payload
- PIX / dinheiro / cartão crédito / cartão débito → formas de pagamento corretas (após confirmação empírica dos códigos, §7)
- múltiplos pagamentos → array `formas_pagamento`, mesma lógica de soma da NF-e reaproveitada
- NCM inválido → bloqueia antes de begin/POST (reaproveita `normalizeNcm`/`validateCommonReadiness`)
- produto fiscalmente incompleto (sem NCM/origem/unidade) → bloqueia, mesmas regras comuns

### NF-e
Manter os 613 testes existentes passando sem alteração de comportamento — qualquer refactor de `validateFiscalReadiness` em `validateCommonReadiness`+`validateNfeDestinatario` precisa ser prova de que o resultado combinado é idêntico ao atual pra `documentType='nfe'`.

### Concorrência
Reaproveitar a suíte de `submitNfeHomologacao.concurrency.test.ts` parametrizada por `document_type` (ou duplicada com o mínimo necessário) — mesma garantia `claim → begin → POST → complete` sem emissão duplicada, agora também provando que uma claim de NFC-e nunca interfere com uma claim de NF-e da mesma venda (linhas `fiscal_documents` distintas, `provider_ref` distintas).

---

## Estratégia de compatibilidade com o subsistema atual

- **Nada quebra**: toda mudança proposta em `rpc_claim_fiscal_emission` (novo parâmetro `p_document_type`) e no CHECK de `document_type` é aditiva — `submitNfeHomologacao.ts` chamando com `p_document_type='nfe'` continua funcionando exatamente igual.
- **Sem flag de feature necessária**: `nfce_enabled=false` por padrão já impede qualquer tentativa até habilitação explícita — funciona como o próprio "flag" natural.
- **UI**: card de emissão atual continua servindo NF-e sem mudança visível até `resolveFiscalDocumentType` ser introduzido — a decisão de qual documento mostrar é aditiva, não substitutiva.

## Fases pequenas de implementação (proposta, ordem sugerida)

1. **Fase 4A** — resolver Achado crítico #2 (endereço Nuvemshop) OU aceitar formalmente que site fica bloqueado até isso existir — pré-requisito, não NFC-e em si.
2. **Fase 4B** — `p_document_type` em `rpc_claim_fiscal_emission` + CHECK aceitar `'nfce'` + `buildProviderRef` por tipo. Sem nenhum builder novo ainda — só prepara o schema/RPC.
3. **Fase 4C** — `resolveFiscalDocumentType` (pura, testável isoladamente, sem tocar emissão real).
4. **Fase 4D** — split `validateCommonReadiness`/`validateNfeDestinatario`/`validateNfceDestinatario` — prova de regressão zero em NF-e.
5. **Fase 4E** — `buildNfcePayload` + `issueFocusNfce`/`consultFocusNfce` (confirmação empírica de `forma_pagamento` ANTES desta fase, via homologação real ou golden sample, mesma disciplina da NF-e).
6. **Fase 4F** — `nfce_enabled` em `company_fiscal_settings` + UI condicional (§10).
7. **Fase 4G** — primeira emissão de homologação NFC-e real, ponta a ponta.

## Blockers antes da primeira NFC-e de homologação

1. Confirmação empírica da tabela `forma_pagamento` da NFC-e (não presumir igual à NF-e sem prova).
2. Confirmação com a Focus sobre configuração de CSC (contato de suporte, fora do código).
3. `nfce_enabled`/habilitação da empresa do lado da Focus (operacional, mesmo padrão de `nfe_enabled`).
4. Decisão sua sobre "site + retirada" (§2) e sobre ambiente único vs. por documento (§8) — ambas marcadas **DECISÃO NECESSÁRIA**.
5. Achado crítico #1/#2 do §1 não bloqueiam NFC-e de balcão (não dependem de Nuvemshop) — só bloqueiam o caminho NF-e de site, que já está bloqueado hoje independente desta fase.

---

**Nada foi implementado. Aguardando sua aprovação do desenho antes de qualquer código/migration.**
