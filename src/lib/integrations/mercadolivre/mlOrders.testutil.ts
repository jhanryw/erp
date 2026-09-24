/** Fixture de pedido do Mercado Livre (formato de GET /orders/{id}) — só para testes. */
import type { MlOrder } from './orders'

export const orderFixture = (over: Partial<MlOrder> = {}): MlOrder => ({
  id: 2000001,
  status: 'paid',
  date_created: '2026-09-24T10:00:00.000-03:00',
  last_updated: '2026-09-24T10:01:00.000-03:00',
  pack_id: null,
  total_amount: 50,
  paid_amount: 50,
  currency_id: 'BRL',
  order_items: [{ item: { id: 'MLB100', title: 'Item de Teste ML', variation_id: null, seller_sku: 'TEST-ML-NORMAL-01' }, quantity: 1, unit_price: 50, sale_fee: 8.5, listing_type_id: 'gold_special' }],
  payments: [{ id: 91, status: 'approved', payment_type: 'credit_card', payment_method_id: 'visa', installments: 3, transaction_amount: 50, total_paid_amount: 50, shipping_cost: 0, marketplace_fee: 8.5, date_approved: '2026-09-24T10:00:30.000-03:00', currency_id: 'BRL' }],
  shipping: { id: 44001 },
  buyer: { id: 9001, nickname: 'TESTBUYER' },
  seller: { id: 555 },
  tags: ['test_order', 'paid'],
  taxes: { amount: null },
  ...over,
})

