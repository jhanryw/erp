# Fase Fiscal 5 — Vendas com Entrega/Site: Auditoria + Proposta Arquitetural

**PRONTO PARA IMPLEMENTAR: NÃO**

Documento de auditoria + proposta — nenhum código foi alterado, nenhuma migration foi criada, nenhuma chamada à Focus foi feita. Toda afirmação sobre o ERP tem evidência `arquivo:linha`, coletada por leitura direta do código e das migrations nesta rodada (5 auditorias paralelas read-only + verificação cruzada manual). Onde uma afirmação depende de regra fiscal externa (legislação, não código do ERP), isso está marcado explicitamente como entendimento geral a confirmar com a contabilidade — nunca apresentado como fato do sistema.

Este documento **não repete** o que já está resolvido/documentado nas fases fiscais anteriores — ele referencia:
- [`fiscal-fase3-auditoria-completa.md`](fiscal-fase3-auditoria-completa.md) — máquina de estados do documento fiscal, cancelamento/devolução/troca.
- [`fiscal-fase4-nfce-arquitetura-proposta.md`](fiscal-fase4-nfce-arquitetura-proposta.md) — NFC-e, `resolveFiscalDocumentType`, `resolveMunicipioIbge`.

Escopo explicitamente **fora** desta auditoria (confirmado que nada abaixo foi tocado): `resolveFiscalDocumentType`, claim/lease/begin/complete, reconciliação, idempotência, cancelamento fiscal, automação de emissão, produção, NFC-e homologada. Atacado não entra nesta fase (nenhum campo real identifica venda de atacado hoje — mesma conclusão já registrada em `fiscal-fase4-nfce-arquitetura-proposta.md:27-31`).

---

## DECISÕES DE NEGÓCIO NECESSÁRIAS (resumo — detalhe em cada seção)

| # | Decisão | Bloqueia | Seção |
|---|---|---|---|
| D1 | Snapshot imutável do destinatário/endereço: tabela nova dedicada por venda, vs. congelar em `shipments` — aprovar desenho exato | Fase A (schema) | §13 |
| D2 | Fonte primária do código IBGE automático: ViaCEP (já integrado, mas descarta o campo hoje) como 1ª camada + `resolveMunicipioIbge` (já existe) como 2ª camada — aprovar a cascata | Fase A | §13 |
| D3 | Acréscimo comercial **global** (`sales.surcharge_amount`) na NF-e vai hoje para `valor_outras_despesas` (vOutro), não para `valor_bruto` (vProd) — confirmar se isso é aceitável, ou se a intenção "produto R$88" exige que todo acréscimo conhecido vire preço de item (sem usar o campo global) | Fase D (payload) | §6, §12, §14 |
| D4 | `products_total` NULL desde 14/06/2026 (achado herdado da Fase 3) — corrigir (backfill) ou descontinuar a coluna | Nenhuma (não bloqueia esta fase) | §11 |
| D5 | Divergência real entre relatórios: DRE (`vw_dre_mensal`) **exclui** frete da receita; Dashboard/ticket médio/relatório de vendas **incluem** — qual é a leitura "oficial" de faturamento? | Fase C (relatórios) | §11, §16 |
| D6 | `sale_shipping` é tabela órfã (existe no banco, zero código a usa) e não existe categoria de **receita** de frete em `finance_entries` (só despesa `freight_cost`) — desenhar (ou formalmente descartar) essa separação | Fase C | §11, §15 |
| D7 | Momento de resolução de endereço/IBGE para pedidos Nuvemshop: capturar e resolver no momento do webhook (síncrono, pode falhar o pedido) vs. só na hora de emitir NF-e (lazy, pode ficar pendente indefinidamente) | Fase E (Nuvemshop) | §8, §13 |
| D8 | Override manual quando o vendedor errou `delivery_mode` numa venda já paga — permitir corrigir a venda (recomendado) e/ou criar exceção admin-only auditada — mesma pergunta já levantada em `fiscal-fase4-nfce-arquitetura-proposta.md:65-69`, ainda sem resposta | Não bloqueia | §10 |
| D9 | Hierarquia de ajuste por item vs. rateio global (`allocateOrderAdjustments`) já implementada como "item primeiro, rateio só para o residual verdadeiramente global" — confirmar que esse desenho já atende a intenção da seção 6 do pedido, ou pedir mudança | Fase D | §14 |

---

## 1. Schema atual relevante

Achado transversal importante antes de tudo: **`sales`, `sale_items`, `shipments`, `customers`, `customer_addresses` e `sale_shipping` não têm nenhum `CREATE TABLE` em `supabase/migrations/*.sql`** — a árvore de migrations só contém `ALTER TABLE`/RPCs sobre elas. A única definição completa dessas tabelas é o dump estático `DATABASE_SCHEMA.sql` (raiz do repo), que está **desatualizado e provadamente errado em vários pontos** (ex.: não tem `company_id` em `shipments`/`customers`, que o código claramente usa; nomes de coluna divergentes — `courier_name` no dump vs. `motoboy` real, ver §11). Todo o schema abaixo foi reconstruído cruzando o dump com as migrations que fazem `ALTER TABLE`/inserts reais — qualquer coluna listada só no dump está marcada como tal.

### `sales` (colunas confirmadas por `INSERT INTO sales` do `rpc_create_sale` vigente)

`supabase/migrations/20260817_sale_rpcs_emit_outbox_events.sql:242-257` (última reescrita — nenhuma migration posterior redefine o corpo, confirmado pelo próprio comentário do arquivo nas linhas 37-39):

```
customer_id, seller_id, status, subtotal, discount_amount, surcharge_amount,
cashback_used, shipping_charged, total, payment_method, sale_origin, notes,
sale_date, company_id, cash_session_id, responsible_seller_id
```

Zero colunas de endereço/entrega/destinatário. `products_total` existe na tabela (`20260613_shipping_fiscal_ready.sql`) mas **não é inserida** por nenhuma versão vigente do RPC (ver §11, achado herdado da Fase 3).

### `sale_items` (`DATABASE_SCHEMA.sql:407-423`, cross-checado com o `INSERT` real do RPC)

```
id, sale_id, product_variation_id, stock_lot_id, quantity,
unit_price NUMERIC(10,2), unit_cost NUMERIC(10,4),
discount_amount NUMERIC(10,2) DEFAULT 0,
total_price NUMERIC(10,2),              -- (unit_price*quantity) - discount_amount
gross_profit NUMERIC GENERATED ALWAYS AS (total_price - unit_cost*quantity) STORED
```

**Não existe** coluna de acréscimo/surcharge por item, nem `subtotal` por item, nem preço de catálogo/original — só `total_price`. Confirmado por grep exaustivo (zero `ALTER TABLE sale_items ADD COLUMN` em qualquer migration).

### `shipments` (colunas populadas por app code, confirmado por todo `.insert()`/`.update()` em `src/`)

