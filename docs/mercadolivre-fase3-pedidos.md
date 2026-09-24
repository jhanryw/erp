# Mercado Livre — Fase 3: pedidos → venda → estoque → financeiro

Status: **implementado e testado localmente** (vitest, SQL, concorrência real).
A compra real TEST buyer → TEST seller (roteiro na seção 11) **ainda precisa
ser executada** depois do deploy e das migrations. Nada foi aplicado em
produção e nenhuma compra foi feita por mim.

Continua valendo: só TEST seller / TEST buyer / anúncios TEST;
`CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS` desligado.

---

## 1. Auditoria (como a Nuvemshop funciona hoje) e o que NÃO foi copiado

Nuvemshop (`src/app/api/webhooks/nuvemshop/order/route.ts`) faz tudo dentro
da requisição HTTP: busca o pedido, staging em `pedidos` (single-tenant via
env), lock `processing_lock`, `rpc_create_sale(sale_origin='website',
sales_channel='nuvemshop', online_priority)`, pagamento com `fee_amount=0`,
push de estoque para a Nuvemshop, política fiscal `website`, e só no fim grava
`pedidos.sale_id`.

| Problema na Nuvemshop | Solução na Fase 3 |
|---|---|
| venda e `sale_id` em transações diferentes → queda no meio + liberação de lock = **venda/baixa duplicada** | `rpc_import_channel_order`: venda e `channel_orders.sale_id` na MESMA transação |
| itens sem mapeamento descartados em silêncio (venda parcial) | qualquer item sem vínculo → `needs_attention`, nenhuma venda |
| processamento síncrono no webhook | webhook só persiste (`inbound_events`) e responde 200; worker processa |
| taxas zeradas; DRE ignora `fee_amount` | `marketplace_fee` real no financeiro + linha na DRE |
| cashback creditado a comprador de marketplace | `rpc_create_sale(p_earn_cashback => false)` só no importador |
| frete do comprador somado à receita | `shipping_charged = 0`; frete do comprador só informativo |
| push de estoque no importador | fan-out genérico `stock.changed` (seção 8) |

Reaproveitado (arquiteturalmente correto): `rpc_create_sale` (itens, baixa
online com prioridade de locais, kits via `_consume_kit_components` +
`sale_item_components`, `finance_entries` de receita, outbox
`sale.completed`), `rpc_cancel_sale` (estoque/kits/cashback), padrão de claim
`SKIP LOCKED` das deliveries, `external_entity_links` para o comprador.

## 2. Auditoria documental — de onde vem cada valor financeiro

Docs oficiais consultadas em 24/09/2026: *Orders* (gerenciamento-de-vendas),
*Envios* (gerenciamento-de-envios → Costs), *Provisões* (billing),
*Notificações*.

| Valor | Endpoint → campo | Observação |
|---|---|---|
| Valor bruto (faturamento) | `GET /orders/{id}` → Σ `order_items[].unit_price × quantity` | `unit_price` já com desconto; `gross_price`/`discounts` só informativos |
| Tarifa de venda | `GET /orders/{id}` → `payments[].marketplace_fee` (total do pagamento); na ausência, Σ `order_items[].sale_fee × quantity` | `sale_fee` é por unidade; comissão calculada na aprovação do pagamento |
| Frete a cargo do vendedor | `GET /shipments/{id}/costs` (header `x-format-new: true`) → `senders[user_id = seller].cost` | custo final após descontos |
| Frete do comprador | `GET /shipments/{id}/costs` → `receiver.cost` | informativo; não é receita do vendedor no ME2 |
| Impostos | `GET /orders/{id}` → `taxes.amount` | |
| Liberação prevista | `GET /billing/integration/group/ML/order/details?order_ids=` → `payment_info[].money_release_date` | só existe depois do faturamento; antes fica `null` |
| Detalhe da tarifa (bruta/rebate/desconto) | mesmo endpoint → `sale_fee {gross, net, rebate, discount}` | guardado em `financial_sources.billing_sale_fee` (conciliação futura) |
| Pagamento | `GET /orders/{id}` → `payments[]` (`id`, `status`, `payment_type`, `payment_method_id`, `installments`, `transaction_amount`, `total_paid_amount`, `date_approved`, `currency_id`) | id externo + método original em `sale_payments.metadata` |
| Taxa de parcelamento | billing `financing_fee` | é do comprador — não é custo do vendedor |

