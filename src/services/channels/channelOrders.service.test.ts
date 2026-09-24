import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ChannelOrderError,
  mapOrderItems,
  processMercadoLivreOrder,
  processMercadoLivreShipment,
  type ChannelOrdersRepo,
  type ListingForMapping,
  type MlOrderApi,
} from './channelOrders.service'
import { orderFixture } from '@/lib/integrations/mercadolivre/mlOrders.testutil'
import { MercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import type { NormalizedOrderItem } from '@/lib/integrations/mercadolivre/orders'

const item = (over: Partial<NormalizedOrderItem> = {}): NormalizedOrderItem => ({
  external_item_id: 'MLB100', external_variation_id: null, external_user_product_id: null, seller_sku: 'TEST-ML-NORMAL-01',
  title: 'x', quantity: 1, unit_price: 50, sale_fee: 8.5, listing_type_id: 'gold_special', ...over,
})
const listing = (over: Partial<ListingForMapping> = {}): ListingForMapping => ({
  id: 1, product_variation_id: 11, seller_sku: 'TEST-ML-NORMAL-01', external_listing_id: 'MLB100',
  external_variant_id: null, external_product_id: 'MLBU1', local_status: 'active', ...over,
})

describe('mapOrderItems — só pelos vínculos da Fase 2', () => {
  it('item_id → variação', () => {
    expect(mapOrderItems([item()], [listing()])[0]).toMatchObject({ mapping_status: 'mapped', product_variation_id: 11, channel_listing_id: 1, mapping_note: null, listing_resolution: 'exact' })
  })
  it('legado com variações: desempata por variation_id', () => {
    const r = mapOrderItems([item({ external_variation_id: '22' })], [
      listing({ id: 1, external_variant_id: '21', product_variation_id: 11 }),
      listing({ id: 2, external_variant_id: '22', product_variation_id: 12, seller_sku: 'TEST-ML-NORMAL-01' }),
    ])
    expect(r[0]).toMatchObject({ mapping_status: 'mapped', product_variation_id: 12 })
  })
  it('fallback user_product_id e depois SELLER_SKU (com nota)', () => {
    expect(mapOrderItems([item({ external_item_id: 'MLB999', external_user_product_id: 'MLBU1' })], [listing()])[0]).toMatchObject({ mapping_status: 'mapped', mapping_note: 'vinculado por user_product_id' })
    expect(mapOrderItems([item({ external_item_id: 'MLB999' })], [listing()])[0]).toMatchObject({ mapping_status: 'mapped', mapping_note: 'vinculado por seller_sku' })
  })
  it('sem vínculo → unmapped (nunca procura por nome/título); vínculo encerrado não conta', () => {
    expect(mapOrderItems([item({ external_item_id: 'MLB999', seller_sku: 'OUTRO', title: 'Item de Teste ML' })], [listing({ seller_sku: 'X' })])[0])
      .toMatchObject({ mapping_status: 'unmapped', listing_resolution: 'unmapped' })
    expect(mapOrderItems([item()], [listing({ local_status: 'closed' })])[0].mapping_status).toBe('unmapped')
  })

  it('SKU divergente com item_id exato → importa pela oferta exata, só AVISO (SKU é auxiliar)', () => {
    const r = mapOrderItems([item({ seller_sku: 'SKU-RENOMEADO' })], [listing()])[0]
    expect(r).toMatchObject({ mapping_status: 'mapped', channel_listing_id: 1, product_variation_id: 11, listing_resolution: 'exact' })
    expect(r.mapping_note).toMatch(/^aviso: SELLER_SKU/)
  })

  it('N ofertas da mesma variação: item_id exato resolve A oferta certa', () => {
    const offers = [listing({ id: 1, external_listing_id: 'MLB100' }), listing({ id: 2, external_listing_id: 'MLB101' }), listing({ id: 3, external_listing_id: 'MLB102' })]
    expect(mapOrderItems([item({ external_item_id: 'MLB101' })], offers)[0]).toMatchObject({ channel_listing_id: 2, product_variation_id: 11, listing_resolution: 'exact' })
  })

  it('fallback com N ofertas da MESMA variação → importa pela variação, SEM inventar oferta (ambiguous_same_variation)', () => {
    const offers = [listing({ id: 1, external_listing_id: 'MLB100' }), listing({ id: 2, external_listing_id: 'MLB101' })]
    const byUp = mapOrderItems([item({ external_item_id: 'MLB-DESCONHECIDO', external_user_product_id: 'MLBU1' })], offers)[0]
    expect(byUp).toMatchObject({ mapping_status: 'mapped', product_variation_id: 11, channel_listing_id: null, listing_resolution: 'ambiguous_same_variation',
      external_item_id: 'MLB-DESCONHECIDO', external_user_product_id: 'MLBU1', seller_sku: 'TEST-ML-NORMAL-01' })
    expect(byUp.mapping_note).toMatch(/listing_resolution=ambiguous_same_variation.*anúncios 1, 2/)
    const bySku = mapOrderItems([item({ external_item_id: 'MLB-DESCONHECIDO' })], offers.map((o) => ({ ...o, external_product_id: null })))[0]
    expect(bySku).toMatchObject({ product_variation_id: 11, channel_listing_id: null, listing_resolution: 'ambiguous_same_variation' })
  })

  it('fallback com ofertas de variações DIFERENTES → conflict (não importa)', () => {
    const r = mapOrderItems([item({ external_item_id: 'MLB-DESCONHECIDO', external_user_product_id: 'MLBU1' })],
      [listing({ id: 1, product_variation_id: 11 }), listing({ id: 2, external_listing_id: 'MLB101', product_variation_id: 12 })])[0]
    expect(r).toMatchObject({ mapping_status: 'conflict', product_variation_id: null, channel_listing_id: null, listing_resolution: 'conflict' })
  })

  it('fallback com UMA oferta → vinculada com a resolução registrada', () => {
    expect(mapOrderItems([item({ external_item_id: 'MLB-X', external_user_product_id: 'MLBU1' })], [listing()])[0])
      .toMatchObject({ channel_listing_id: 1, listing_resolution: 'user_product_id' })
  })
  it('kit: vínculo do kit mapeia para a variação do KIT (componentes nunca aparecem)', () => {
    const r = mapOrderItems([item({ external_item_id: 'MLB200', seller_sku: 'TEST-ML-KIT-01' })], [listing({ id: 5, external_listing_id: 'MLB200', seller_sku: 'TEST-ML-KIT-01', product_variation_id: 77 })])
    expect(r[0]).toMatchObject({ mapping_status: 'mapped', product_variation_id: 77 })
  })
})

describe('processMercadoLivreOrder', () => {
  let repo: { [K in keyof ChannelOrdersRepo]: ReturnType<typeof vi.fn> }
  let api: { [K in keyof MlOrderApi]: ReturnType<typeof vi.fn> }
  let state: { processing_state: string; sale_id: number | null }

  beforeEach(() => {
    state = { processing_state: 'pending', sale_id: null }
    repo = {
      getIntegration: vi.fn(async () => ({ id: 7, company_id: 10, provider: 'mercadolivre', status: 'active', external_account_id: '555', created_by: 'user-op' })),
      findListings: vi.fn(async () => [listing()]),
      upsertOrder: vi.fn(async () => ({ channel_order_id: 100, ...state })),
      setState: vi.fn(async () => true),
      importOrder: vi.fn(async () => ({ result: 'imported', sale_id: 500 })),
      syncCosts: vi.fn(async () => ({ result: 'noop' })),
      cancelOrder: vi.fn(async () => ({ result: 'cancelled', sale_id: 500 })),
    }
    api = {
      fetchOrder: vi.fn(async () => orderFixture()),
      fetchShipment: vi.fn(async () => ({ id: 44001, order_id: 2000001, status: 'ready_to_ship', mode: 'me2' })),
      fetchShipmentCosts: vi.fn(async () => ({ senders: [{ user_id: 555, cost: 3 }], receiver: { cost: 0 } })),
      fetchBillingOrder: vi.fn(async () => null),
    }
  })
  const deps = () => ({ repo: repo as unknown as ChannelOrdersRepo, apiFor: () => api as unknown as MlOrderApi })

  it('pedido pago → relê na API, mapeia, grava snapshot e importa com pagamento pelo BRUTO', async () => {
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r).toEqual({ channelOrderId: 100, action: 'imported', saleId: 500 })
    const [, , provider, order, items] = repo.upsertOrder.mock.calls[0]
    expect(provider).toBe('mercadolivre')
    expect(order).toMatchObject({ gross_amount: 50, marketplace_fees: 8.5, shipping_cost_seller: 3, net_amount: 38.5, shipping_mode: 'me2' })
    expect(items[0]).toMatchObject({ product_variation_id: 11, mapping_status: 'mapped' })
    expect(repo.importOrder).toHaveBeenCalledWith(10, 100, 'user-op', [expect.objectContaining({ method: 'credit_card', net_amount: 50, external_payment_id: '91' })])
  })

  it('já importado → não importa de novo; só sincroniza custos (idempotente)', async () => {
    state = { processing_state: 'imported', sale_id: 500 }
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r.action).toBe('costs_synced')
    expect(repo.importOrder).not.toHaveBeenCalled()
    expect(repo.syncCosts).toHaveBeenCalledWith(10, 100, 'user-op')
  })

  it('não pago → awaiting_payment, sem venda', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ status: 'payment_in_process', payments: [] }))
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r.action).toBe('awaiting_payment')
    expect(repo.setState).toHaveBeenCalledWith(10, 100, 'awaiting_payment')
    expect(repo.importOrder).not.toHaveBeenCalled()
  })

  it('cancelado no ML → cancela pela RPC (motivo do canal)', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ status: 'cancelled', cancel_detail: { description: 'Comprador desistiu' } }))
    state = { processing_state: 'imported', sale_id: 500 }
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r.action).toBe('cancelled')
    expect(repo.cancelOrder).toHaveBeenCalledWith(10, 100, 'user-op', 'Comprador desistiu')
  })

  it('cancelamento repetido (já cancelado) → não chama a RPC de novo', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ status: 'cancelled' }))
    state = { processing_state: 'cancelled', sale_id: 500 }
    expect((await processMercadoLivreOrder(10, 7, '2000001', deps())).code).toBe('already_cancelled')
    expect(repo.cancelOrder).not.toHaveBeenCalled()
  })

  it('risco de fraude → needs_attention, sem importar', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ tags: ['paid', 'fraud_risk_detected'] }))
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r).toMatchObject({ action: 'needs_attention', code: 'fraud_risk' })
    expect(repo.importOrder).not.toHaveBeenCalled()
  })

  it('pagamento sem equivalente → needs_attention (não distorce método)', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ payments: [{ id: 1, status: 'approved', payment_type: 'atm', transaction_amount: 50 }] }))
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r).toMatchObject({ action: 'needs_attention', code: 'unsupported_payment' })
    expect(repo.importOrder).not.toHaveBeenCalled()
  })

  it('item sem vínculo: snapshot gravado como unmapped e a RPC decide needs_attention', async () => {
    repo.findListings.mockResolvedValue([])
    repo.importOrder.mockResolvedValue({ result: 'needs_attention', code: 'unmapped_items' })
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(repo.upsertOrder.mock.calls[0][4][0].mapping_status).toBe('unmapped')
    expect(r).toMatchObject({ action: 'needs_attention', code: 'unmapped_items' })
  })

  it('pedido de OUTRO seller → ignorado, nada gravado (tenant)', async () => {
    api.fetchOrder.mockResolvedValue(orderFixture({ seller: { id: 999 } }))
    expect((await processMercadoLivreOrder(10, 7, '2000001', deps())).code).toBe('seller_mismatch')
    expect(repo.upsertOrder).not.toHaveBeenCalled()
  })

  it('integração de outra empresa/inexistente → erro permanente', async () => {
    repo.getIntegration.mockResolvedValue(null)
    await expect(processMercadoLivreOrder(99, 7, '2000001', deps())).rejects.toBeInstanceOf(ChannelOrderError)
  })

  it('custos/faturamento indisponíveis (404) não impedem a importação; 5xx propaga para retry', async () => {
    api.fetchShipmentCosts.mockRejectedValue(new MercadoLivreError('not_found', 'x', { httpStatus: 404 }))
    await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(repo.upsertOrder.mock.calls[0][3]).toMatchObject({ shipping_cost_seller: null, net_amount: null })
    api.fetchOrder.mockRejectedValue(new MercadoLivreError('server', 'boom', { httpStatus: 503 }))
    await expect(processMercadoLivreOrder(10, 7, '2000001', deps())).rejects.toMatchObject({ kind: 'server' })
  })

  it('oferta ambígua: importa e deixa o aviso auditável no pedido (metadata)', async () => {
    repo.findListings.mockResolvedValue([listing({ id: 1, external_listing_id: 'MLB-A' }), listing({ id: 2, external_listing_id: 'MLB-B' })])
    api.fetchOrder.mockResolvedValue(orderFixture({ order_items: [{ item: { id: 'MLB-NOVO', seller_sku: 'TEST-ML-NORMAL-01', user_product_id: 'MLBU1' }, quantity: 1, unit_price: 50, sale_fee: 8.5 }] }))
    const r = await processMercadoLivreOrder(10, 7, '2000001', deps())
    expect(r.action).toBe('imported')
    const [, , , order, items] = repo.upsertOrder.mock.calls[0]
    expect(items[0]).toMatchObject({ channel_listing_id: null, product_variation_id: 11, listing_resolution: 'ambiguous_same_variation' })
    expect(order.metadata.listing_resolution_warnings).toEqual([expect.objectContaining({
      external_item_id: 'MLB-NOVO', external_user_product_id: 'MLBU1', listing_resolution: 'ambiguous_same_variation' })])
  })

  it('sem usuário operador → needs_attention', async () => {
    repo.getIntegration.mockResolvedValue({ id: 7, company_id: 10, provider: 'mercadolivre', status: 'active', external_account_id: '555', created_by: null })
    expect((await processMercadoLivreOrder(10, 7, '2000001', deps())).code).toBe('no_operator')
    expect(repo.importOrder).not.toHaveBeenCalled()
  })

  it('notificação de envio → acha o pedido e reprocessa com o envio já lido', async () => {
    const r = await processMercadoLivreShipment(10, 7, '44001', deps())
    expect(r.action).toBe('imported')
    expect(api.fetchOrder).toHaveBeenCalledWith('2000001')
    expect(api.fetchShipment).toHaveBeenCalledTimes(1)
  })
})
