import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hasMinRole, type AppRole } from '@/types/roles'

const session = vi.hoisted(() => ({ current: null as null | { id: string; role: string; company_id: number | null } }))
const listings = vi.hoisted(() => ({
  publishListings: vi.fn(),
  getChannelProductOverview: vi.fn(),
  syncListing: vi.fn(),
  pauseListing: vi.fn(),
  activateListing: vi.fn(),
  reconcileListing: vi.fn(),
  updateListingPrice: vi.fn(),
  estimateListingOfferFee: vi.fn(),
  estimateOfferFee: vi.fn(),
}))
const ml = vi.hoisted(() => ({ requiredAttributeIdsFor: vi.fn(), getMercadoLivrePublishForm: vi.fn(), getConnectedMercadoLivreIntegration: vi.fn(), searchMercadoLivreSizeCharts: vi.fn(), getMercadoLivreSizeChart: vi.fn(), getMercadoLivreSizeChartTemplate: vi.fn(), createMercadoLivreSizeChart: vi.fn(), getMercadoLivreListingTypes: vi.fn() }))

vi.mock('@/lib/supabase/session', async () => {
  const { NextResponse } = await import('next/server')
  return {
    requireRole: async (min: AppRole) => {
      if (!session.current) return { user: null, response: NextResponse.json({ error: 'Não autorizado.' }, { status: 401 }) }
      if (!hasMinRole(session.current.role as AppRole, min)) return { user: null, response: NextResponse.json({ error: 'Acesso negado.' }, { status: 403 }) }
      return { user: session.current, response: null }
    },
  }
})
vi.mock('@/services/channels/listings.service', async (orig) => {
  const real = await orig<typeof import('@/services/channels/listings.service')>()
  return { ...real, ...listings }
})
vi.mock('@/services/channels/mercadolivreChannel', () => ml)
vi.mock('@/services/integrations/mercadolivre.service', () => ({
  getMercadoLivreConnection: vi.fn(async () => ({ state: 'connected', nickname: 'TESTUSER', site_id: 'MLB', is_test_user: true })),
}))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
const orders = vi.hoisted(() => ({ listChannelOrders: vi.fn(), reprocessChannelOrder: vi.fn() }))
vi.mock('@/services/channels/channelOrders.service', async (orig) => {
  const real = await orig<typeof import('@/services/channels/channelOrders.service')>()
  return { ...real, ...orders }
})
vi.mock('@/services/channels/stockFanout.service', () => ({ runStockChannelFanout: vi.fn(async () => ({})) }))

import { GET as getListings, POST as publish } from './listings/route'
import { POST as sync } from './listings/[id]/sync/route'
import { POST as pause } from './listings/[id]/pause/route'
import { GET as categoryForm } from '../integrations/mercadolivre/categories/[categoryId]/route'
import { POST as searchCharts } from '../integrations/mercadolivre/size-charts/search/route'
import { GET as getChart } from '../integrations/mercadolivre/size-charts/[chartId]/route'
import { POST as chartTemplate } from '../integrations/mercadolivre/size-charts/template/route'
import { POST as createChart } from '../integrations/mercadolivre/size-charts/route'
import { GET as listOrders } from './orders/route'
import { POST as reprocess } from './orders/[id]/reprocess/route'
import { ChannelOrderError } from '@/services/channels/channelOrders.service'
import { POST as setPrice } from './listings/[id]/price/route'
import { GET as offerFee } from './listings/[id]/fee-estimate/route'
import { GET as listingTypes } from '../integrations/mercadolivre/listing-types/route'
import { GET as newOfferFee } from '../integrations/mercadolivre/fee-estimate/route'
import { ListingError } from '@/services/channels/listings.service'

const base = 'https://erp.example.com'
const body = {
  provider: 'mercadolivre', product_id: 1, category_id: 'MLB1234',
  common_attributes: [{ id: 'BRAND', value_name: 'X' }],
  variations: [{ product_variation_id: 11, attributes: [] }],
}
const post = (b: unknown) => new Request(`${base}/api/channels/listings`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { id: 'user-a', role: 'gerente', company_id: 1 }
  ml.requiredAttributeIdsFor.mockResolvedValue(['BRAND'])
})