**Nada é estimado.** Valor ausente fica `null`; `channel_orders.financial_sources`
registra de qual endpoint/campo veio cada número.

Exemplo (testado): venda R$ 50,00; tarifa R$ 8,50; frete vendedor R$ 3,00 →
`sales.total = 50,00`, `finance_entries`: receita 50,00 (`sale`), despesa 8,50
(`marketplace_fee`), despesa 3,00 (`freight_cost`); `channel_orders.net_amount = 38,50`.

## 3. Migrations (aplicar nesta ordem, manualmente, depois das Fases 1–2)

0. `supabase/migrations/202609260900_channel_listings_multi_offer.sql` — N ofertas por variação (ver doc da Fase 2, seção 15).
1. `supabase/migrations/202609261000_marketplace_enums.sql` — **commitar/rodar sozinha antes**:
   `finance_category.marketplace_fee`, `payment_method.digital_wallet`, `payment_method.boleto`.
2. `supabase/migrations/202609261100_channel_orders_foundation.sql`:
   - `sales_sales_channel_valid` aceita `mercadolivre`;
   - `sale_payments.external_payment_id` + `metadata` (índice único por empresa/adquirente);
   - `inbound_events` + `rpc_enqueue_inbound_event` / `rpc_claim_inbound_events` / `rpc_finish_inbound_event`;
   - `channel_orders` + `channel_order_items` (+ triggers multi-tenant);
   - `rpc_upsert_channel_order`, `rpc_set_channel_order_state`;
   - `rpc_create_sale` recriado com `p_earn_cashback boolean DEFAULT true` (corpo idêntico; continua 1 único overload);
   - `rpc_import_channel_order`, `rpc_sync_channel_order_costs`, `rpc_cancel_channel_order`;
   - `vw_dre_mensal`: `tarifas_marketplace` (nova, no fim, dentro de `total_opex`) e frete líquido de estornos;
   - `channel_listings.stock_sync_pending` + `rpc_process_stock_availability_changes` marcando anúncios e devolvendo `changed_variation_ids`.
   Tudo idempotente (aplicada 2× no harness sem erro). RLS deny-by-default, EXECUTE só `service_role`.

## 4. Fluxo

```
ML → POST /api/webhooks/mercadolivre  (público, < 500 ms)
       valida formato + application_id → rpc_enqueue_inbound_event
       (empresa/integração pelo user_id no banco; coalesce por recurso) → 200
       └─ dispara ciclo sem await (e o job agendado garante)
worker (runInboundCycle): claim SKIP LOCKED (+ 'processing' preso > 5 min)
   orders_v2 /orders/{id}   → processMercadoLivreOrder
   shipments /shipments/{id} → relê envio → pedido → processMercadoLivreOrder
processMercadoLivreOrder:
   GET /orders/{id} (+ shipment, costs, billing — best effort)
   → normaliza (valores reais) → confere seller = conta conectada
   → mapeia itens por channel_listings → rpc_upsert_channel_order
   → paid: rpc_import_channel_order | não pago: awaiting_payment
     | cancelled/invalid/pending_cancel: rpc_cancel_channel_order
     | fraude/reembolso parcial/desconhecido: needs_attention
   → já importado: rpc_sync_channel_order_costs (só diferença)
falha: backoff 1/5/15/60/180 min (429 respeita retry-after; reauth 1 h); 6ª tentativa ou erro permanente → dead
```

Tópicos a configurar no app (DevCenter): **`orders_v2`** e **`shipments`**
(callback `https://santtorini.qarvon.com/api/webhooks/mercadolivre`).
`payments` não é necessário: mudanças de pagamento chegam por `orders_v2`.

## 5. Estados

| Estado ML (`order.status`) | Ação | `processing_state` |
|---|---|---|
| `paid` | importa | `imported` (ou `needs_attention`) |
| `confirmed`, `payment_required`, `payment_in_process`, `partially_paid` | só snapshot | `awaiting_payment` |
| `cancelled`, `invalid`, `pending_cancel` | cancela venda (se houver) | `cancelled` |
| `partially_refunded` | sem devolução automática | `needs_attention` (`partial_refund`) |
| tag `fraud_risk_detected` | não importa | `needs_attention` (`fraud_risk`) |