Schema-base só no dump (`DATABASE_SCHEMA.sql:1285-1309`), colunas reais adicionadas por migration:
- `mod_frete SMALLINT NOT NULL DEFAULT 0` — [`20260613_shipping_fiscal_ready.sql:86`](../supabase/migrations/20260613_shipping_fiscal_ready.sql#L86) (0=CIF/emitente paga, 1=FOB/destinatário, 9=sem frete — comentário da própria coluna).
- `internal_cost_real`, `repasse_status`, `repasse_amount`, `repasse_paid_at`, `repasse_finance_entry_id` — mesma migration, linhas 95-113.
- `courier_phone` — [`20260613_rpc_pagar_repasse.sql:9-10`](../supabase/migrations/20260613_rpc_pagar_repasse.sql).
- `repasse_batch_id` — [`20260613_rpc_pagar_repasse_lote.sql:55`](../supabase/migrations/20260613_rpc_pagar_repasse_lote.sql).
- A coluna real para nome do entregador é **`motoboy`**, não `courier_name` como o dump afirma — confirmado em uso vivo (`src/app/api/shipping/shipments/[id]/route.ts:24,96`, `src/app/api/shipping/repasse/route.ts:24`) e sem DDL rastreável (mais um ponto de drift do dump vs. banco real).

**Colunas efetivamente escritas por algum código, hoje** (auditado em todo `src/app/api/shipping/**` e `src/app/api/vendas/route.ts`): no create — `order_id`, `customer_id`, `delivery_mode`, `status`, `notes`, `company_id`. No update — `status`, `internal_cost_real`, `repasse_amount`, `motoboy`, `courier_phone`, `notes`.

**Nunca escritas por nenhum código encontrado** (ficam sempre `NULL`/default): `address_id`, `origin_id`, `zone_id`, `rule_id`, `distance_km`, `client_shipping_price`, `internal_shipping_cost_estimated/real` (nomes do dump, não confirmados no schema vivo), `shipping_subsidy`, `courier_name`, `dispatched_at`, `delivered_at`, `pickup_at`, `proof_url`, e **`mod_frete` nunca é escrito explicitamente por app code** — vive só do `DEFAULT 0` da coluna (o que, por acaso, já é o valor fiscalmente correto para o cenário real da Santtorini, ver §12).

### `customer_addresses` (só no dump, `DATABASE_SCHEMA.sql:1259-1277` — sem `CREATE TABLE` em migration)

```
id, customer_id, cep, street, number, complement, neighborhood,
city, state, reference, latitude, longitude, geocode_source,
is_validated, is_default, created_at, updated_at
```

Mapeamento para os campos em português pedidos: `street`=logradouro, `number`=número, `complement`=complemento, `neighborhood`=bairro, `city`=município, `state`=UF. **Nenhuma coluna de código IBGE.** Confirmado explicitamente no comentário de `supabase/migrations/20260823_ibge_municipios_cache.sql:8-9`: *"`customer_addresses` não tem coluna de código IBGE (confirmado na Fase 2A)"*.

### `customers`

`cpf` (nullable desde [`20260521_webhook_idempotency.sql:72-73`](../supabase/migrations/20260521_webhook_idempotency.sql), formato `CHECK (cpf ~ '^\d{11}$')`), `name`, `phone` (nullable, mesma migration), `phone_e164` (só para matching, [`20260816_customer_identity_phone_e164.sql:26`](../supabase/migrations/20260816_customer_identity_phone_e164.sql)). **Sem CNPJ em lugar nenhum** — confirmado por grep exaustivo; a única lacuna adjacente é `tax_id` numa tabela de identidade CRM não-autoritativa (`20260708_crm_identity_layer.sql:85`, comentário próprio: "informativo — não é o cadastro fiscal autoritativo").

### `sale_shipping` — tabela órfã, existe no banco mas não no código

Confirmada como **viva no banco real** só indiretamente (aparece na lista de tabelas com RLS desabilitada em `docs/fiscal-database-validation-results.md:84`), sem `CREATE TABLE` em nenhuma migration. Schema só no dump (`DATABASE_SCHEMA.sql:428-437`): `id, sale_id UNIQUE FK sales, charged_amount, actual_cost, carrier, tracking_code, shipped_at, delivered_at, paid_at`. **Zero código em `src/` lê ou escreve nela** (grep de `.from('sale_shipping')`: zero ocorrências). Único consumidor é uma view não usada por ninguém (`vw_sale_shipping_summary`, ver §11).

### `finance_entries` / `cash_movements` — categorias relevantes a frete

`finance_category` enum (`src/lib/db/migrations/000_schema_completo.sql`): receitas = `'sale' | 'cashback_used' | 'other_income'`; despesas incluem `'freight_cost'`. **Existe categoria de despesa de frete, não existe categoria de receita de frete** — todo frete cobrado do cliente cai dentro de `category='sale'` junto com a mercadoria (ver §11). `cash_movements` não tem nenhuma coluna/categoria relacionada a frete (grep exaustivo, zero hits em 11 migrations que tocam a tabela).

### Tabelas fiscais (já documentadas em detalhe na Fase 3/4, resumo aqui)

`company_fiscal_settings`, `fiscal_documents`, `fiscal_document_items`, `ibge_municipios` (cache local + API pública do IBGE) — ver `fiscal-fase3-auditoria-completa.md:11-19`.

---

## 2. Fluxo atual de retirada ("pickup")

Campo: `shipments.delivery_mode = 'pickup'`. Selecionado no formulário de nova venda por um toggle "📦 Retirada" ([`src/app/(dashboard)/vendas/nova/page.tsx:513-529`](../src/app/(dashboard)/vendas/nova/page.tsx)), default do form é `'delivery'` (linha 123), validado no Zod tanto no cliente (`src/lib/validators/index.ts:117`) quanto na API (`src/app/api/vendas/route.ts:185`).

Retirada exige sessão de caixa aberta — regra só de UI, não de schema (`vendas/nova/page.tsx:534-544,649`).

`rpc_create_sale` **não recebe `delivery_mode`** — a venda em si (`sales`) nunca soube dessa distinção. Depois de criar a venda, a rota `POST /api/vendas` cria o `shipments` **separadamente e de forma não-atômica**: `src/app/api/vendas/route.ts:360-373`. O comentário no próprio código confirma que essa segunda escrita pode falhar silenciosamente sem desfazer a venda:
```
// Erro no shipment é não-fatal: a venda já foi criada
```
Para retirada, `shipmentStatus = 'aguardando_retirada'`.

Consequência: uma venda de retirada pode, em tese, ficar **sem nenhuma linha em `shipments`** se esse segundo insert falhar — e nesse caso `resolveFiscalDocumentType` ainda resolve corretamente para NFC-e via a regra 4 (ausência de `shipments` + `sale_origin='store'` → NFC-e, ver `resolveFiscalDocumentType.ts:19-22`), mas para qualquer outra origem, ficaria `blocked`.

Para NFC-e, **nenhum dado de endereço é necessário** (confirmado em `fiscal-fase4-nfce-arquitetura-proposta.md:73-84` — o schema `NFCeRequest` da Focus não tem nenhum campo de endereço de destinatário). Isso está corretamente alinhado com o que a retirada hoje já coleta (nada).

---

## 3. Fluxo atual de entrega ("delivery")

Mesmo formulário, mesmo toggle, `delivery_mode='delivery'`. A rota `POST /api/vendas` cria `shipments` com `status='aguardando_confirmacao'` ([`route.ts:360-373`](../src/app/api/vendas/route.ts)).

**O que falta, hoje, para uma venda de entrega estar pronta para NF-e:**
- `shipments.address_id` **nunca é preenchido por nenhum código** (grep exaustivo em `src/app/api/shipping/**`: só aparece em `SELECT`, nunca em `.insert()`/`.update()`). Fica sempre `NULL`.
- Não existe nenhum formulário de endereço na criação da venda — o formulário de venda (`vendas/nova/page.tsx`) não tem nenhum campo de logradouro/número/bairro/CEP/UF/município.
- O formulário de cliente (`customerSchema`, `src/lib/validators/index.ts:63-75`) também não tem campos de endereço — só `cpf, name, phone, birth_date, city, state, origin, notes` (note: `customers.city`/`customers.state` são texto livre na própria tabela `customers`, **não** ligados a `customer_addresses`).
- `customer_addresses` tem só 2 leituras em todo o código (`vendas/[id]/imprimir/page.tsx:57`, `loadSaleFiscalContext.ts:108`) e **zero escritas** — a tabela existe no schema mas está, na prática, morta: nenhum fluxo do sistema hoje escreve nela.

**Conclusão operacional**: hoje, uma venda de entrega criada pelo PDV/admin **não tem como ficar pronta para NF-e** sem alguém inserir manualmente uma linha em `customer_addresses` e depois ligar `shipments.address_id` a ela por fora do fluxo normal — nenhuma tela faz isso. `validateNfeReadiness`/`validateFiscalReadiness` bloqueia corretamente (`destinatario_endereco_incompleto`), sem crash, sem dado inventado — mas o formulário nunca oferece o caminho para resolver isso.

---

## 4. Fluxo atual do site/Nuvemshop

Webhook: `src/app/api/webhooks/nuvemshop/order/route.ts` (582 linhas, lido por completo). Eventos tratados: `orders/paid`, `order/paid`, `orders/cancelled`, `order/cancelled`, `orders/updated` (linhas 184-190). Re-busca o pedido completo na API REST da Nuvemshop (linhas 203-206) em vez de confiar só no payload do webhook.

**Campos lidos do payload**: `order.id/status/payment_status/total/subtotal/discount/total_shipping/promotional_discount`, `order.customer.{name,email,phone,identification}`, `order.products[].{...,price}`, `order.payment_details.{method,installments,credit_card_company}` (tipos em `route.ts:25-58`).

**O que é gravado:**
- `pedidos` (staging) — `route.ts:264-284`.
- `pedidos_itens` — `route.ts:393,409-412`.
- `customers` — criado/casado por e-mail ou CPF (`findOrCreateCustomer`, `route.ts:79-133`), só `name/email/cpf/phone/phone_e164/origin:'website'`.
- `sales`/`sale_items`/`sale_payments` — via `rpc_create_sale` (`route.ts:525-540`), com `p_sale_origin:'website'` hardcoded (linha 530), **sem** `p_delivery_mode` (o RPC nem aceita esse parâmetro).

**O que NUNCA é gravado — confirmado por grep no arquivo inteiro, zero ocorrências:**
- `customer_addresses` / `shipping_address` / `billing_address` / `address`.
- `shipments` — nenhuma linha é criada. Isso é consistente com o RPC chamado (`20260617_rpc_create_sale_stock_mode.sql`/versões seguintes) não ter parâmetro de endereço/entrega nem criar `shipments` internamente — quem cria `shipments` é sempre o *caller*, e o webhook Nuvemshop nunca faz essa chamada adicional (diferente da rota manual, que faz).

**Consequência em cadeia, já confirmada em código**: `loadSaleFiscalContext.ts:93-113` resolve o endereço do destinatário só via `shipments.address_id → customer_addresses`. Sem `shipments`, `address` fica `null`, e todo o bloco `destinatario.*` de endereço fica `null` — `validateFiscalReadiness` bloqueia corretamente hoje (`destinatario_endereco_incompleto`/`destinatario_municipio_ibge_missing`), mas **toda venda do site fica estruturalmente impossibilitada de emitir NF-e**, não é uma falha ocasional.

**`sale_origin` não distingue Nuvemshop de qualquer outra venda manual marcada como site** — o enum `customer_origin` só tem `'website'`, sem valor `'nuvemshop'` dedicado (confirmado: zero uso de `'nuvemshop'` como valor em qualquer lugar).

**Desconto**: desconto de pedido (`order.discount`) é capado para não exceder o subtotal dos itens (`route.ts:486`, `discountSafe = Math.min(nuvemshopDiscount, itemsSubtotal)`, evitando violar a constraint `sales_discount_valid`) e vira `p_discount_amount` (order-level). **Desconto por item nunca é capturado** — cada item chega com `discount_amount: 0` hardcoded (`route.ts:474`), mesmo que a Nuvemshop tenha aplicado desconto por linha. `promotional_discount` da Nuvemshop só é guardado como JSON opaco em `sale_payments.metadata` (`route.ts:520`), nunca aplicado a `sale_items` ou `sales.discount_amount` de forma estruturada.

**Pagamento**: `sale_payments` é criado normalmente via o mesmo RPC, com `acquirer:'nuvemshop'`, `method` mapeado só para `'pix'|'card'|'cash'` (`mapPaymentMethod`, `route.ts:67-73`).

---

## 5. Origem de cada dado usado pela NF-e

Tabela consolidada — de onde vem cada campo do payload Focus hoje, via `loadSaleFiscalContext.ts`/`buildNfePayload.ts`:

| Campo NF-e | Fonte no ERP | Evidência |
|---|---|---|
| `nome_destinatario`, `cpf_destinatario`/`cnpj_destinatario`, `telefone_destinatario`, `email_destinatario` | `customers` (via `sales.customer_id`) | `loadSaleFiscalContext.ts` |
| `logradouro_destinatario`, `numero_destinatario`, `bairro_destinatario`, `municipio_destinatario`, `uf_destinatario`, `cep_destinatario`, `complemento_destinatario` | `customer_addresses`, via `shipments.address_id` | `loadSaleFiscalContext.ts:93-113` |
| `codigo_municipio_destinatario` | `resolveMunicipioIbge(uf, municipio)` — cache `ibge_municipios` + API pública do IBGE, nunca hardcode | `src/services/fiscal/resolveMunicipioIbge.ts:49` |
| `modalidade_frete` | `shipments.mod_frete` (default `0`=CIF se existe shipment; `9`=sem frete se não existe) | `loadSaleFiscalContext.ts:202` |
| item `codigo_ncm`, `icms_origem` | `products.ncm`, `products.origem` (não `product_variations`) | `20260615_products_fiscal_fields.sql:5-9`; join em `loadSaleFiscalContext.ts:91,135,137` |
| item `valor_unitario_comercial`, `valor_bruto`, `valor_desconto` | `sale_items.unit_price`, `sale_items.discount_amount` (verbatim, sem comparação com catálogo) | `buildNfePayload.ts:60-62` |
| `valor_frete`/`valor_outras_despesas` por item | rateio proporcional de `sales.shipping_charged`/`sales.surcharge_amount` via `allocateOrderAdjustments` | ver §14 |
| `valor_desconto` adicional por item | rateio proporcional de `sales.discount_amount` (soma ao desconto que o item já tinha) | idem |
| `formas_pagamento[]` | `sale_payments` | `buildNfePayload.ts:120-128` |
| `presenca_comprador` | parâmetro explícito passado pelo chamador, sem default automático por canal | `fiscal-fase3-auditoria-completa.md:156-158` |

---

## 6. Gaps de destinatário/endereço

Consolidando §3/§4 em uma lista de gaps concretos:

1. **Sem formulário de captura de endereço em nenhum ponto do sistema** — nem no cadastro de cliente, nem na criação da venda, nem no webhook Nuvemshop.
2. **`customer_addresses` é uma tabela morta na prática** — existe no schema, tem só 2 leituras, zero escritas.
3. **`shipments.address_id` nunca é setado** — mesmo se `customer_addresses` tivesse dados, nada liga a venda a eles.
4. **Sem CNPJ em `customers`** — destinatário PJ é estruturalmente impossível hoje (fora de escopo desta fase, conforme "atacado fica para depois", mas documentado porque uma entrega B2B eventual esbarraria nisso).
5. **Sem snapshot** — mesmo se o endereço existisse, não há nenhuma coluna/tabela que congele o dado no momento da venda (ver §13, é o núcleo da pergunta 2 do pedido original).

---

## 7. Gaps de código IBGE

- **Zero coluna de IBGE em `customer_addresses`, `sales` ou `shipments`.** Confirmado no próprio comentário de `20260823_ibge_municipios_cache.sql:8-9`.
- **Já existe resolução automática — não é um gap de arquitetura, é um gap de dado de entrada.** `resolveMunicipioIbge(uf, municipio)` (`src/services/fiscal/resolveMunicipioIbge.ts:49`) resolve por UF+nome do município via cache (`ibge_municipios`) + API pública do IBGE, nunca lista hardcoded, nunca lança (retorna `null` em qualquer falha). É chamada obrigatoriamente em `buildNfePayload.ts:189` — sem o código resolvido, a montagem do payload falha (`FiscalBuildError`), por decisão deliberada da Fase 2B (nunca emitir sem IBGE confiável).
- **O problema real é a origem do UF+município que alimenta essa função** — hoje vem de `customer_addresses.state`/`customer_addresses.city`, que, como visto no §6, nunca são preenchidos por nenhum fluxo.
- **Achado novo desta auditoria — já existe uma fonte de IBGE "de graça" no sistema, e ela é descartada.** O serviço de CEP (`src/lib/services/cepService.ts:10,17`, exposto por `src/app/api/shipping/cep/route.ts`) consulta o ViaCEP, cuja resposta **inclui o campo `ibge`** — mas a rota **remove esse campo explicitamente** antes de devolver (`route.ts:30-39,66-75` só repassam `cep, street, neighborhood, city, state, complement, latitude, longitude`). Esse endpoint hoje só é usado pelas telas de configuração de frete (zona/origem), nunca por um fluxo de cliente/venda.

**Conclusão prática**: o vendedor nunca deveria digitar o código IBGE manualmente, e a arquitetura para isso **já existe em duas camadas independentes e complementares** — só falta ligá-las ao fluxo de venda (ver proposta em §13):
1. Consulta de CEP (ViaCEP, já integrado) devolvendo `ibge` diretamente — resolve ~100% dos casos com CEP válido, sem chamada extra.
2. `resolveMunicipioIbge` (já existe) como respaldo por UF+nome do município, para os poucos casos sem CEP ou com CEP não encontrado.

---

## 8. Modelo atual de preços por item

`sale_items.unit_price` é gravado **verbatim do payload de entrada** (`rpc_create_sale`, `20260817_sale_rpcs_emit_outbox_events.sql:157,281-285`) — **sem nenhuma comparação com o preço de catálogo** (`products.base_price`/`product_variations.price_override`). Confirmado por grep exaustivo: nenhum arquivo em `src/` lê `base_price`/`price_override` no caminho de criação de venda ou de montagem do payload fiscal.

O único cross-check existente é `checkSalePrices()` (`src/services/vendas.service.ts:255-265`), que compara `unit_price` contra `unit_cost` (guarda de margem), nunca contra o preço de tabela.

**Portanto**: o vendedor já pode, hoje, lançar o preço negociado diretamente como `unit_price` do item (ex.: Produto A a R$45 em vez de R$50) — tecnicamente isso já funciona e reflete corretamente no item da venda e no payload fiscal (`valor_unitario_comercial`/`valor_bruto` vêm de `sale_items.unit_price` sem alteração, `buildNfePayload.ts:60-61`). **O que não existe é rastro do preço de catálogo original** — uma vez lançado R$45, o sistema não guarda em lugar nenhum que o preço de tabela era R$50. Isso não impede a NF-e (que deve refletir o preço real vendido, exatamente como pedido na seção 6 do pedido original), mas impede qualquer relatório futuro de "quanto desconto foi dado por produto" sem reconstruir a partir do cadastro de produto na época (que também muda).

`sale_items.discount_amount` existe e é somado ao `unit_price*quantity` para formar `total_price` — mas **nenhuma tela de venda hoje expõe um campo de desconto por item** (`grep discount` em `vendas/nova/page.tsx` inteiro: só o campo de desconto de nível de pedido é editável). Ou seja, o schema já suporta desconto por item, mas nenhuma UI usa isso — na prática, hoje, `sale_items.discount_amount` é sempre `0` em qualquer venda criada pelo PDV ou pelo Nuvemshop.

---

## 9. Modelo atual de desconto/acréscimo global

`sales.discount_amount` e `sales.surcharge_amount` são parâmetros **independentes**, passados pelo chamador — **não são derivados/somados a partir de `sale_items`**:

```sql
-- 20260817_sale_rpcs_emit_outbox_events.sql:168,174
v_subtotal := v_subtotal + ROUND(v_unit_price * v_qty - v_discount, 2)   -- já líquido do desconto por item
v_gross    := ROUND(v_subtotal - COALESCE(p_discount_amount,0) + v_surcharge + COALESCE(p_shipping_charged,0), 2)
```

`sales.subtotal` já é a soma dos itens **líquida** de `sale_items.discount_amount`. `sales.discount_amount`/`sales.surcharge_amount` se somam a isso **por cima**, como um segundo ajuste, comercialmente independente. Isso é consistente e sem sobreposição **na camada comercial** (ver risco na fiscal, §10).

`sales.discount_pct` existe (`DATABASE_SCHEMA.sql:388`) mas é só informativo, não usado em cálculo.

---

## 10. Risco de dupla contabilização

**Na camada comercial (`rpc_create_sale`): não há dupla contagem hoje, por desenho matemático** — `subtotal` (líquido de desconto por item) menos `discount_amount` (global) é uma soma, não uma sobreposição, contanto que os dois valores representem coisas diferentes. O RPC **não tem nenhuma trava** contra um chamador que, por engano, mande o mesmo desconto duas vezes (ex.: `discount_amount` de item = R$5 E `p_discount_amount` = R$5 pretendendo ser "o mesmo" desconto) — mas isso não acontece hoje porque **nenhum caller vivo usa desconto por item**: tanto o PDV (`vendas/nova/page.tsx`) quanto o webhook Nuvemshop (`route.ts:474`) sempre mandam `discount_amount: 0` por item.

**Na camada fiscal (`allocateOrderAdjustments`): mesmo padrão, sem duplicidade, mas por um motivo específico que vale documentar.** `buildItemPayload` grava `item.valor_desconto = sale_items.discount_amount` (hoje sempre 0 na prática). Depois, `applyOrderLevelAdjustments` **soma** `sales.discount_amount` (rateado) ao `valor_desconto` que o item já tinha — nunca substitui (`allocateOrderAdjustments.ts:134-135,162-169`). Como os dois valores de origem (`sale_items.discount_amount` e `sales.discount_amount`) já são independentes desde a criação da venda (§9), somá-los de novo no payload fiscal está correto — reflete exatamente o mesmo total que `sales.total` já expressa.

**Risco real, não hipotético**: se uma fase futura passar a expor desconto por item na UI (exatamente o que a seção 5/6 do pedido pede), alguém pode, sem querer, também preencher `sales.discount_amount` com o mesmo valor que já está distribuído nos itens (ex.: um totalizador de "desconto total" no formulário que soma os itens automaticamente e o vendedor manda de novo como desconto de pedido). **Nem o RPC nem o builder fiscal têm proteção contra isso hoje** — nenhum dos dois verifica se os valores se sobrepõem semanticamente, só que a soma não excede o valor dos itens (`allocateOrderAdjustments.ts:156-160`, que impede item negativo, não impede duplicidade). Isso é uma recomendação de UX para a Fase D (§14): quando desconto por item existir na UI, o desconto de pedido deveria virar **somente leitura** (calculado, nunca digitável em paralelo) ou o formulário precisa deixar claríssimo que os dois são fontes diferentes.

Mesma lógica vale para acréscimo (`surcharge_amount`), sem achado adicional.

---

## 11. Tratamento atual do frete no comercial/financeiro/fiscal

### Comercial

`sales.shipping_charged` é somado dentro de `sales.total` (`v_gross := v_subtotal - discount + surcharge + shipping_charged`, `20260817_sale_rpcs_emit_outbox_events.sql:174`) — **não existe, hoje, nenhuma grandeza separada de "valor de mercadoria" dentro de `sales`** além do já problemático `products_total` (ver abaixo). `sales.subtotal` inclui desconto de item mas não separa frete/acréscimo.

### `client_shipping_price` (perguntado explicitamente) — não existe no schema vivo

`grep -r "client_shipping_price"` só aparece no dump desatualizado (`DATABASE_SCHEMA.sql:1295`) e num tipo TS que o espelha (`src/types/shipping.types.ts:96`) — **nenhum código lê ou escreve essa coluna**. O preço cobrado do cliente por um frete específico, quando existe uma regra de frete aplicada, é lido via fallback `shipment.client_price ?? shipment.shipping_rules?.client_price` (`src/app/(dashboard)/envios/page.tsx:378`) — ou seja, vem da **tabela de regras** (`shipping_rules`, preço de tabela por zona), não de um valor gravado por venda. **O valor realmente cobrado e faturado na venda é só `sales.shipping_charged`.**

### `sale_shipping` — órfã (ver §1)

Existe uma tabela desenhada exatamente para "controle de custo real de frete" (comentário do dump: "frete separado para controle de custo real") mas **nenhum código a usa**. Único consumidor é a view `vw_sale_shipping_summary`, que por sua vez **também não é consultada por nenhum código em `src/`** (confirmado em `docs/products-total-regression-analysis.md:16,77-80`).

### `finance_entries` — receita e despesa de frete misturadas

- **Receita**: uma única linha `type='income', category='sale', amount=v_total` por venda (`20260817_sale_rpcs_emit_outbox_events.sql:394-399`) — `v_total` já inclui `shipping_charged`. **Não existe categoria de receita de frete separada** — frete cobrado do cliente está sempre misturado dentro de `category='sale'` junto com a mercadoria.
- **Despesa**: existia um gatilho automático (`trg_auto_freight_expense`, criado em `20260606_auto_freight_expense.sql`, assumindo repasse 100% ao motoboy no momento da venda) — **removido** em `20260613_shipping_fiscal_ready.sql:44-45`, com justificativa explícita no próprio arquivo de que o modelo mudou para registro manual só quando o repasse é efetivamente pago. Hoje, a única forma de despesa de frete é via `rpc_pagar_repasse_motoboy` (`20260613_rpc_pagar_repasse.sql:123-138`), que insere `finance_entries(type='expense', category='freight_cost', amount=COALESCE(internal_cost_real, repasse_amount, internal_cost))` **só quando o admin marca o repasse como pago** na tela `/envios/repasses`. Isso é lançado contra o mesmo `sale_id`/`reference_date` do dia do pagamento, não do dia da venda.

### `cash_movements`

**Zero tratamento de frete** — nenhuma coluna, categoria ou lógica relacionada (grep exaustivo em 11 migrations que tocam a tabela, zero hits). Um pagamento de repasse em dinheiro só apareceria como `type='expense'` genérico, sem campo dedicado.

### Dashboard/relatórios — inconsistência real confirmada

| Relatório | Inclui frete na "receita/faturamento"? | Evidência |
|---|---|---|
| Dashboard, card "Faturamento" | **Sim** (`sale.total`) | `src/app/(dashboard)/dashboard/page.tsx:331` |
| `vw_daily_revenue_trend` (gráfico + ticket médio) | **Sim** (`SUM(s.total)`) | `supabase/migrations/20260810_vw_daily_revenue_trend.sql:101,111-116` |
| `/relatorios/vendas` (totalRevenue) | **Sim** (`s.total`) | `src/app/(dashboard)/relatorios/vendas/page.tsx:42` |
| `customer_metrics.avg_ticket` (trigger) | **Sim** (`NEW.total`) | `000_schema_completo.sql:1630-1646` |
| `vw_dre_mensal` (DRE contábil) | **Não** (`s.subtotal`, exclui frete) | `20260724_vw_dre_mensal_v3_revenue_reversal.sql:39,60` |

**Achado crítico para o pedido original (seção 11)**: hoje existe uma divergência real e não documentada entre "quanto vendemos" no Dashboard/relatório de vendas/ticket médio (que inclui frete) e "quanto faturamos" no DRE (que exclui frete). Nenhuma dessas duas leituras está "errada" por si só — mas coexistem sem nenhuma nota explicando a diferença, o que é exatamente o risco que a seção 11 do pedido queria mapear. **Decisão necessária (D5)**.

### `products_total` — achado herdado, ainda não corrigido

Confirmado nesta rodada, de novo, por leitura direta do RPC vigente: `products_total` **não está** na lista de colunas do `INSERT INTO sales` de `20260817_sale_rpcs_emit_outbox_events.sql:242-256`, e não existe `v_products_total` em nenhum lugar do arquivo. É a mesma regressão já documentada na Fase 3 (`docs/products-total-regression-analysis.md`) — `NULL` para toda venda desde 14/06/2026, sem impacto direto hoje porque o único consumidor (`vw_sale_shipping_summary`) também não é usado por ninguém. **Decisão D4** — não bloqueia esta fase, mas é a coluna que originalmente seria exatamente "mercadoria sem frete" (comentário da própria coluna: *"Valor líquido dos produtos (subtotal - discount_amount), sem frete/surcharge. Mapeamento NF-e: vProd - vDesc"*), então vale corrigir/decidir junto com a arquitetura de frete desta fase, não isoladamente.

---

## 12. Regra fiscal real do frete × regra operacional desejada

**Entendimento geral (a confirmar com a contabilidade — não é uma citação de código do ERP, é legislação)**: quando o **próprio emitente** cobra do cliente pelo frete — ainda que depois repasse esse valor a um motoboy/transportadora terceirizada — esse valor é, para efeito de ICMS/NF-e, parte do valor da operação de saída da mercadoria (LC 87/96, art. 13, §1º, II, "b"). Nesse cenário (que é exatamente o da Santtorini: a loja cobra `shipping_charged` do cliente e depois paga o motoboy via repasse), o frete **não pode simplesmente ser excluído do documento fiscal** — ele precisa aparecer como componente do valor total da NF-e (`vFrete`), ainda que separado do valor de mercadoria (`vProd`).

Isso está alinhado com a "modalidade de frete" (`modFrete`) que o próprio ERP já usa: **0 = CIF (emitente paga/organiza)** é justamente o cenário em que o frete integra o valor da nota. Achado desta auditoria: **`shipments.mod_frete` tem `DEFAULT 0`** (`20260613_shipping_fiscal_ready.sql:86`, comentário: *"padrão: loja paga motoboy"*) e nenhum código sobrescreve esse valor — ou seja, mesmo sem nenhuma tela definir isso explicitamente, toda venda de entrega hoje já herda `modFrete=0` (CIF) por padrão do banco, que é **coerente com a realidade operacional real** (a loja cobra o cliente e organiza a entrega). Para retirada (sem `shipments`), o loader usa `9` (sem frete) — também correto.

**Conclusão para a intenção operacional descrita no pedido (Produtos R$88 + Frete R$12 = Total R$100):**

- ✅ **Correto e já suportado**: separar comercialmente `mercadoria` de `frete` — isso já existe (`sales.shipping_charged` é uma coluna própria, nunca misturada com `sale_items`).
- ✅ **Correto e já suportado**: o frete **entra** no valor total da NF-e como componente próprio (`valor_frete` por item, via rateio — ver §14) — não pode ser "escondido" do documento fiscal, e o sistema já não o esconde.
- ⚠️ **Nuance a decidir (D3)**: o pedido descreve o cenário como "Produtos considerados na NF-e: R$88 (80 de produto + 8 de acréscimo)". Isso só bate exatamente com R$88 de `vProd` se o acréscimo comercial estiver **embutido no preço do item** (`sale_items.unit_price` já reajustado) — nesse caso, `valor_bruto` do item já reflete R$88 automaticamente, sem precisar de nenhum campo especial. Se, em vez disso, o acréscimo vier como `sales.surcharge_amount` (campo de nível de pedido, sem origem por item conhecida), a arquitetura atual o rateia para `valor_outras_despesas` (vOutro) — um campo distinto de `vProd` no schema da NF-e, mas que **também soma ao valor total do documento** (`vNF = vProd - vDesc + vFrete + vOutro + ...`). Ou seja: o total bate (R$100) nos dois casos, mas **onde exatamente o R$8 aparece dentro da NF-e** (dentro de vProd do item, ou como vOutro à parte) depende de qual dos dois caminhos foi usado para registrar o acréscimo. Isso não é uma escolha livre do ERP — é uma escolha correta em ambos os casos do ponto de vista fiscal (os dois campos existem no leiaute exatamente para esses dois cenários diferentes: preço negociado vs. despesa acessória), mas precisa ser **uma decisão consciente de UX** (seção 6 do pedido: "ajustes conhecidos por item ficam no item"): se o acréscimo é conhecido por produto (negociação item a item), ele deveria entrar como preço do item, não como `surcharge_amount` global.

**Recomendação**: manter `shipping_charged` sempre como campo de pedido (frete não é "por item" na prática comercial da Santtorini), mas migrar o uso de `surcharge_amount` para ser **apenas o fallback residual** de um acréscimo verdadeiramente sem origem por item — coerente com a hierarquia que já existe em `allocateOrderAdjustments` e com o que a seção 6 do pedido original já pede.

---

## 13. Arquitetura proposta — endereço/snapshot do destinatário

**Problema**: hoje, mesmo que `customer_addresses` fosse usada, ela representa o cadastro **atual** do cliente — se o cliente mudar de endereço depois, o histórico da venda antiga passaria a "apontar" para o novo endereço achado através do FK, o que é exatamente o risco descrito na seção 2 do pedido.

**Proposta (não implementar ainda — decisão D1)**: uma tabela de **snapshot imutável do destinatário**, preenchida no momento da criação da venda (ou da confirmação do endereço, para o caso de entrega), nunca alterada depois:

```sql
-- Ilustrativo — nomes/tipos a confirmar na fase de implementação
CREATE TABLE sale_recipients (
  id               SERIAL PRIMARY KEY,
  sale_id          INT NOT NULL UNIQUE REFERENCES sales(id),
  company_id       INT NOT NULL,
  source_address_id INT REFERENCES customer_addresses(id),  -- rastreabilidade, não fonte de verdade
  nome             TEXT NOT NULL,
  cpf              TEXT,
  cnpj             TEXT,
  telefone         TEXT,
  cep              TEXT NOT NULL,
  logradouro       TEXT NOT NULL,
  numero           TEXT NOT NULL,
  complemento      TEXT,
  bairro           TEXT NOT NULL,
  municipio        TEXT NOT NULL,
  municipio_ibge   CHAR(7),   -- resolvido no momento da venda, nunca depois
  uf               CHAR(2) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Justificativa de desenho:
- **Tabela nova, não colunas em `shipments`** — porque uma venda de retirada não deveria ganhar colunas de endereço só para ficarem sempre `NULL`, e porque uma venda pode existir sem `shipments` (Nuvemshop hoje) mas ainda assim precisar de destinatário para NF-e.
- `source_address_id` é só rastreabilidade ("de onde veio esse dado quando foi capturado"), nunca lido de volta para montar o payload fiscal — o payload sempre lê `sale_recipients`, nunca `customer_addresses` diretamente. Isso resolve estruturalmente a pergunta da seção 2 do pedido.
- `municipio_ibge` é resolvido e gravado **uma vez**, no momento da venda — não recalculado a cada emissão. Isso também dá previsibilidade: se a API do IBGE cair no meio de uma tentativa de emissão (meses depois), a venda antiga já tem o código congelado.

**Resolução automática do IBGE (D2)** — cascata proposta, reaproveitando o que já existe:
1. Se o vendedor digitar o CEP, chamar o serviço de CEP já existente (`cepService.ts`) e **parar de descartar o campo `ibge` da resposta do ViaCEP** — resolve o caso comum sem nenhuma chamada extra.
2. Se não houver CEP ou o ViaCEP não retornar `ibge`, cair para `resolveMunicipioIbge(uf, municipio)` (já existe, cache + API pública do IBGE) — mesmo mecanismo já usado na emissão hoje.
3. Se nenhum dos dois resolver, o campo fica pendente e a venda simplesmente não passa em `validateNfeReadiness` até ser corrigido — nunca inventar/aproximar um código.

Isso elimina completamente a necessidade de o vendedor digitar o código IBGE manualmente, usando só infraestrutura que já existe no repositório hoje (nenhuma dependência nova).

---

## 14. Arquitetura proposta — preço negociado por item

**O schema já suporta o que a seção 5/6 do pedido pede** — não precisa de coluna nova:

- `sale_items.unit_price` já pode ser o preço efetivamente negociado (R$45 em vez de R$50) — isso já flui corretamente para o payload fiscal hoje (`valor_unitario_comercial`/`valor_bruto`).
- `sale_items.discount_amount` já existe para o caso em que se prefere manter `unit_price` = preço de tabela e registrar a diferença como desconto explícito por item.

**O que falta é só UX** (não schema): expor esses dois campos por item na tela de criação/edição da venda, para que o vendedor consiga digitar o preço negociado (ou o desconto) produto a produto, em vez de só um desconto/acréscimo de pedido inteiro.

**Hierarquia proposta (D9), formalizando o que `allocateOrderAdjustments` já faz na prática:**
1. Ajuste conhecido por produto → grava direto em `sale_items.unit_price`/`sale_items.discount_amount`. Vira `valor_bruto`/`valor_desconto` do item na NF-e, sem nenhum rateio.
2. Ajuste sem origem por item, genuinamente do pedido inteiro (ex.: um cupom de frete grátis, uma negociação de "R$5 a menos no total" sem dizer em qual produto) → continua em `sales.discount_amount`/`sales.surcharge_amount`, e o rateio proporcional (`allocateOrderAdjustments`) continua sendo o fallback — exatamente como já está implementado hoje, comprovado matematicamente exato (soma de centavos sem sobra, nunca item negativo).

**Nenhuma mudança é necessária em `allocateOrderAdjustments.ts` para isso** — ele já assume corretamente essa hierarquia (soma ao que o item já tinha, nunca substitui). O que muda é só o comportamento esperado da UI: hoje ela nunca alimenta desconto por item, então o rateio sempre carrega 100% do ajuste; com a UX nova, o rateio passaria a carregar só o resíduo real.

**Preço de catálogo (achado do §8)** — se o objetivo for também auditar "quanto desconto foi dado" por produto ao longo do tempo, seria necessário adicionar um snapshot do preço de catálogo no momento da venda (`sale_items.catalog_price_at_sale`, por exemplo) — isso **não é necessário para a NF-e** (que só precisa do preço vendido, já correto), é uma decisão separada de relatório gerencial, fora do escopo fiscal desta fase. Mencionado aqui só para não ser esquecido.

---

## 15. Arquitetura proposta — frete

Manter a separação já existente (`sales.shipping_charged` comercial/financeiro, `shipments.mod_frete` + rateio em `valor_frete` fiscal) — está correta e não precisa mudar estruturalmente. Propostas de fechamento de lacunas (D6):

1. **Receita de frete**: se o objetivo do pedido (seção 4) é distinguir "quanto veio de mercadoria vs. quanto veio de frete" no financeiro, a opção mais simples (sem tabela nova) é o próprio `rpc_create_sale` gravar **duas linhas** em `finance_entries` em vez de uma quando `shipping_charged > 0`: uma `category='sale'` com o valor de mercadoria, outra com uma categoria nova `category='shipping_revenue'` (adicionar ao enum `finance_category`) com o valor do frete. Isso resolve D5 e D6 ao mesmo tempo, sem precisar reativar `sale_shipping` (que pode continuar órfã/ser removida).
2. **Custo/repasse de frete**: já funciona (`rpc_pagar_repasse_motoboy`), não precisa mudar.
3. **`products_total`**: já que a coluna nasceu com exatamente essa semântica ("mercadoria sem frete/surcharge"), a correção dela (D4) pode ser feita na mesma fase que ajustar a receita de frete — mas são decisões independentes, não uma depende da outra.
4. **`sale_shipping`**: recomendo decisão explícita de **descartar** essa tabela (documentar como legado, não reativar) em vez de tentar aproveitá-la — ela duplicaria dado que já existe em `sales.shipping_charged`/`shipments`, sem nenhum código vivo esperando por ela.

---

## 16. Impacto em relatórios/financeiro

| Área | Impacto se as mudanças acima forem implementadas |
|---|---|
| Dashboard "Faturamento" | Se continuar somando `sales.total`, nenhuma mudança de comportamento — as mudanças propostas não alteram `sales.total`. |
| Ticket médio / `vw_daily_revenue_trend` | Idem — nenhuma mudança de fórmula necessária, a menos que D5 decida excluir frete daqui também (mudança de escopo, não desta auditoria). |
| DRE (`vw_dre_mensal`) | Já exclui frete (usa `subtotal`) — nenhuma mudança necessária, a menos que a nova linha de receita de frete (proposta §15) precise de tratamento próprio na DRE (provavelmente sim, como receita não-operacional ou linha própria — decisão contábil). |
| Margem/comissão | Não auditado nesta rodada (fora do escopo dos 5 agentes desta fase) — recomendo checagem específica antes de mexer em `finance_entries`, já que comissão de vendedor provavelmente usa `sales.total`/`subtotal` em algum RPC não coberto aqui. |
| Caixa (`cash_movements`) | Nenhuma mudança proposta toca `cash_movements` diretamente. |
| Estoque | Nenhuma das mudanças propostas nesta fase toca estoque — confirmado que `rpc_create_sale`/`shipments` não têm nenhuma interação com `stock_*` relacionada a endereço/preço/frete. |
| Repasse de frete | Nenhuma mudança proposta — `rpc_pagar_repasse_motoboy` continua igual. |

---

## 17. Alterações de banco necessárias (proposta — não aplicar agora)

- `sale_recipients` — tabela nova (snapshot de destinatário/endereço, §13).
- `finance_category` — adicionar valor `'shipping_revenue'` ao enum (§15), se D6 for aprovada nesse formato.
- Nenhuma mudança em `sale_items`/`sales`/`shipments` é estruturalmente necessária — os campos que a arquitetura de preço/frete precisa já existem (§14, §15).
- `products_total` — decisão isolada (D4): backfill (`subtotal - discount_amount`, já confirmado como fórmula válida na Fase 3) + retomar o `INSERT` no RPC, ou `DROP COLUMN` formal.
- `sale_shipping` — decisão isolada (D6): `DROP TABLE` formal (documentando o porquê) ou manter como está (não recomendado deixar "zumbi").

---

## 18. Alterações de código necessárias (mapa de arquivos, proposta)

| Módulo | Arquivo(s) | Mudança proposta |
|---|---|---|
| Formulário de entrega | `src/app/(dashboard)/vendas/nova/page.tsx` | Novo bloco de campos (nome/CPF-CNPJ/telefone/CEP/logradouro/número/complemento/bairro/município/UF), visível só quando `delivery_mode='delivery'` |
| Resolução de CEP→IBGE | `src/app/api/shipping/cep/route.ts`, `src/lib/services/cepService.ts` | Parar de descartar o campo `ibge` da resposta do ViaCEP; reaproveitar em um novo endpoint de cliente/venda (o atual é só de configuração de frete) |
| Persistência do snapshot | Nova rota/serviço, `src/app/api/vendas/route.ts` | Gravar `sale_recipients` no mesmo fluxo transacional da criação da venda (idealmente dentro do próprio `rpc_create_sale`, para atomicidade — hoje `shipments` já sofre do problema de ser não-atômico, não repetir o erro) |
| Leitura do destinatário fiscal | `src/services/fiscal/loadSaleFiscalContext.ts` | Trocar a fonte de `customer_addresses`/`shipments.address_id` para `sale_recipients` |
| Preço por item na UI | `src/app/(dashboard)/vendas/nova/page.tsx` | Expor `unit_price`/`discount_amount` editáveis por item |
| Nuvemshop — endereço | `src/app/api/webhooks/nuvemshop/order/route.ts` | Ler endereço de entrega do payload da Nuvemshop (campo ainda a confirmar na API deles — não pesquisado nesta rodada), gravar em `sale_recipients`, criar `shipments` com `delivery_mode` correto (D7 decide se síncrono no webhook ou lazy) |
| Receita de frete | `20260817_sale_rpcs_emit_outbox_events.sql` (nova migration que redefine `rpc_create_sale`) | Duas linhas em `finance_entries` em vez de uma, se D6/D15 aprovadas |
| `products_total` | Mesma migration acima | Retomar o `INSERT`, se D4 decidir manter a coluna |

---

## 19. Fases pequenas e reversíveis de implementação

Nenhuma fase abaixo deve começar sem a decisão de negócio correspondente já confirmada.

- **Fase A — Snapshot de destinatário (schema + resolução de IBGE).** `sale_recipients` (D1), cascata CEP→IBGE (D2). Sem UI ainda — só schema + serviço de resolução, testável isoladamente.
- **Fase B — Formulário de entrega.** UI de captura de endereço/destinatário na criação de venda, escrevendo em `sale_recipients` via a Fase A. Sem mudança de `resolveFiscalDocumentType`/emissão.
- **Fase C — Frete e relatórios.** Nova categoria de receita de frete (D6), decisão sobre `products_total` (D4) e sobre a divergência DRE×Dashboard (D5). Migration aditiva em `rpc_create_sale`.
- **Fase D — Preço/desconto por item na UI.** Expor `unit_price`/`discount_amount` por item no formulário de venda; ajustar o formulário para deixar claro que desconto de pedido é só residual quando desconto por item já foi usado (D9, mitigação do risco do §10).
- **Fase E — Nuvemshop.** Capturar endereço do payload da Nuvemshop, criar `shipments`/`sale_recipients` no webhook (D7). Depende da Fase A já estar pronta.
- **Fase F — `loadSaleFiscalContext` migra para `sale_recipients`.** Troca a fonte de leitura do destinatário fiscal, mantendo `validateFiscalReadiness`/`buildNfePayload` sem alteração de contrato (só a origem do dado muda). Última fase, só depois de A-E estarem em produção e populando `sale_recipients` de verdade.

Nenhuma fase acima toca `resolveFiscalDocumentType`, claim/lease/begin/complete, reconciliação, ou qualquer coisa da NFC-e homologada.

---

## 20. Plano de testes

- **`sale_recipients` (Fase A)**: teste unitário da cascata CEP→IBGE (CEP válido resolve direto; CEP inválido cai para `resolveMunicipioIbge`; nenhum dos dois resolve → pendência, nunca erro inventado). Teste de que uma venda antiga nunca muda de valor quando o cadastro do cliente muda depois (o cerne da pergunta da seção 2 do pedido) — criar venda, alterar `customer_addresses`, reconsultar `sale_recipients` da venda antiga e confirmar que não mudou.
- **Formulário de entrega (Fase B)**: teste E2E (Playwright/manual) — venda de entrega não pode ser salva sem os campos obrigatórios; venda de retirada continua sem exigir nenhum deles.
- **Frete/relatórios (Fase C)**: teste de que a soma das duas linhas novas de `finance_entries` (mercadoria + frete) sempre bate com `sales.total`; teste de regressão do Dashboard/DRE confirmando que os números não quebram para vendas já existentes (frete somado onde já era, sem duplicar).
- **Preço por item (Fase D)**: teste de que o total da venda com descontos mistos (alguns itens com desconto próprio, mais um desconto residual de pedido) bate exatamente com a soma esperada, sem duplicidade — cenário explícito do risco do §10.
- **`buildNfePayload`/`allocateOrderAdjustments`**: já tem suíte própria (48 testes, conforme commit `e15481c`) — qualquer mudança na Fase D deve rodar essa suíte sem quebrar nada, já que a hierarquia item-primeiro já está correta lá.
- **Nuvemshop (Fase E)**: teste de que um pedido de teste da Nuvemshop com endereço completo chega pronto para NF-e (passa em `validateNfeReadiness` sem erros de destinatário), e que um pedido sem endereço completo (ex.: retirada configurada do lado da loja Nuvemshop, se existir esse conceito lá) não gera falso-bloqueio.
- **Regressão geral**: rodar a suíte fiscal completa (ver `fiscal-fase3-auditoria-completa.md §12`) antes de cada fase entrar em produção — nenhuma das fases acima deveria alterar o resultado de nenhum teste hoje verde.

---

**Nada foi implementado. Aguardando sua aprovação — por fase, conforme pedido — antes de qualquer código ou migration.**