describe('rotas de canais', () => {
  it('sem sessão → 401; papel abaixo de gerente → 403 (nada é chamado)', async () => {
    session.current = null
    expect((await publish(post(body))).status).toBe(401)
    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await publish(post(body))).status).toBe(403)
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(403)
    expect(listings.publishListings).not.toHaveBeenCalled()
    expect(listings.syncListing).not.toHaveBeenCalled()
  })

  it('empresa vem SEMPRE da sessão (company_id no corpo é ignorado)', async () => {
    listings.publishListings.mockResolvedValue({ channel: { model: 'user_products', accountLabel: 'T', sellerId: '1', isTestAccount: true }, results: [{ status: 'published' }] })
    const res = await publish(post({ ...body, company_id: 999 }))
    expect(res.status).toBe(201)
    expect(listings.publishListings.mock.calls[0][0]).toEqual({ companyId: 1, userId: 'user-a' })
    expect(ml.requiredAttributeIdsFor.mock.calls[0][0]).toBe(1)
    expect(listings.publishListings.mock.calls[0][1]).toMatchObject({ requiredAttributeIds: ['BRAND'], categoryId: 'MLB1234' })
  })

  it('validação: provider desconhecido, categoria inválida e sem variações → 422', async () => {
    expect((await publish(post({ ...body, provider: 'shopee' }))).status).toBe(422)
    expect((await publish(post({ ...body, category_id: '../x' }))).status).toBe(422)
    expect((await publish(post({ ...body, variations: [] }))).status).toBe(422)
    expect((await categoryForm(new NextRequest(`${base}/x`), { params: { categoryId: 'MLB1;DROP' } })).status).toBe(400)
  })

  it('erros do serviço mapeados sem vazar detalhes internos', async () => {
    listings.syncListing.mockRejectedValue(new ListingError('not_found', 'Anúncio não encontrado.'))
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(404)
    listings.pauseListing.mockRejectedValue(new ListingError('needs_reauth', 'Reautorize.'))
    expect((await pause(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(409)
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: 'abc' } })).status).toBe(400)
  })

  it('GET ?product_id= devolve conexão + overview, sem tokens', async () => {
    listings.getChannelProductOverview.mockResolvedValue({ product: { id: 1 }, variations: [] })
    const res = await getListings(new NextRequest(`${base}/api/channels/listings?product_id=1`))
    const json = await res.json()
    expect(json.channels.mercadolivre).toEqual({ state: 'connected', nickname: 'TESTUSER', site_id: 'MLB', is_test_user: true })
    expect(JSON.stringify(json)).not.toMatch(/token|secret/i)
    expect(listings.getChannelProductOverview).toHaveBeenCalledWith(1, 1)
  })

  it('tabela de medidas: empresa da sessão, domínio/tabela validados, domain_id repassado à publicação', async () => {
    ml.searchMercadoLivreSizeCharts.mockResolvedValue({ charts: [{ id: '5001' }], filter_attribute_ids: ['GENDER'] })
    const ok = await searchCharts(new Request(`${base}/x`, { method: 'POST', body: JSON.stringify({ domain_id: 'MLB-BRAS', attributes: [{ id: 'GENDER', value_name: 'Feminino' }], company_id: 999 }) }))
    expect(ok.status).toBe(200)
    expect(ml.searchMercadoLivreSizeCharts).toHaveBeenCalledWith(1, 'MLB-BRAS', [{ id: 'GENDER', value_name: 'Feminino' }])
    expect((await searchCharts(new Request(`${base}/x`, { method: 'POST', body: JSON.stringify({ domain_id: '../x' }) }))).status).toBe(422)
    expect((await getChart(new Request(`${base}/x`), { params: { chartId: 'abc' } })).status).toBe(400)
    ml.getMercadoLivreSizeChart.mockResolvedValue({ id: '5001', rows: [] })
    expect((await getChart(new Request(`${base}/x`), { params: { chartId: '5001' } })).status).toBe(200)
    expect(ml.getMercadoLivreSizeChart).toHaveBeenCalledWith(1, '5001')

    listings.publishListings.mockResolvedValue({ channel: { model: 'user_products', accountLabel: 'T', sellerId: '1', isTestAccount: true }, results: [] })
    await publish(post({ ...body, domain_id: 'MLB-BRAS' }))
    expect(listings.publishListings.mock.calls[0][1]).toMatchObject({ domainId: 'MLB-BRAS' })
  })

  it('criar tabela: validação do corpo, empresa da sessão, 201; conta real → 403; usuário comum → 403', async () => {
    const req = (b: unknown) => new Request(`${base}/x`, { method: 'POST', body: JSON.stringify(b) })
    const good = {
      domain_id: 'MLB-BRAS', name: 'Tabela TEST', measure_type: 'BODY_MEASURE', main_attribute_id: 'SIZE',
      attributes: [{ id: 'GENDER', value_name: 'Feminino' }], rows: [{ SIZE: { value_name: 'P' } }], company_id: 999,
    }
    ml.getMercadoLivreSizeChartTemplate.mockResolvedValue({ chart_attributes: [], main_attribute_candidates: [], row_attributes: [], measure_types: [] })
    expect((await chartTemplate(req({ domain_id: 'MLB-BRAS', attributes: [] }))).status).toBe(200)
    expect(ml.getMercadoLivreSizeChartTemplate).toHaveBeenCalledWith(1, 'MLB-BRAS', [])

    expect((await createChart(req({ ...good, rows: [] }))).status).toBe(422)
    expect((await createChart(req({ ...good, main_attribute_id: 'size;drop' }))).status).toBe(422)
    expect((await createChart(req({ ...good, measure_type: 'OTHER' }))).status).toBe(422)
    expect(ml.createMercadoLivreSizeChart).not.toHaveBeenCalled()

    ml.createMercadoLivreSizeChart.mockResolvedValue({ id: '7001', rows: [{ id: '7001:1' }] })
    const res = await createChart(req(good))
    expect(res.status).toBe(201)
    expect(ml.createMercadoLivreSizeChart.mock.calls[0][0]).toBe(1)
    expect(ml.createMercadoLivreSizeChart.mock.calls[0][1]).toMatchObject({ domainId: 'MLB-BRAS', mainAttributeId: 'SIZE', rows: [{ SIZE: { value_name: 'P' } }] })

    ml.createMercadoLivreSizeChart.mockRejectedValue(new ListingError('real_account_blocked', 'bloqueado'))
    expect((await createChart(req(good))).status).toBe(403)

    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await createChart(req(good))).status).toBe(403)
  })

  it('pedidos de marketplace: gerente+, empresa da sessão, estado validado; reprocessar respeita tenant', async () => {
    orders.listChannelOrders.mockResolvedValue([{ id: 1 }])
    expect((await listOrders(new NextRequest(`${base}/api/channels/orders?state=needs_attention&company_id=999`))).status).toBe(200)
    expect(orders.listChannelOrders).toHaveBeenCalledWith(1, 'needs_attention')
    expect((await listOrders(new NextRequest(`${base}/api/channels/orders?state=drop`))).status).toBe(400)

    orders.reprocessChannelOrder.mockResolvedValue({ channelOrderId: 5, action: 'imported', saleId: 9 })
    expect((await reprocess(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(200)
    expect(orders.reprocessChannelOrder).toHaveBeenCalledWith(1, 5)
    orders.reprocessChannelOrder.mockRejectedValue(new ChannelOrderError('not_found', 'Pedido não encontrado.'))
    expect((await reprocess(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '6' } })).status).toBe(404)

    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await listOrders(new NextRequest(`${base}/api/channels/orders`))).status).toBe(403)
    expect((await reprocess(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(403)
  })

  it('Fase 4: preço por oferta (validação, 409 quando o canal não aplica, empresa da sessão), tarifa estimada e tipos', async () => {
    const req = (b: unknown) => new Request(`${base}/x`, { method: 'POST', body: JSON.stringify(b) })
    expect((await setPrice(req({ price: 0 }), { params: { id: '5' } })).status).toBe(422)
    expect((await setPrice(req({ price: 'abc' }), { params: { id: '5' } })).status).toBe(422)
    listings.updateListingPrice.mockResolvedValue({ result: 'applied', message: null, row: { id: 5, product_id: 1, offer_key: 'gold_pro', external_sub_status: [], metadata: {} } })
    expect((await setPrice(req({ price: 44.9, company_id: 999 }), { params: { id: '5' } })).status).toBe(200)
    expect(listings.updateListingPrice).toHaveBeenCalledWith(1, 5, 44.9, 'user-a')
    listings.updateListingPrice.mockResolvedValue({ result: 'not_applied', message: 'não aplicou', row: { id: 5, product_id: 1, offer_key: 'gold_pro', external_sub_status: [], metadata: {} } })
    expect((await setPrice(req({ price: 44.9 }), { params: { id: '5' } })).status).toBe(409)
    listings.updateListingPrice.mockRejectedValue(new ListingError('not_found', 'x'))
    expect((await setPrice(req({ price: 44.9 }), { params: { id: '6' } })).status).toBe(404)

    listings.estimateListingOfferFee.mockResolvedValue({ sale_fee_amount: 5 })
    expect((await offerFee(new NextRequest(`${base}/x?price=-1`), { params: { id: '5' } })).status).toBe(400)
    expect((await offerFee(new NextRequest(`${base}/x?price=39.9`), { params: { id: '5' } })).status).toBe(200)
    expect(listings.estimateListingOfferFee).toHaveBeenCalledWith(1, 5, 39.9)

    expect((await newOfferFee(new NextRequest(`${base}/x?category_id=MLB1&listing_type_id=gold_pro&price=0`))).status).toBe(400)
    listings.estimateOfferFee.mockResolvedValue({ sale_fee_amount: 5 })
    expect((await newOfferFee(new NextRequest(`${base}/x?category_id=MLB1&listing_type_id=gold_pro&price=10`))).status).toBe(200)
    expect(listings.estimateOfferFee).toHaveBeenCalledWith(1, { price: 10, categoryId: 'MLB1', listingTypeId: 'gold_pro' })

    expect((await listingTypes(new NextRequest(`${base}/x?category_id=../x`))).status).toBe(400)
    ml.getMercadoLivreListingTypes.mockResolvedValue([{ id: 'gold_pro', name: 'Premium' }])
    expect((await listingTypes(new NextRequest(`${base}/x?category_id=MLB1234`))).status).toBe(200)
    expect(ml.getMercadoLivreListingTypes).toHaveBeenCalledWith(1, 'MLB1234')

    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await setPrice(req({ price: 44.9 }), { params: { id: '5' } })).status).toBe(403)
  })
})
