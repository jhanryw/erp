import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  decideOrderAction,
  fetchBillingOrder,
  fetchOrder,
  fetchShipmentCosts,
  mapPaymentMethod,
  normalizeMercadoLivreOrder,
  parseNotificationResource,
} from './orders'
import { orderFixture } from './mlOrders.testutil'
import { setMercadoLivreLogSink } from './log'
import { FakeMlDb, TEST_CONFIG, setTestCipherEnv } from './fakeMercadoLivre.testutil'
import { FakeMlMarket } from './fakeMlMarket.testutil'

beforeAll(() => setTestCipherEnv())

const SELLER = '555'

describe('normalizeMercadoLivreOrder — valores REAIS da API', () => {
  const costs = { gross_amount: 20, receiver: { user_id: 9001, cost: 0 }, senders: [{ user_id: 555, cost: 3 }, { user_id: 777, cost: 9 }] }

  it('bruto = Σ unit_price × qty; tarifa de payments.marketplace_fee; frete do vendedor dos custos; líquido', () => {
    const n = normalizeMercadoLivreOrder(orderFixture(), { sellerId: SELLER, costs })
    expect(n.order).toMatchObject({
      external_order_id: '2000001', gross_amount: 50, marketplace_fees: 8.5, shipping_cost_seller: 3, shipping_cost_buyer: 0,
      net_amount: 38.5, paid_amount: 50, is_test: true, external_shipment_id: '44001', buyer_external_id: '9001',
    })
    expect((n.order.financial_sources as Record<string, string>).marketplace_fees).toMatch(/marketplace_fee/)
    expect((n.order.financial_sources as Record<string, string>).shipping_cost_seller).toMatch(/senders\[seller\]/)
  })

  it('sem marketplace_fee no pagamento → Σ sale_fee × quantidade (sale_fee é por unidade)', () => {
    const o = orderFixture({
      order_items: [{ item: { id: 'MLB100' }, quantity: 2, unit_price: 50, sale_fee: 8.5 }],
      payments: [{ id: 91, status: 'approved', payment_type: 'credit_card', transaction_amount: 100 }],
    })
    const n = normalizeMercadoLivreOrder(o, { sellerId: SELLER, costs })
    expect(n.order).toMatchObject({ gross_amount: 100, marketplace_fees: 17, net_amount: 80 })
    expect(n.items[0]).toMatchObject({ quantity: 2, unit_price: 50, sale_fee: 17 })
  })

  it('nada estimado: sem tarifa informada → null; sem custos do envio → frete null e líquido null', () => {
    const o = orderFixture({ order_items: [{ item: { id: 'MLB100' }, quantity: 1, unit_price: 50 }], payments: [{ id: 91, status: 'approved', payment_type: 'credit_card', transaction_amount: 50 }] })
    const n = normalizeMercadoLivreOrder(o, { sellerId: SELLER })
    expect(n.order).toMatchObject({ marketplace_fees: null, shipping_cost_seller: null, net_amount: null })
  })

  it('liberação prevista vem do faturamento quando existir', () => {
    const n = normalizeMercadoLivreOrder(orderFixture(), { sellerId: SELLER, costs, billing: { order_id: 2000001, payment_info: [{ payment_id: 91, money_release_date: '2026-10-22T10:00:00' }] } })
    expect(n.order.money_release_date).toBe('2026-10-22T10:00:00')
  })

  it('pagamento: valor comercial (bruto), id externo, método original em metadata', () => {
    const n = normalizeMercadoLivreOrder(orderFixture(), { sellerId: SELLER, costs })
    expect(n.payments).toEqual([expect.objectContaining({
      method: 'credit_card', net_amount: 50, installments: 3, card_brand: 'visa', external_payment_id: '91',
      metadata: expect.objectContaining({ provider_payment_type: 'credit_card', provider_payment_method: 'visa', marketplace_fee: 8.5 }),
    })])
  })

  it('vários pagamentos: bruto rateado sem perder centavos; pagamento recusado ignorado', () => {
    const o = orderFixture({
      order_items: [{ item: { id: 'MLB100' }, quantity: 1, unit_price: 100, sale_fee: 10 }],
      payments: [
        { id: 1, status: 'approved', payment_type: 'account_money', payment_method_id: 'account_money', transaction_amount: 33.33 },
        { id: 2, status: 'approved', payment_type: 'credit_card', payment_method_id: 'master', transaction_amount: 66.67 },
        { id: 3, status: 'rejected', payment_type: 'credit_card', transaction_amount: 100 },
      ],
    })
    const n = normalizeMercadoLivreOrder(o, { sellerId: SELLER, costs })
    expect(n.payments.map((p) => [p.method, p.net_amount])).toEqual([['digital_wallet', 33.33], ['credit_card', 66.67]])
    expect(n.payments.reduce((s, p) => s + p.net_amount, 0)).toBeCloseTo(100, 2)
  })

  it('forma de pagamento sem equivalente → reportada (não vira pix/cash)', () => {
    const o = orderFixture({ payments: [{ id: 91, status: 'approved', payment_type: 'crypto', payment_method_id: 'btc', transaction_amount: 50 }] })
    expect(normalizeMercadoLivreOrder(o, { sellerId: SELLER }).unsupportedPayments).toEqual(['crypto/btc'])
  })

  it('seller do pedido diferente da conta conectada → sellerMatches=false', () => {
    expect(normalizeMercadoLivreOrder(orderFixture({ seller: { id: 999 } }), { sellerId: SELLER }).sellerMatches).toBe(false)
  })

  it('snapshot sanitizado: sem dados pessoais do comprador', () => {
    const snap = JSON.stringify(normalizeMercadoLivreOrder(orderFixture(), { sellerId: SELLER }).order.raw_snapshot)
    expect(snap).not.toMatch(/TESTBUYER|nickname|email|phone|address/i)
  })
})

