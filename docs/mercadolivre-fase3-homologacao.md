# Mercado Livre — fechamento da homologação da Fase 3 (produção, TEST)

Consultas **somente leitura** para conferir, no banco real, os pedidos feitos
com TEST buyer → TEST seller. Troque `:pedido` pelo `external_order_id` (id do
pedido no ML). Nada aqui escreve no banco.

## 1. Idempotência (rodar ANTES e DEPOIS de clicar "Reprocessar" 3× em /vendas/marketplace)

```sql
-- deve ser sempre: 1 | 1 | <mesmo número de movimentos> | <mesmo número de lançamentos>
select
  (select count(*) from channel_orders where external_order_id = :'pedido')                       as channel_orders,
  (select count(*) from sales s join channel_orders co on co.sale_id = s.id
    where co.external_order_id = :'pedido')                                                        as vendas,
  (select count(*) from stock_movements m join channel_orders co on m.reference_id = co.sale_id::text
    where co.external_order_id = :'pedido' and m.movement_type <> 'cancel')                        as baixas,
  (select count(*) from stock_movements m join channel_orders co on m.reference_id = co.sale_id::text
    where co.external_order_id = :'pedido' and m.movement_type = 'cancel')                         as devolucoes,
  (select count(*) from finance_entries f join channel_orders co on f.sale_id = co.sale_id
    where co.external_order_id = :'pedido')                                                        as lancamentos,
  (select count(*) from inbound_events where resource = '/orders/' || :'pedido')                    as eventos_recebidos;
```

Esperado após venda + cancelamento: `channel_orders = 1`, `vendas = 1`,
`baixas` = nº de itens físicos (kit: nº de componentes), `devolucoes` = o
mesmo número, `lancamentos` estável entre reprocessamentos.

## 2. Conferência financeira

```sql
select co.processing_state, co.channel_status, co.gross_amount, co.paid_amount, co.marketplace_fees,
       co.shipping_cost_seller, co.net_amount, co.money_release_date, co.fees_posted, co.shipping_posted,
       co.financial_sources
from channel_orders co where co.external_order_id = :'pedido';

select s.sale_number, s.status, s.sales_channel, s.total, s.subtotal, s.shipping_charged
from sales s join channel_orders co on co.sale_id = s.id where co.external_order_id = :'pedido';

select sp.method, sp.net_amount, sp.external_payment_id, sp.metadata->>'provider_payment_type' as tipo_ml,
       sp.metadata->>'provider_payment_method' as metodo_ml, sp.metadata->>'marketplace_fee' as tarifa_no_pagamento
from sale_payments sp join channel_orders co on co.sale_id = sp.sale_id where co.external_order_id = :'pedido';

select f.type, f.category, f.amount, f.description, f.reference_date
from finance_entries f join channel_orders co on co.sale_id = f.sale_id
where co.external_order_id = :'pedido' order by f.id;

select count(*) as cashback_gerado
from cashback_transactions c join channel_orders co on co.sale_id = c.sale_id
where co.external_order_id = :'pedido' and c.type = 'earn';   -- esperado 0
```

Pedidos TEST frequentemente vêm com tarifa/frete **zero ou ausentes**: o
Qarvon mantém exatamente o que a API devolveu (0 ou vazio) — nunca estima.
`financial_sources` mostra de qual endpoint veio cada valor. Com tarifa/frete
0 não há lançamento `marketplace_fee`/`freight_cost` (nem estorno).

## 3. Kit

```sql
select si.product_variation_id, pv.sku_variation, p.product_kind, si.quantity, si.unit_price
from sale_items si join product_variations pv on pv.id = si.product_variation_id join products p on p.id = pv.product_id
join channel_orders co on co.sale_id = si.sale_id where co.external_order_id = :'pedido';        -- 1 linha, product_kind = kit

select sic.component_product_variation_id, cpv.sku_variation, sic.quantity_per_kit, sic.total_quantity, sic.quantity as saiu_deste_local, sic.stock_location_id
from sale_item_components sic join product_variations cpv on cpv.id = sic.component_product_variation_id
join channel_orders co on co.sale_id = sic.sale_id where co.external_order_id = :'pedido';
```

## 4. Múltiplas ofertas

```sql
-- ofertas da variação: ids, preço e status próprios; quantidade sincronizada igual
select id, offer_key, listing_type_id, external_listing_id, channel_price, last_sent_price,
       local_status, external_status, synced_quantity, stock_sync_pending, last_synced_at
from channel_listings where product_variation_id = :variacao and local_status <> 'closed' order by id;

-- qual oferta originou o pedido
select coi.channel_listing_id, coi.listing_resolution, coi.external_item_id
from channel_order_items coi join channel_orders co on co.id = coi.channel_order_id
where co.external_order_id = :'pedido';
```

Convergência: depois do job `/api/jobs/stock-availability/run` (ou
`/api/jobs/channels/inbound`), `synced_quantity` de TODAS as ofertas =
disponibilidade da variação no Qarvon, `stock_sync_pending = false`, e o
`available_quantity` de cada item no ML igual.

## 5. Nomes/SKU

Automatizado (vitest `listings.service.test.ts` F10 e
`channelOrders.service.test.ts` "rename"): renomear produto/variação/título e
divergir o SELLER_SKU não quebra sync nem importação — o vínculo é por
`channel_listing_id`/`external_listing_id`; SKU divergente só gera aviso.