`needs_attention` não é terminal: "Reprocessar" (ou nova notificação) tenta de novo.
Códigos: `insufficient_stock`, `unmapped_items`, `payment_mismatch`,
`unsupported_payment`, `no_operator`, `sale_rejected`, `cancel_blocked`,
`fraud_risk`, `partial_refund`.

## 6. Idempotência

- 1 `channel_order` por (empresa, integração, pedido) — índice único.
- `rpc_import_channel_order` trava a linha (`FOR UPDATE`); com `sale_id` → `already_imported`.
- Venda + pagamento + baixa + kits + tarifa/frete + `sale_id` numa transação; regra violada → subtransação desfeita + `needs_attention`.
- Custos posteriores: `fees_posted`/`shipping_posted` → lança só a diferença.
- Cancelamento: estado `cancelled` → `already_cancelled` (sem reversão repetida).
- Pagamento: `sale_payments(company_id, acquirer, external_payment_id)` único.
- Comprador: 1 cliente por buyer (`external_entity_links` + advisory lock).
- Concorrência real testada: PDV × ML pela última unidade; dois imports simultâneos do mesmo pedido.

## 7. Produtos, kits, estoque, cliente, frete, fiscal

- **Mapeamento:** caminho normal `item_id` exato → `channel_listing_id` → `product_variation_id` (legado: + `variation_id`). Fallbacks `user_product_id` e `SELLER_SKU`: 1 anúncio → vincula; N anúncios da MESMA variação → importa pela variação com `channel_listing_id = NULL` e `listing_resolution = 'ambiguous_same_variation'` (aviso em `channel_orders.metadata.listing_resolution_warnings`); variações diferentes → `conflict`. SKU divergente com `item_id` exato = só aviso. Todos os ids externos do item ficam em `channel_order_items`. Nunca por nome/título.
- **Kit:** o vínculo aponta para a variação do KIT; o core baixa componentes e grava `sale_item_components` (com local). Nenhum `if kit` no importador.
- **Estoque:** `p_stock_mode = 'online_priority'` (prioridade de locais). Sem estoque → `needs_attention`, nunca negativo, nunca venda parcial, nunca cancela no ML.
- **Cliente:** por `buyer.id` (sem CPF/e-mail); nome `Comprador Mercado Livre <nickname|id>`; sem comprador → cliente genérico por integração.
- **Frete:** `external_shipment_id`, modo, logística, status/substatus, rastreio e custos em `channel_orders`. A tabela local `shipments` NÃO é usada (semântica de entrega própria).
- **Fiscal:** decisão pendente para Mercado Livre — nenhum documento emitido. Bloqueio no servidor (`loadSaleFiscalContext` → `FISCAL_PENDING_CHANNELS`) e na UI. Política fiscal global intocada.
- **Outbox:** o core emite `sale.completed` com `sales_channel = 'mercadolivre'`; o importador não chama CRM/n8n/fiscal.

## 8. Estoque → canais (`stock.changed`)

A venda só altera estoque. O gatilho existente enfileira `stock_availability_changes`;
`rpc_process_stock_availability_changes` recalcula (kits dependentes incluídos)
e **marca `channel_listings.stock_sync_pending`** na mesma transação.
`runStockChannelFanout` (jobs `stock-availability/run` e `channels/inbound`):
variações alteradas → Nuvemshop (serviço existente); anúncios pendentes →
Mercado Livre (`syncListing` quantityOnly, quantidade ABSOLUTA). Marca limpa
antes do envio e restaurada em falha.

## 9. UI

- **Vendas:** selo "Mercado Livre" e filtro por canal (`/vendas?canal=mercadolivre`).
- **Detalhe da venda:** card do pedido (conta, pedido, pacote, status do canal, envio, rastreio) com **venda bruta / tarifa / frete-custos do vendedor / líquido previsto / liberação prevista**; sem payload técnico; botão de cancelamento manual oculto (cancelamento vem do canal); painel fiscal bloqueado.
- **Pedidos de marketplace** (`/vendas/marketplace`, gerente+): estados, motivo de atenção, valores, link da venda, "Reprocessar".
- **DRE:** linha "Tarifas de marketplace".

## 10. Deploy (você)

1. Aplicar `202609261000_marketplace_enums.sql`; depois `202609261100_channel_orders_foundation.sql`.
2. Deploy do código.
3. DevCenter → app → notificações: callback `https://santtorini.qarvon.com/api/webhooks/mercadolivre`, tópicos `orders_v2` e `shipments`.
4. Agendar (a cada 1 min, `Authorization: Bearer $CRON_SECRET`):
   `POST /api/jobs/channels/inbound` e `POST /api/jobs/stock-availability/run`.