describe('regras', () => {
  it('estados processáveis', () => {
    expect(decideOrderAction({ status: 'paid' }).action).toBe('import')
    for (const st of ['confirmed', 'payment_required', 'payment_in_process', 'partially_paid']) expect(decideOrderAction({ status: st }).action).toBe('await_payment')
    for (const st of ['cancelled', 'invalid', 'pending_cancel']) expect(decideOrderAction({ status: st }).action).toBe('cancel')
    expect(decideOrderAction({ status: 'partially_refunded' })).toMatchObject({ action: 'attention', code: 'partial_refund' })
    expect(decideOrderAction({ status: 'paid', tags: ['fraud_risk_detected'] })).toMatchObject({ action: 'attention', code: 'fraud_risk' })
    expect(decideOrderAction({ status: 'cancelled', tags: ['fraud_risk_detected'] }).action).toBe('cancel')
  })

  it('métodos de pagamento', () => {
    expect(mapPaymentMethod({ payment_type: 'credit_card' })).toBe('credit_card')
    expect(mapPaymentMethod({ payment_type: 'debit_card' })).toBe('debit_card')
    expect(mapPaymentMethod({ payment_type: 'bank_transfer', payment_method_id: 'pix' })).toBe('pix')
    expect(mapPaymentMethod({ payment_type: 'account_money' })).toBe('digital_wallet')
    expect(mapPaymentMethod({ payment_type: 'ticket', payment_method_id: 'bolbradesco' })).toBe('boleto')
    expect(mapPaymentMethod({ payment_type: 'atm' })).toBeNull()
  })

  it('recurso da notificação', () => {
    expect(parseNotificationResource('orders_v2', '/orders/2000001')).toEqual({ kind: 'order', id: '2000001' })
    expect(parseNotificationResource('shipments', '/shipments/44001')).toEqual({ kind: 'shipment', id: '44001' })
    expect(parseNotificationResource('orders_v2', '/orders/../x')).toBeNull()
    expect(parseNotificationResource('items', '/items/MLB1')).toBeNull()
  })
})

describe('chamadas à API (ML simulado)', () => {
  let db: FakeMlDb
  let api: FakeMlMarket
  let integrationId: number
  const ctx = () => ({ integrationId, companyId: 10, deps: { config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} } })

  beforeEach(() => {
    db = new FakeMlDb()
    api = new FakeMlMarket()
    setMercadoLivreLogSink(() => {})
    api.orders.set('2000001', orderFixture() as unknown as Record<string, unknown>)
    api.shipmentCosts.set('44001', { gross_amount: 20, receiver: { user_id: 9001, cost: 0 }, senders: [{ user_id: 555, cost: 3 }] })
  })
  afterEach(() => setMercadoLivreLogSink(null))

  it('token expirado é renovado durante o processamento do pedido', async () => {
    const pair = api.issue()
    integrationId = db.seedConnected(10, SELLER, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() - 1000) })
    const order = await fetchOrder(ctx(), '2000001')
    expect(order.id).toBe(2000001)
    expect(api.refreshCalls).toBe(1)
  })

  it('custos do envio pedem x-format-new; faturamento ausente → null (sem erro)', async () => {
    const pair = api.issue()
    integrationId = db.seedConnected(10, SELLER, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
    await fetchShipmentCosts(ctx(), '44001')
    const call = api.calls.find((c) => c.url.includes('/shipments/44001/costs'))!
    expect(call.headers['x-format-new']).toBe('true')
    expect(call.url).not.toMatch(/access_token|APP_USR/)
    expect(await fetchBillingOrder(ctx(), '2000001')).toBeNull()
  })
})