5. Conferir que a integração ML tem `created_by` (usuário operador) — é quem assina vendas/cancelamentos.

## 11. Roteiro TEST buyer → TEST seller (sem conta real)

**A. Produto normal** — TEST buyer compra 1× `TEST-ML-NORMAL-01`.
Conferir: `/vendas/marketplace` (Venda criada) → venda com selo Mercado Livre;
produto e preço corretos; pagamento com método original; card com bruto/tarifa/frete/líquido;
estoque −1; anúncio ML com quantidade atualizada após o job; Nuvemshop idem.

```sql
select processing_state, sale_id, gross_amount, marketplace_fees, shipping_cost_seller, net_amount, financial_sources
from channel_orders where external_order_id = '<ID>';
select sales_channel, total, shipping_charged from sales where id = <SALE>;
select method, net_amount, external_payment_id, metadata->>'provider_payment_type' from sale_payments where sale_id = <SALE>;
select type, category, amount from finance_entries where sale_id = <SALE> order by id;
select count(*) from cashback_transactions where sale_id = <SALE>;   -- 0
```

**B. Duplicidade** — reenviar a mesma notificação 3× (ou "Reprocessar" 3×):
1 `channel_order`, 1 venda, 1 baixa (`stock_movements`), 1 conjunto de `finance_entries`.

**C. Kit** — comprar 1× `TEST-ML-KIT-01`: venda com 1 item (o kit), valor do kit;
`sale_item_components` com TEST-COMP-A −1 e TEST-COMP-B −2 (e o local).

**D. Convergência** — após o job: estoque Qarvon = `available_quantity` do anúncio ML = quantidade na Nuvemshop.

**E. Cancelamento** (opcional em TEST) — cancelar a compra no ML: venda cancelada uma vez,
estoque/componentes devolvidos, estornos `income` de `marketplace_fee`/`freight_cost`; repetir notificação = sem efeito.

## 12. Testes

- SQL `supabase/tests/channel_orders.test.sql` (96 checagens): fila (coalescência, fencing, stale, dead), importação normal/kit, idempotência 3×, custos por diferença, oversale, sem vínculo, pagamento divergente, cliente único, cancelamento repetido, DRE, fan-out de estoque, tenant, cashback preservado no PDV, grants/RLS.
- Concorrência `supabase/tests/channel_orders.concurrency.sh`: PDV × ML (última unidade) e import duplo simultâneo.
- vitest: `orders.test.ts` (normalização, estados, pagamentos, refresh de token, headers), `channelOrders.service.test.ts` (mapeamento, orquestração), `inboundEvents.service.test.ts` (webhook parse/enqueue, worker, backoff, dead, fan-out), `webhooks/mercadolivre/route.test.ts`, rotas de pedidos, `syncListing` quantityOnly.

## 13. Limitações conhecidas

- **Liberação prevista** só depois do faturamento do ML (`billing`); antes fica "não informada".
- **Rebates/descontos da tarifa** (`billing sale_fee.rebate`) guardados, não lançados — a tarifa lançada é a do pedido/pagamento.
- **Cancelamento** estorna 100% da tarifa e do frete lançados; cobrança residual real do ML (se houver) exige conciliação por billing (fase futura).
- **Reembolso parcial / devolução**: `needs_attention`, sem devolução automática (fora do escopo).
- **Frete do comprador em frete próprio (não ME2)** não vira receita nesta fase.
- **`missed_feeds`** (recuperar notificações perdidas até 2 dias) não implementado — o job só processa o que chegou; "Reprocessar" cobre casos pontuais.
- **Nuvemshop** no fan-out usa o serviço legado single-tenant (só variações mapeadas).
- `rpc_cancel_sale` (core) devolve item normal ao local principal (kits voltam ao local de origem) — comportamento existente, não específico do ML.
- Suítes SQL antigas `rpc_create_sale_*`, `pdv_wholesale_retail_shared_stock`, `integration_outbox_sale_events`, `wholesale_orders`, `rls_tenant_isolation` falham no **setup** (gravam `stock_balances` direto, bloqueado desde 20260610, ou erro de sintaxe) — anteriores a esta fase; as asserções de overload/grants do `rpc_create_sale` passam com a nova assinatura.
