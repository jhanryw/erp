import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  ListingError,
  activateListing,
  assertPublishAllowed,
  getChannelProductOverview,
  toListingView,
  pauseListing,
  publishListings,
  reconcileListing,
  resolveListingPrice,
  resolveListingQuantity,
  syncListing,
  updateListingPrice,
  estimateListingOfferFee,
  aggregateOfferMetrics,
  type OfferSaleRow,
  type AvailabilityInfo,
  type BeginResult,
  type ChannelContext,
  type ListingRow,
  type ListingsRepo,
  type ListingsServiceDeps,
  type ProductSource,
} from './listings.service'
import { createMercadoLivreAdapter } from '@/lib/integrations/mercadolivre/adapter'
import { setMercadoLivreLogSink } from '@/lib/integrations/mercadolivre/log'
import { FakeMlDb, TEST_CONFIG, setTestCipherEnv } from '@/lib/integrations/mercadolivre/fakeMercadoLivre.testutil'
import { FakeMlMarket } from '@/lib/integrations/mercadolivre/fakeMlMarket.testutil'
import type { ChannelListingSnapshot } from '@/lib/channels/types'
import { createSizeChartForChannel } from './mercadolivreChannel'
import { estimateListingFee } from '@/lib/integrations/mercadolivre/catalog'
import { matchSizeChartRow, searchSizeCharts } from '@/lib/integrations/mercadolivre/sizeCharts'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const OTHER = 20
const USER = '00000000-0000-0000-0000-000000000001'
const JPG = 'https://x.supabase.co/storage/v1/object/public/media-public/p.jpg'

/** Repo em memória com a MESMA semântica das RPCs de 202609251000 (coberta em SQL). */
class MemoryRepo implements ListingsRepo {
  rows: Array<ListingRow & { publish_attempt_id: string | null }> = []
  next = 1
  now = () => Date.now()

  async begin(a: Parameters<ListingsRepo['begin']>[0]): Promise<BeginResult> {
    // Mesma semântica da RPC (202609260900): reserva POR OFERTA (variação × offer_key).
    const r = this.rows.find((x) => x.integration_id === a.integrationId && x.product_variation_id === a.productVariationId
      && x.offer_key === a.offerKey && x.company_id === a.companyId && x.local_status !== 'closed')
    const lease = new Date(this.now() + Math.max(a.leaseSeconds, 10) * 1000).toISOString()
    if (r) {
      if (r.local_status === 'active' || r.local_status === 'paused' || r.external_listing_id) return { result: 'already_published', listing_id: r.id }
      if (r.local_status === 'publishing') {
        return new Date(r.publish_lease_until!).getTime() > this.now() ? { result: 'in_progress', listing_id: r.id } : { result: 'needs_reconciliation', listing_id: r.id }
      }
      Object.assign(r, { local_status: 'publishing', publish_attempt_id: a.attemptId, publish_lease_until: lease, seller_sku: a.sellerSku, channel_price: a.channelPrice, metadata: { ...r.metadata, ...a.metadata }, last_error: null })
      return { result: 'claimed', listing_id: r.id }
    }
    const row = {
      id: this.next++, company_id: a.companyId, integration_id: a.integrationId, provider: a.provider, product_id: a.productId,
      product_variation_id: a.productVariationId, seller_sku: a.sellerSku, offer_key: a.offerKey, listing_type_id: a.listingTypeId,
      external_listing_id: null, external_variant_id: null,
      external_product_id: null, external_group_id: null, external_ids: {}, external_category_id: null, external_status: null,
      external_sub_status: null, permalink: null, local_status: 'publishing' as const, channel_price: a.channelPrice, last_sent_price: null,
      synced_quantity: null, last_synced_at: null, last_error: null, publish_lease_until: lease, publish_attempt_id: a.attemptId, metadata: a.metadata,
    }
    this.rows.push(row)
    return { result: 'claimed', listing_id: row.id }
  }

  async complete(companyId: number, id: number, attemptId: string | null, s: ChannelListingSnapshot, sentPrice: number | null, qty: number | null, warning: string | null) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    const expired = !r?.publish_lease_until || new Date(r.publish_lease_until).getTime() < this.now()
    if (!r || !((attemptId && r.publish_attempt_id === attemptId && r.local_status === 'publishing') || (!attemptId && ['publishing', 'error'].includes(r.local_status) && expired))) return false
    Object.assign(r, {
      external_listing_id: s.externalListingId, external_variant_id: s.externalVariantId, external_product_id: s.externalProductId,
      external_group_id: s.externalGroupId, external_ids: { ...r.external_ids, ...s.externalIds }, external_category_id: s.externalCategoryId ?? r.external_category_id,
      external_status: s.externalStatus, external_sub_status: s.externalSubStatus, permalink: s.permalink,
      local_status: s.externalStatus === 'closed' ? 'closed' : 'active', last_sent_price: sentPrice, synced_quantity: qty,
      last_synced_at: new Date().toISOString(), last_error: warning, publish_attempt_id: null, publish_lease_until: null,
    })
    return true
  }

  async fail(companyId: number, id: number, attemptId: string | null, error: string) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    const expired = r?.publish_lease_until != null && new Date(r.publish_lease_until).getTime() < this.now()
    if (!r || !((attemptId && r.publish_attempt_id === attemptId && r.local_status === 'publishing') || (!attemptId && r.local_status === 'publishing' && expired))) return false
    Object.assign(r, { local_status: 'error', last_error: error, publish_attempt_id: null, publish_lease_until: null })
    return true
  }

  async get(companyId: number, id: number) { return this.rows.find((x) => x.id === id && x.company_id === companyId) ?? null }
  async listByProduct(companyId: number, productId: number) { return this.rows.filter((x) => x.company_id === companyId && x.product_id === productId) }
  async update(companyId: number, id: number, patch: Partial<ListingRow>) {
    const r = this.rows.find((x) => x.id === id && x.company_id === companyId)
    if (r) Object.assign(r, patch)
  }
}

let db: FakeMlDb
let api: FakeMlMarket
let repo: MemoryRepo
let integrationId: number
let products: Array<ProductSource & { company_id: number }>
let availability: Map<number, AvailabilityInfo>
let pictures: Record<number, string[]>
let availabilityCalls: Array<{ companyId: number; ids: number[] }>
let channelState: 'connected' | 'needs_reauth'

function channel(): ChannelContext {
  return { provider: 'mercadolivre', integrationId, companyId: COMPANY, sellerId: String(api.me.id), siteId: 'MLB', currencyId: 'BRL', model: 'user_products', accountLabel: 'LOJA_TESTE', isTestAccount: true }
}

function deps(over: Partial<ListingsServiceDeps> = {}): ListingsServiceDeps {
  return {
    repo,
    source: {
      loadProduct: async (companyId, productId) => products.find((p) => p.id === productId && p.company_id === companyId) ?? null,
      loadPictures: async (_c, _p, variationId) => pictures[variationId] ?? [JPG],
    },
    availability: async (companyId, ids) => {
      availabilityCalls.push({ companyId, ids })
      return new Map(ids.filter((id) => availability.has(id)).map((id) => [id, availability.get(id)!]))
    },
    resolveChannel: async (companyId) => {
      if (companyId !== COMPANY) throw new ListingError('not_connected', 'Mercado Livre não conectado.')
      if (channelState === 'needs_reauth') throw new ListingError('needs_reauth', 'Reautorize.')
      return channel()
    },
    adapterFor: (ctx) => createMercadoLivreAdapter({
      integrationId: ctx.integrationId, companyId: ctx.companyId, sellerId: ctx.sellerId, model: 'user_products',
      deps: { config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} },
    }),
    ...over,
  }
}

const session = { companyId: COMPANY, userId: USER }
const attrs = [{ id: 'BRAND', value_name: 'Santtorini' }, { id: 'MODEL', value_name: 'Renda' }]
const publishInput = (productId: number, variationIds: number[], extra: Record<string, unknown> = {}) => ({
  productId, categoryId: 'MLB1234', commonAttributes: attrs, requiredAttributeIds: ['BRAND', 'MODEL'],
  variations: variationIds.map((id) => ({ productVariationId: id, attributes: [{ id: 'SIZE', value_name: 'M' }] })),
  ...extra,
})

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlMarket()
  const pair = api.issue()
  integrationId = db.seedConnected(COMPANY, String(api.me.id), { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  repo = new MemoryRepo()
  channelState = 'connected'
  availabilityCalls = []
  pictures = {}
  products = [
    { id: 1, company_id: COMPANY, name: 'Sutiã Renda TESTE', base_price: 49.9, active: true, brand: 'Santtorini', model: 'Renda', is_kit: false,
      variations: [
        { id: 11, sku: 'SUT-PRETO-M', price_override: null, active: true, color: 'Preto', size: 'M' },
        { id: 12, sku: 'SUT-BRANCO-G', price_override: 54.9, active: true, color: 'Branco', size: 'G' },
        { id: 13, sku: 'SUT-OFF', price_override: null, active: false, color: 'Nude', size: 'P' },
      ] },
    { id: 2, company_id: COMPANY, name: 'Kit 3 Calcinhas TESTE', base_price: 89.9, active: true, brand: 'Santtorini', model: null, is_kit: true,
      variations: [{ id: 21, sku: 'KIT-3CAL', price_override: null, active: true, color: null, size: null }] },
    { id: 9, company_id: OTHER, name: 'Produto de outra empresa', base_price: 10, active: true, brand: null, model: null, is_kit: false,
      variations: [{ id: 91, sku: 'OTHER-1', price_override: null, active: true, color: null, size: null }] },
  ]
  availability = new Map([
    [11, { sellable_quantity: 7, manual_enabled: true }],
    [12, { sellable_quantity: 0, manual_enabled: true }],
    [13, { sellable_quantity: 5, manual_enabled: false }],
    // kit: a camada central já devolve min(floor(saldo componente / qtd)) — o serviço não sabe que é kit
    [21, { sellable_quantity: 4, manual_enabled: true }],
  ])
  setMercadoLivreLogSink(() => {})
})
afterEach(() => setMercadoLivreLogSink(null))

describe('regras puras', () => {
  it('preço: canal ?? override ?? base; quantidade: vendável se habilitado, senão 0', () => {
    expect(resolveListingPrice({ base_price: 49.9 }, { price_override: null }, null)).toBe(49.9)
    expect(resolveListingPrice({ base_price: 49.9 }, { price_override: 54.9 }, undefined)).toBe(54.9)
    expect(resolveListingPrice({ base_price: 49.9 }, { price_override: 54.9 }, 59.9)).toBe(59.9)
    expect(resolveListingQuantity({ sellable_quantity: 7.8, manual_enabled: true })).toBe(7)
    expect(resolveListingQuantity({ sellable_quantity: -2, manual_enabled: true })).toBe(0)
    expect(resolveListingQuantity({ sellable_quantity: 9, manual_enabled: false })).toBe(0)
    expect(resolveListingQuantity(undefined)).toBe(0)
  })
})

describe('publicação', () => {
  it('1-3. produto normal: 1 item por variação, SKU da variação, qtd da camada central, ids UP persistidos', async () => {
    const { results } = await publishListings(session, publishInput(1, [11, 12]), deps())
    expect(results.map((r) => r.status)).toEqual(['published', 'published'])
    const r11 = repo.rows.find((r) => r.product_variation_id === 11)!
    expect(r11).toMatchObject({ local_status: 'active', seller_sku: 'SUT-PRETO-M', synced_quantity: 7, last_sent_price: 49.9, external_status: 'active' })
    expect(r11.external_product_id).toMatch(/^MLBU/)
    expect(r11.external_group_id).toBeTruthy()
    expect(r11.external_ids).toMatchObject({ user_product_id: r11.external_product_id, family_id: r11.external_group_id })
    const item = api.item(r11.external_listing_id!)!
    expect(item.attributes).toContainEqual({ id: 'SELLER_SKU', value_name: 'SUT-PRETO-M' })
    expect(item.family_name).toBe('Sutiã Renda TESTE')
    // qtd 0 publicada → ML deixa pausado por falta de estoque, e localmente continua 'active'
    const r12 = repo.rows.find((r) => r.product_variation_id === 12)!
    expect(r12).toMatchObject({ local_status: 'active', synced_quantity: 0, last_sent_price: 54.9, external_sub_status: ['out_of_stock'] })
    expect(availabilityCalls[0]).toEqual({ companyId: COMPANY, ids: [11, 12] })
  })

  it('4-5. kit: SKU e preço do kit, qtd derivada da camada central, nenhum componente exposto', async () => {
    const { results } = await publishListings(session, publishInput(2, [21]), deps())
    expect(results[0].status).toBe('published')
    const row = repo.rows[0]
    expect(row).toMatchObject({ seller_sku: 'KIT-3CAL', synced_quantity: 4, last_sent_price: 89.9 })
    const item = api.item(row.external_listing_id!)!
    expect(item.available_quantity).toBe(4)
    expect(item.attributes.filter((a) => a.id === 'SELLER_SKU')).toEqual([{ id: 'SELLER_SKU', value_name: 'KIT-3CAL' }])
    expect(JSON.stringify(api.calls.map((c) => c.body))).not.toMatch(/SUT-|componente/i)
  })

  it('6. preço específico do canal sem tabela nova', async () => {
    await publishListings(session, { ...publishInput(1, [11]), variations: [{ productVariationId: 11, channelPrice: 59.9, attributes: [{ id: 'SIZE', value_name: 'M' }] }] }, deps())
    expect(repo.rows[0]).toMatchObject({ channel_price: 59.9, last_sent_price: 59.9 })
    expect(api.item(repo.rows[0].external_listing_id!)!.price).toBe(59.9)
  })

  it('7. publicação duplicada → already_published, sem novo POST /items', async () => {
    await publishListings(session, publishInput(1, [11]), deps())
    const posts = () => api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items')).length
    expect(posts()).toBe(1)
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'already_published' })
    expect(posts()).toBe(1)
  })

  it('8. publicação concorrente com lease vivo → in_progress', async () => {
    await repo.begin({ companyId: COMPANY, integrationId, provider: 'mercadolivre', productId: 1, productVariationId: 11, sellerSku: 'SUT-PRETO-M', attemptId: 'a1', leaseSeconds: 120, channelPrice: null, metadata: {}, userId: USER, offerKey: 'gold_special', listingTypeId: 'gold_special' })
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'in_progress' })
    expect(api.items.size).toBe(0)
  })

  it('9. erro do ML na publicação → vínculo em error; nova tentativa reaproveita a linha', async () => {
    // validação passa, mas o POST /items falha (ex.: instabilidade do ML)
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items', response: () => new Response(JSON.stringify({ message: 'boom', status: 500 }), { status: 500 }), once: true })
    const first = await publishListings(session, publishInput(1, [11]), deps())
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect(repo.rows[0]).toMatchObject({ local_status: 'error', external_listing_id: null })
    expect(repo.rows[0].last_error).toMatch(/500/)
    const second = await publishListings(session, publishInput(1, [11]), deps())
    expect(second.results[0].status).toBe('published')
    expect(repo.rows).toHaveLength(1)
  })

  it('10. queda após o ML criar o anúncio (lease perdido) → needs_reconciliation → reconcilia por SKU sem duplicar', async () => {
    const d = deps({ leaseSeconds: 10 })
    const realComplete = repo.complete.bind(repo)
    repo.complete = async () => false // simula: processo caiu/lease perdido antes de salvar
    const first = await publishListings(session, publishInput(1, [11]), d)
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'needs_reconciliation' })
    expect(api.items.size).toBe(1)
    repo.complete = realComplete
    // lease ainda vivo → reconciliação manual recusa
    await expect(reconcileListing(COMPANY, repo.rows[0].id, d)).rejects.toMatchObject({ code: 'in_progress' })
    // lease vence; nova tentativa de publicar reconcilia em vez de criar outro item
    repo.rows[0].publish_lease_until = new Date(Date.now() - 1000).toISOString()
    const second = await publishListings(session, publishInput(1, [11]), d)
    expect(second.results[0]).toMatchObject({ status: 'reconciled' })
    expect(api.items.size).toBe(1)
    expect(repo.rows[0]).toMatchObject({ local_status: 'active', external_listing_id: [...api.items.keys()][0] })
  })

  it('11. reconciliação sem anúncio no canal libera nova publicação; com 2 candidatos não escolhe sozinho', async () => {
    const d = deps()
    await repo.begin({ companyId: COMPANY, integrationId, provider: 'mercadolivre', productId: 1, productVariationId: 11, sellerSku: 'SUT-PRETO-M', attemptId: 'a1', leaseSeconds: 10, channelPrice: null, metadata: {}, userId: USER, offerKey: 'gold_special', listingTypeId: 'gold_special' })
    repo.rows[0].publish_lease_until = new Date(Date.now() - 1000).toISOString()
    expect((await reconcileListing(COMPANY, repo.rows[0].id, d)).outcome).toBe('not_found')
    expect(repo.rows[0].local_status).toBe('draft')

    const adapter = d.adapterFor!(channel())
    const draft = { sellerSku: 'SUT-PRETO-M', productName: 'X', title: 'X', description: null, categoryId: 'MLB1234', price: 10, currencyId: 'BRL', quantity: 1, pictureUrls: [JPG], attributes: [{ id: 'BRAND', value_name: 'X' }, { id: 'MODEL', value_name: 'Y' }, { id: 'SIZE', value_name: 'M' }], channelOptions: {} }
    await adapter.publishListing(draft)
    await adapter.publishListing(draft)
    const res = await reconcileListing(COMPANY, repo.rows[0].id, d)
    expect(res.outcome).toBe('ambiguous')
    expect(repo.rows[0].external_listing_id).toBeNull()
  })

  it('12. produto/variação desativado manualmente no Qarvon → não publica', async () => {
    const { results } = await publishListings(session, publishInput(1, [13]), deps())
    expect(results[0]).toMatchObject({ status: 'skipped', reason: 'manual_disabled' })
    expect(api.items.size).toBe(0)
    expect(repo.rows).toHaveLength(0)
  })

  it('13. imagens inválidas (webp / URL assinada) → falha antes de chamar o ML', async () => {
    pictures[11] = ['https://cdn.example.com/a.webp', 'https://x.supabase.co/storage/v1/object/sign/b.jpg?token=x']
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'invalid_images' })
    expect(repo.rows).toHaveLength(0)
    expect(api.calls.some((c) => c.url.endsWith('/items'))).toBe(false)
  })

  it('14. atributo obrigatório vazio → falha antes de chamar o ML; GTIN aceita EMPTY_GTIN_REASON', async () => {
    const miss = await publishListings(session, { ...publishInput(1, [11]), requiredAttributeIds: ['BRAND', 'MODEL', 'GTIN', 'COLOR'] }, deps())
    expect(miss.results[0]).toMatchObject({ status: 'failed', reason: 'missing_attributes' })
    expect((miss.results[0] as { message: string }).message).toMatch(/GTIN, COLOR/)
    const ok = await publishListings(session, {
      ...publishInput(1, [11]), requiredAttributeIds: ['BRAND', 'GTIN'],
      commonAttributes: [...attrs, { id: 'EMPTY_GTIN_REASON', value_id: '17055160' }],
    }, deps())
    expect(ok.results[0].status).toBe('published')
  })

  it('15. multi-tenant: produto/variação de outra empresa nunca é publicado', async () => {
    await expect(publishListings(session, publishInput(9, [91]), deps())).rejects.toMatchObject({ code: 'not_found' })
    const mixed = await publishListings(session, publishInput(1, [11, 91]), deps())
    expect(mixed.results.find((r) => r.productVariationId === 91)).toMatchObject({ status: 'failed', reason: 'not_found' })
    expect(repo.rows.map((r) => r.product_variation_id)).toEqual([11])
    await expect(publishListings({ companyId: OTHER, userId: USER }, publishInput(9, [91]), deps())).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('16. conta com needs_reauth → não publica', async () => {
    channelState = 'needs_reauth'
    await expect(publishListings(session, publishInput(1, [11]), deps())).rejects.toMatchObject({ code: 'needs_reauth' })
    expect(repo.rows).toHaveLength(0)
  })

  it('16b. trava de homologação: conta REAL não publica sem liberação explícita', async () => {
    const real = { ...channel(), isTestAccount: false }
    await expect(publishListings(session, publishInput(1, [11]), deps({ resolveChannel: async () => real }))).rejects.toMatchObject({ code: 'real_account_blocked' })
    expect(repo.rows).toHaveLength(0)
    expect(api.items.size).toBe(0)
    expect(() => assertPublishAllowed(real, { CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS: 'true' })).not.toThrow()
    expect(() => assertPublishAllowed(real, { CHANNEL_LISTINGS_ALLOW_REAL_ACCOUNTS: '1' })).toThrow()
  })

  it('17. token expirado é renovado de forma transparente durante a publicação', async () => {
    db.integrations[0].credential_expires_at = new Date(Date.now() - 1000).toISOString()
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0].status).toBe('published')
    expect(api.refreshCalls).toBe(1)
  })
})

describe('validação prévia no ML (POST /items/validate)', () => {
  const validateCalls = () => api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items/validate'))
  const createCalls = () => api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items'))

  it('V1. payload válido: valida (mesmo corpo) e só então publica', async () => {
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0].status).toBe('published')
    expect(validateCalls()).toHaveLength(1)
    expect(createCalls()).toHaveLength(1)
    expect(JSON.parse(validateCalls()[0].body!)).toEqual(JSON.parse(createCalls()[0].body!))
    expect(api.calls.indexOf(validateCalls()[0])).toBeLessThan(api.calls.indexOf(createCalls()[0]))
    expect(repo.rows[0].last_error).toBeNull()
  })

  it('V2. payload inválido (categoria inválida) → validation_failed, vínculo republicável (draft), NENHUM POST /items', async () => {
    const { results } = await publishListings(session, { ...publishInput(1, [11]), categoryId: 'MLB9999' }, deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect((results[0] as { message: string }).message).toMatch(/item\.category_id\.invalid/)
    expect(createCalls()).toHaveLength(0)
    expect(api.items.size).toBe(0)
    expect(repo.rows[0]).toMatchObject({ local_status: 'draft', external_listing_id: null })
    expect(repo.rows[0].last_error).toMatch(/Reprovado na validação/)
  })

  it('V3. atributo obrigatório exigido pelo ML → bloqueia sem POST /items; corrigido, publica na mesma linha', async () => {
    api.requiredAttributes = ['BRAND', 'MODEL', 'SIZE', 'GENDER']
    const first = await publishListings(session, publishInput(1, [11]), deps())
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect((first.results[0] as { message: string }).message).toMatch(/missing_required.*GENDER/)
    expect(createCalls()).toHaveLength(0)
    const second = await publishListings(session, { ...publishInput(1, [11]), commonAttributes: [...attrs, { id: 'GENDER', value_id: '339665' }] }, deps())
    expect(second.results[0].status).toBe('published')
    expect(repo.rows).toHaveLength(1)
  })

  it('V4. imagem recusada pelo ML (não baixável) → bloqueia sem POST /items', async () => {
    pictures[11] = ['https://cdn.example.com/broken.jpg']
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect((results[0] as { message: string }).message).toMatch(/item\.pictures\.invalid/)
    expect(createCalls()).toHaveLength(0)
  })

  it('V5. só warnings → NÃO bloqueia; publica e registra o aviso', async () => {
    api.validateWarnings = [{ code: 'item.attributes.recommended', message: 'Complete GTIN para melhorar a exposição' }]
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0].status).toBe('published')
    expect((results[0] as { warnings: string[] }).warnings).toContain('Complete GTIN para melhorar a exposição')
    expect(createCalls()).toHaveLength(1)
    expect(repo.rows[0]).toMatchObject({ local_status: 'active' })
    expect(repo.rows[0].last_error).toMatch(/^aviso: .*Complete GTIN/)
  })

  it('V6. erro + warning juntos → erro bloqueia', async () => {
    api.validateWarnings = [{ code: 'w', message: 'aviso qualquer' }]
    const { results } = await publishListings(session, { ...publishInput(1, [11]), categoryId: 'MLB9999' }, deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect(createCalls()).toHaveLength(0)
  })

  it('V7. falha de transporte na validação (5xx) → channel_error, NENHUM POST /items (não assume válido)', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items/validate', response: () => new Response('{}', { status: 503 }), once: true })
    const { results } = await publishListings(session, publishInput(1, [11]), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect(createCalls()).toHaveLength(0)
    expect(repo.rows[0].local_status).toBe('draft') // validação nunca cria nada → republicável
  })

  it('V8. kit também passa pela validação e não expõe componentes', async () => {
    await publishListings(session, publishInput(2, [21]), deps())
    const body = JSON.parse(validateCalls()[0].body!)
    expect(body.attributes).toContainEqual({ id: 'SELLER_SKU', value_name: 'KIT-3CAL' })
    expect(body.available_quantity).toBe(4)
    expect(JSON.stringify(body)).not.toMatch(/SUT-|component/i)
  })
})

describe('retry após falha: estado republicável e reconciliação', () => {
  const createCalls = () => api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items'))
  const view = () => toListingView(repo.rows[0])

  it('R1. falha antes do POST /items (validate reprova) → reconcile não acha SKU → Publicar novamente na MESMA linha', async () => {
    const first = await publishListings(session, { ...publishInput(1, [11]), categoryId: 'MLB9999', domainId: 'MLB-BRAS' }, deps())
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect(view()).toMatchObject({ local_status: 'draft', can_publish: true, needs_reconciliation: false })
    expect(view().last_attempt).toMatchObject({ stage: 'validate', price: 49.9 })
    expect(view().previous_input).toMatchObject({ category_id: 'MLB9999', domain_id: 'MLB-BRAS' })

    const rec = await reconcileListing(COMPANY, repo.rows[0].id, deps())
    expect(rec.outcome).toBe('not_found')
    expect(view()).toMatchObject({ local_status: 'draft', can_publish: true, external_listing_id: null, external_product_id: null, permalink: null })
    // histórico preservado, sem bloquear
    expect(view().last_attempt?.error).toMatch(/Reprovado na validação/)
    expect((repo.rows[0].metadata.attempts as unknown[]).length).toBe(2)

    const again = await publishListings(session, publishInput(1, [11]), deps())
    expect(again.results[0]).toMatchObject({ status: 'published', listingId: repo.rows[0].id })
    expect(repo.rows).toHaveLength(1)
    expect(createCalls()).toHaveLength(1)
    expect(view()).toMatchObject({ local_status: 'active', can_publish: false, needs_reconciliation: false })
  })

  it('R2. erro de validação do ML (atributo obrigatório) → republicável direto, sem reconciliar', async () => {
    api.requiredAttributes = ['BRAND', 'MODEL', 'SIZE', 'SIZE_GRID_ID']
    const first = await publishListings(session, publishInput(1, [11]), deps())
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect(view()).toMatchObject({ local_status: 'draft', can_publish: true })
    api.requiredAttributes = ['BRAND', 'MODEL', 'SIZE']
    const again = await publishListings(session, publishInput(1, [11]), deps())
    expect(again.results[0].status).toBe('published')
    expect(repo.rows).toHaveLength(1)
    expect(api.calls.filter((c) => c.url.includes('/items/search'))).toHaveLength(0) // nada a reconciliar
  })

  it('R3. POST /items recusado explicitamente (400) → nada criado → republicável', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items', once: true,
      response: () => new Response(JSON.stringify({ message: 'x', status: 400, cause: [{ type: 'error', code: 'item.price.invalid', message: 'preço mínimo' }] }), { status: 400 }) })
    await publishListings(session, publishInput(1, [11]), deps())
    expect(view()).toMatchObject({ local_status: 'draft', can_publish: true })
    expect(view().last_attempt).toMatchObject({ stage: 'create_rejected' })
  })

  it('R4. POST /items sem resposta (5xx) → exige reconciliação; republicar reconcilia antes e nunca duplica', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items', once: true, response: () => new Response('{}', { status: 504 }) })
    await publishListings(session, publishInput(1, [11]), deps())
    expect(view()).toMatchObject({ local_status: 'error', can_publish: false, needs_reconciliation: true })
    expect(view().last_attempt).toMatchObject({ stage: 'create_unknown' })

    // o ML tinha criado o item apesar do 504:
    const adapter = deps().adapterFor!(channel())
    await adapter.publishListing({ sellerSku: 'SUT-PRETO-M', productName: 'X', title: 'X', description: null, categoryId: 'MLB1234', price: 49.9, currencyId: 'BRL', quantity: 7, pictureUrls: [JPG], attributes: [{ id: 'BRAND', value_name: 'X' }, { id: 'MODEL', value_name: 'Y' }, { id: 'SIZE', value_name: 'M' }], channelOptions: {} })
    const again = await publishListings(session, publishInput(1, [11]), deps())
    expect(again.results[0]).toMatchObject({ status: 'reconciled' })
    expect(api.items.size).toBe(1)
    expect(view()).toMatchObject({ local_status: 'active' })
  })

  it('R5. POST /items 5xx e o item NÃO existe → publicar de novo reconcilia (0) e publica na mesma linha', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items', once: true, response: () => new Response('{}', { status: 502 }) })
    await publishListings(session, publishInput(1, [11]), deps())
    const again = await publishListings(session, publishInput(1, [11]), deps())
    expect(again.results[0].status).toBe('published')
    expect(repo.rows).toHaveLength(1)
    expect(api.items.size).toBe(1)
  })

  it('R6. erro obsoleto: overview indica o que mudou desde a tentativa (preço/quantidade)', async () => {
    await publishListings(session, { ...publishInput(1, [11]), categoryId: 'MLB9999' }, deps())
    products[0].base_price = 59.9
    availability.set(11, { sellable_quantity: 3, manual_enabled: true })
    const ov = await getChannelProductOverview(COMPANY, 1, deps())
    const v11 = ov.variations.find((v) => v.id === 11)!
    expect(v11.listings).toHaveLength(1)
    expect(v11.listings[0].last_attempt?.stage).toBe('validate')
    expect(v11.listings[0].attempt_outdated).toEqual(['preço mudou (49.9 → 59.9)', 'quantidade mudou (7 → 3)'])
    expect(ov.variations.find((v) => v.id === 12)!.listings).toEqual([])
  })
  it('R7. categoria de moda: SIZE_GRID_ID (comum) + SIZE_GRID_ROW_ID (por variação) chegam ao validate e publicam', async () => {
    api.requireSizeGrid = true
    const miss = await publishListings(session, publishInput(1, [11]), deps())
    expect((miss.results[0] as { message: string }).message).toMatch(/missing\.fashion_grid\.grid_id/)
    expect(toListingView(repo.rows[0]).can_publish).toBe(true)
    const ok = await publishListings(session, {
      ...publishInput(1, [11]),
      commonAttributes: [...attrs, { id: 'SIZE_GRID_ID', value_name: '5001' }],
      variations: [{ productVariationId: 11, attributes: [{ id: 'SIZE', value_name: 'M' }, { id: 'SIZE_GRID_ROW_ID', value_name: '5001:2' }] }],
    }, deps())
    expect(ok.results[0].status).toBe('published')
    const item = api.item(repo.rows[0].external_listing_id!)!
    expect(item.attributes).toEqual(expect.arrayContaining([{ id: 'SIZE_GRID_ID', value_name: '5001' }, { id: 'SIZE_GRID_ROW_ID', value_name: '5001:2' }]))
    expect(repo.rows).toHaveLength(1)
  })
})

describe('tabela de medidas criada no fluxo → publicação', () => {
  const mlDeps = () => ({ config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} })
  const chartInput = {
    domainId: 'MLB-BRAS', name: 'Item de Teste ML Feminino', measureType: 'BODY_MEASURE', mainAttributeId: 'SIZE',
    attributes: [{ id: 'GENDER', value_name: 'Feminino' }, { id: 'BRAND', value_name: 'TEST' }],
    rows: ['P', 'M', 'G', 'GG'].map((sz, i) => ({ SIZE: { value_name: sz }, BUST_CIRCUMFERENCE_FROM: { value_name: String(80 + i * 4) }, FILTRABLE_SIZE: { value_name: sz } })),
  }

  beforeEach(() => {
    api.requireSizeGrid = true
    api.sizeCharts = {} // conta TEST sem nenhuma tabela
    products[0].variations = [
      { id: 11, sku: 'TEST-ML-NORMAL-01-P', price_override: null, active: true, color: 'Preto', size: 'P' },
      { id: 12, sku: 'TEST-ML-NORMAL-01-GG', price_override: null, active: true, color: 'Preto', size: 'GG' },
    ]
    availability.set(12, { sellable_quantity: 3, manual_enabled: true })
  })

  it('conta real: criação de tabela bloqueada (mesma trava da publicação), nada enviado ao ML', async () => {
    await expect(createSizeChartForChannel({ ...channel(), isTestAccount: false }, chartInput, mlDeps())).rejects.toMatchObject({ code: 'real_account_blocked' })
    expect(api.chartCreates).toHaveLength(0)
  })

  it('sem tabela → cria P/M/G/GG → busca acha → linhas por variação → validate → publica com SIZE_GRID_ID + SIZE_GRID_ROW_ID', async () => {
    const ctxMl = { integrationId, companyId: COMPANY, deps: mlDeps() }
    expect(await searchSizeCharts(ctxMl, { domainId: 'MLB-BRAS', siteId: 'MLB', sellerId: '555', attributes: [{ id: 'GENDER', value_name: 'Feminino' }] })).toEqual([])

    // falta de dado exigido pela ficha → erro de formulário, nada criado
    await expect(createSizeChartForChannel(channel(), { ...chartInput, attributes: [{ id: 'GENDER', value_name: 'Feminino' }] }, mlDeps()))
      .rejects.toMatchObject({ code: 'missing_attributes' })
    expect(api.chartCreates).toHaveLength(0)

    const chart = await createSizeChartForChannel(channel(), chartInput, mlDeps())
    expect(chart.rows).toHaveLength(4)
    const found = await searchSizeCharts(ctxMl, { domainId: 'MLB-BRAS', siteId: 'MLB', sellerId: '555', attributes: [{ id: 'GENDER', value_name: 'Feminino' }] })
    expect(found.map((c) => c.id)).toEqual([chart.id])

    const rowP = matchSizeChartRow(chart.rows, 'P')!
    const rowGG = matchSizeChartRow(chart.rows, 'GG')!
    const { results } = await publishListings(session, {
      productId: 1, categoryId: 'MLB1234', domainId: 'MLB-BRAS', requiredAttributeIds: ['BRAND', 'MODEL'],
      commonAttributes: [...attrs, { id: 'SIZE_GRID_ID', value_name: chart.id }],
      variations: [
        { productVariationId: 11, attributes: [{ id: 'SIZE', value_name: 'P' }, { id: 'SIZE_GRID_ROW_ID', value_name: rowP.id }] },
        { productVariationId: 12, attributes: [{ id: 'SIZE', value_name: 'GG' }, { id: 'SIZE_GRID_ROW_ID', value_name: rowGG.id }] },
      ],
    }, deps())
    expect(results.map((r) => r.status)).toEqual(['published', 'published'])
    // validate rodou antes de cada POST /items, com os atributos da tabela
    const validates = api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items/validate'))
    expect(validates).toHaveLength(2)
    expect(JSON.parse(validates[1].body!).attributes).toEqual(expect.arrayContaining([{ id: 'SIZE_GRID_ID', value_name: chart.id }, { id: 'SIZE_GRID_ROW_ID', value_name: rowGG.id }]))
    const item = api.item(repo.rows.find((r) => r.product_variation_id === 12)!.external_listing_id!)!
    expect(item.attributes).toEqual(expect.arrayContaining([{ id: 'SIZE_GRID_ROW_ID', value_name: rowGG.id }, { id: 'SELLER_SKU', value_name: 'TEST-ML-NORMAL-01-GG' }]))
  })

  it('linha trocada (SIZE ≠ linha) → só aviso, publica e registra', async () => {
    const chart = await createSizeChartForChannel(channel(), chartInput, mlDeps())
    const { results } = await publishListings(session, {
      productId: 1, categoryId: 'MLB1234', requiredAttributeIds: ['BRAND'],
      commonAttributes: [...attrs, { id: 'SIZE_GRID_ID', value_name: chart.id }],
      variations: [{ productVariationId: 11, attributes: [{ id: 'SIZE', value_name: 'P' }, { id: 'SIZE_GRID_ROW_ID', value_name: matchSizeChartRow(chart.rows, 'M')!.id }] }],
    }, deps())
    expect(results[0].status).toBe('published')
    expect(repo.rows[0].last_error).toMatch(/Attribute \[SIZE\] is not valid/)
  })
})

describe('1 variação → N ofertas no mesmo canal', () => {
  const posts = () => api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/items'))

  it('M1. Clássico + Premium da mesma variação: 2 anúncios, preço próprio, MESMA quantidade (estoque-mãe)', async () => {
    await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_special' }, deps())
    const r = await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_pro',
      variations: [{ productVariationId: 11, channelPrice: 44.9, attributes: [{ id: 'SIZE', value_name: 'M' }] }] }, deps())
    expect(r.results[0].status).toBe('published')
    expect(repo.rows.map((x) => [x.offer_key, x.listing_type_id, x.channel_price])).toEqual([['gold_special', 'gold_special', null], ['gold_pro', 'gold_pro', 44.9]])
    const items = posts().map((c) => JSON.parse(c.body!))
    expect(items.map((b) => [b.listing_type_id, b.price, b.available_quantity])).toEqual([['gold_special', 49.9, 7], ['gold_pro', 44.9, 7]])
    expect(items.every((b) => b.attributes.some((a: { id: string; value_name: string }) => a.id === 'SELLER_SKU' && a.value_name === 'SUT-PRETO-M'))).toBe(true)
  })

  it('M2. idempotência POR OFERTA: repetir a mesma oferta não duplica; offer_key própria permite 2ª oferta do mesmo tipo', async () => {
    await publishListings(session, publishInput(1, [11]), deps())
    const again = await publishListings(session, publishInput(1, [11]), deps())
    expect(again.results[0]).toMatchObject({ status: 'skipped', reason: 'already_published' })
    expect(posts()).toHaveLength(1)
    const promo = await publishListings(session, { ...publishInput(1, [11]), offerKey: 'Promo 41,90',
      variations: [{ productVariationId: 11, channelPrice: 41.9, attributes: [{ id: 'SIZE', value_name: 'M' }] }] }, deps())
    expect(promo.results[0].status).toBe('published')
    expect(repo.rows.map((x) => x.offer_key)).toEqual(['gold_special', 'promo-41-90'])
    expect(posts()).toHaveLength(2)
  })

  it('M3. kit com 2 ofertas: ambas usam a disponibilidade derivada do kit', async () => {
    await publishListings(session, publishInput(2, [21]), deps())
    await publishListings(session, { ...publishInput(2, [21]), listingTypeId: 'gold_pro' }, deps())
    expect(posts().map((c) => JSON.parse(c.body!).available_quantity)).toEqual([4, 4])
    availability.set(21, { sellable_quantity: 1, manual_enabled: true })
    for (const row of repo.rows) await syncListing(COMPANY, row.id, deps(), { quantityOnly: true })
    expect([...api.items.values()].map((i) => i.available_quantity)).toEqual([1, 1])
  })

  it('M4. pausar/sincronizar uma oferta não mexe na outra (status próprio)', async () => {
    await publishListings(session, publishInput(1, [11]), deps())
    await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_pro' }, deps())
    await pauseListing(COMPANY, repo.rows[0].id, deps())
    expect(repo.rows.map((x) => x.local_status)).toEqual(['paused', 'active'])
  })

  it('M5. reconciliação multi-oferta: desempata pelo tipo de anúncio da oferta, nunca no chute', async () => {
    await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_pro' }, deps())   // oferta Premium vinculada
    // Clássico: ML criou o item mas o vínculo caiu (lease vencido); existe OUTRO item órfão de outro tipo
    await repo.begin({ companyId: COMPANY, integrationId, provider: 'mercadolivre', productId: 1, productVariationId: 11, sellerSku: 'SUT-PRETO-M',
      attemptId: 'a1', leaseSeconds: 10, channelPrice: null, metadata: { listing_type_id: 'gold_special', category_id: 'MLB1234' }, userId: USER,
      offerKey: 'gold_special', listingTypeId: 'gold_special' })
    const classic = repo.rows[1]
    classic.publish_lease_until = new Date(Date.now() - 1000).toISOString()
    const adapter = deps().adapterFor!(channel())
    const base = { sellerSku: 'SUT-PRETO-M', productName: 'X', title: 'X', description: null, categoryId: 'MLB1234', price: 49.9, currencyId: 'BRL', quantity: 7, pictureUrls: [JPG],
      attributes: [{ id: 'BRAND', value_name: 'X' }, { id: 'MODEL', value_name: 'Y' }, { id: 'SIZE', value_name: 'M' }] }
    const orphanClassic = await adapter.publishListing({ ...base, channelOptions: { listing_type_id: 'gold_special' } })
    await adapter.publishListing({ ...base, channelOptions: { listing_type_id: 'gold_premium_extra' } })
    const rec = await reconcileListing(COMPANY, classic.id, deps())
    expect(rec).toMatchObject({ outcome: 'attached', externalListingId: orphanClassic.externalListingId })
  })

  it('M6. overview lista TODAS as ofertas da variação', async () => {
    await publishListings(session, publishInput(1, [11]), deps())
    await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_pro',
      variations: [{ productVariationId: 11, channelPrice: 44.9, attributes: [{ id: 'SIZE', value_name: 'M' }] }] }, deps())
    const ov = await getChannelProductOverview(COMPANY, 1, deps())
    const v11 = ov.variations.find((v) => v.id === 11)!
    expect(v11.listings.map((l) => [l.offer_key, l.effective_price])).toEqual([['gold_special', 49.9], ['gold_pro', 44.9]])
    expect(v11.price).toBe(49.9)
  })
})

describe('Fase 4 — gestão comercial por oferta', () => {
  const mlDeps = () => ({ config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} })
  const withFees = () => deps({ estimateFee: (ctx, input) => estimateListingFee({ integrationId: ctx.integrationId, companyId: ctx.companyId, deps: mlDeps() }, ctx.siteId, input) })
  async function twoOffers() {
    await publishListings(session, publishInput(1, [11]), deps())
    await publishListings(session, { ...publishInput(1, [11]), listingTypeId: 'gold_pro',
      variations: [{ productVariationId: 11, channelPrice: 44.9, attributes: [{ id: 'SIZE', value_name: 'M' }] }] }, deps())
    return { a: repo.rows[0], b: repo.rows[1] }
  }
  const itemOf = (row: { external_listing_id: string | null }) => api.item(row.external_listing_id!)!

  it('F1. preço independente: muda só a oferta A (produto, oferta B intactos); só depois da confirmação do canal', async () => {
    const { a, b } = await twoOffers()
    const r = await updateListingPrice(COMPANY, a.id, 39.9, USER, deps())
    expect(r.result).toBe('applied')
    expect(repo.rows[0]).toMatchObject({ channel_price: 39.9, last_sent_price: 39.9, last_error: null })
    expect(itemOf(a).price).toBe(39.9)
    expect(repo.rows[1]).toMatchObject({ channel_price: 44.9, last_sent_price: 44.9 })
    expect(itemOf(b).price).toBe(44.9)
    expect(products[0].base_price).toBe(49.9)
    const hist = (repo.rows[0].metadata.price_history as Array<Record<string, unknown>>)
    expect(hist).toEqual([expect.objectContaining({ previous: 49.9, requested: 39.9, result: 'applied', channel_price_after: 39.9, error: null, user_id: USER })])
    // sync posterior mantém o preço da oferta (não volta ao do produto)
    await syncListing(COMPANY, a.id, deps())
    expect(itemOf(a).price).toBe(39.9)
  })

  it('F2. canal não aplica o preço (automação) → não vira sucesso local; histórico e erro registrados', async () => {
    const { a } = await twoOffers()
    api.priceAutomation = true
    const r = await updateListingPrice(COMPANY, a.id, 35, USER, deps())
    expect(r.result).toBe('not_applied')
    expect(repo.rows[0].channel_price).toBeNull()
    expect(repo.rows[0].last_error).toMatch(/não aplicou o preço/)
    expect((repo.rows[0].metadata.price_history as Array<Record<string, unknown>>).at(-1)).toMatchObject({ result: 'not_applied', requested: 35 })
  })

  it('F3. erro do canal → propaga; channel_price inalterado; falha no histórico', async () => {
    const { a } = await twoOffers()
    api.overrides.push({ match: (m, u) => m === 'PUT' && u.pathname.startsWith('/items/'), once: true, response: () => new Response('{"message":"boom"}', { status: 503 }) })
    await expect(updateListingPrice(COMPANY, a.id, 41.9, USER, deps())).rejects.toMatchObject({ name: 'MercadoLivreError' })
    expect(repo.rows[0].channel_price).toBeNull()
    expect((repo.rows[0].metadata.price_history as Array<Record<string, unknown>>).at(-1)).toMatchObject({ result: 'failed', requested: 41.9 })
  })

  it('F4. preço inválido é recusado antes de chamar o canal', async () => {
    const { a } = await twoOffers()
    const puts = () => api.calls.filter((c) => c.method === 'PUT').length
    const before = puts()
    await expect(updateListingPrice(COMPANY, a.id, 0, USER, deps())).rejects.toMatchObject({ code: 'invalid_price' })
    await expect(updateListingPrice(COMPANY, a.id, 10.123, USER, deps())).rejects.toMatchObject({ code: 'invalid_price' })
    expect(puts()).toBe(before)
  })

  it('F5. pausar e reativar uma oferta não afeta a outra', async () => {
    const { a, b } = await twoOffers()
    await pauseListing(COMPANY, b.id, deps())
    expect(repo.rows.map((x) => x.local_status)).toEqual(['active', 'paused'])
    expect(itemOf(a).status).toBe('active')
    await activateListing(COMPANY, b.id, deps())
    expect(repo.rows.map((x) => x.local_status)).toEqual(['active', 'active'])
    expect(itemOf(b).status).toBe('active')
  })

  it('F6. estoque compartilhado: nova disponibilidade vai igual para TODAS as ofertas', async () => {
    const { a, b } = await twoOffers()
    availability.set(11, { sellable_quantity: 5, manual_enabled: true })
    for (const row of [a, b]) await syncListing(COMPANY, row.id, deps(), { quantityOnly: true })
    expect([itemOf(a).available_quantity, itemOf(b).available_quantity]).toEqual([5, 5])
    expect(repo.rows.map((x) => x.synced_quantity)).toEqual([5, 5])
  })

  it('F7. tarifa ESTIMADA vem da API por tipo/categoria/preço e não grava nada (nem anúncio, nem financeiro)', async () => {
    const { a, b } = await twoOffers()
    const snapshot = JSON.stringify(repo.rows)
    const estA = await estimateListingOfferFee(COMPANY, a.id, null, withFees())
    const estB = await estimateListingOfferFee(COMPANY, b.id, 60, withFees())
    expect(estA).toMatchObject({ listing_type_id: 'gold_special', price: 49.9, sale_fee_amount: 12.24, estimated_net: 37.66, percentage_fee: 12, fixed_fee: 6.25 })
    expect(estB).toMatchObject({ listing_type_id: 'gold_pro', price: 60, sale_fee_amount: 16.45, financing_add_on_fee: 5 })
    expect(JSON.stringify(repo.rows)).toBe(snapshot)
    const call = api.calls.find((c) => c.url.includes('/listing_prices'))!
    expect(new URL(call.url).searchParams.get('category_id')).toBe('MLB1234')
  })

  it('F8. conta REAL: edição de preço/pausa bloqueadas (mesma trava da publicação)', async () => {
    const { a } = await twoOffers()
    const real = deps({ resolveChannel: async () => ({ ...channel(), isTestAccount: false }) })
    await expect(updateListingPrice(COMPANY, a.id, 30, USER, real)).rejects.toMatchObject({ code: 'real_account_blocked' })
    await expect(pauseListing(COMPANY, a.id, real)).rejects.toMatchObject({ code: 'real_account_blocked' })
    expect(itemOf(a).price).toBe(49.9)
  })

  it('F9. tenant: outra empresa não edita preço nem estima oferta alheia', async () => {
    const { a } = await twoOffers()
    await expect(updateListingPrice(OTHER, a.id, 30, USER, deps())).rejects.toMatchObject({ code: 'not_found' })
    await expect(estimateListingOfferFee(OTHER, a.id, null, withFees())).rejects.toMatchObject({ code: 'not_found' })
  })

  it('F10. renomear produto/variação/título e divergir o SKU NÃO quebra sync nem vínculo (ids persistidos)', async () => {
    const { a } = await twoOffers()
    products[0].name = 'Nome Totalmente Novo'
    products[0].variations[0].sku = 'SKU-RENOMEADO'
    products[0].variations[0].color = 'Grafite'
    itemOf(a).title = 'Título alterado no ML'
    availability.set(11, { sellable_quantity: 2, manual_enabled: true })
    await syncListing(COMPANY, a.id, deps(), { quantityOnly: true })
    expect(itemOf(a).available_quantity).toBe(2)
    expect(repo.rows[0]).toMatchObject({ external_listing_id: a.external_listing_id, product_variation_id: 11, seller_sku: 'SUT-PRETO-M' })
  })

  it('F11. métricas por oferta com custos REAIS; vendas sem oferta identificada ficam à parte', async () => {
    const { a, b } = await twoOffers()
    const rows: OfferSaleRow[] = [
      { channel_order_id: 1, channel_listing_id: a.id, product_variation_id: 11, quantity: 2, unit_price: 39.9, sale_fee: 9.58, order_gross: 79.8, order_fees: 9.58, order_shipping: 6, order_other: 0 },
      { channel_order_id: 2, channel_listing_id: b.id, product_variation_id: 11, quantity: 1, unit_price: 44.9, sale_fee: null, order_gross: 44.9, order_fees: 7.63, order_shipping: 0, order_other: 0 },
      { channel_order_id: 3, channel_listing_id: null, product_variation_id: 11, quantity: 1, unit_price: 50, sale_fee: 8.5, order_gross: 50, order_fees: 8.5, order_shipping: 0, order_other: 0 },
    ]
    const m = aggregateOfferMetrics(rows)
    expect(m.get(a.id)).toEqual({ units: 2, orders: 1, gross: 79.8, fees: 9.58, shipping_and_costs: 6, net: 64.22, avg_ticket: 79.8 })
    expect(m.get(b.id)).toMatchObject({ units: 1, fees: 7.63, net: 37.27 })
    const ov = await getChannelProductOverview(COMPANY, 1, deps({ loadOrderItems: async () => rows }))
    const v11 = ov.variations.find((v) => v.id === 11)!
    expect(v11.listings.map((l) => l.metrics?.units)).toEqual([2, 1])
    expect(v11.unidentified_offer_metrics).toMatchObject({ units: 1, gross: 50 })
  })
})

describe('sincronização, pausa e reativação', () => {
  async function published(variationId = 11) {
    await publishListings(session, publishInput(variationId === 21 ? 2 : 1, [variationId]), deps())
    return repo.rows.find((r) => r.product_variation_id === variationId)!
  }

  it('18. sincronizar: quantidade ABSOLUTA atual + preço só se mudou', async () => {
    const row = await published()
    availability.set(11, { sellable_quantity: 3, manual_enabled: true })
    const puts = () => api.calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body!))
    await syncListing(COMPANY, row.id, deps())
    expect(puts()).toEqual([{ available_quantity: 3 }])
    expect(repo.rows[0]).toMatchObject({ synced_quantity: 3 })
    products[0].base_price = 52.9
    await syncListing(COMPANY, row.id, deps())
    expect(puts().slice(1)).toEqual([{ available_quantity: 3 }, { price: 52.9 }])
    expect(repo.rows[0].last_sent_price).toBe(52.9)
  })

  it('18b. fan-out de estoque (quantityOnly): envia só a quantidade, nunca o preço', async () => {
    const row = await published()
    availability.set(11, { sellable_quantity: 2, manual_enabled: true })
    products[0].base_price = 99
    await syncListing(COMPANY, row.id, deps(), { quantityOnly: true })
    const puts = api.calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body!))
    expect(puts).toEqual([{ available_quantity: 2 }])
  })

  it('19. kit: sincronização usa a disponibilidade derivada (camada central)', async () => {
    const row = await published(21)
    availability.set(21, { sellable_quantity: 1, manual_enabled: true })
    await syncListing(COMPANY, row.id, deps())
    expect(api.item(row.external_listing_id!)!.available_quantity).toBe(1)
  })

  it('20. quantidade zero → ML pausa por falta de estoque; local continua active; repor reativa', async () => {
    const row = await published()
    availability.set(11, { sellable_quantity: 0, manual_enabled: true })
    await syncListing(COMPANY, row.id, deps())
    expect(repo.rows[0]).toMatchObject({ local_status: 'active', external_status: 'paused', external_sub_status: ['out_of_stock'], synced_quantity: 0 })
    availability.set(11, { sellable_quantity: 2, manual_enabled: true })
    await syncListing(COMPANY, row.id, deps())
    expect(repo.rows[0]).toMatchObject({ local_status: 'active', external_status: 'active' })
  })

  it('21. desativado no Qarvon → sync envia 0 e não reativa', async () => {
    const row = await published()
    products[0].variations[0].active = false
    await syncListing(COMPANY, row.id, deps())
    expect(api.item(row.external_listing_id!)!.available_quantity).toBe(0)
    await expect(activateListing(COMPANY, row.id, deps())).rejects.toMatchObject({ code: 'manual_disabled' })
  })

  it('22. pausar → paused_by_seller; sync com estoque NÃO reativa; reativar volta a active', async () => {
    const row = await published()
    await pauseListing(COMPANY, row.id, deps())
    expect(repo.rows[0]).toMatchObject({ local_status: 'paused', external_sub_status: ['paused_by_seller'] })
    availability.set(11, { sellable_quantity: 10, manual_enabled: true })
    await syncListing(COMPANY, row.id, deps())
    expect(repo.rows[0]).toMatchObject({ local_status: 'paused', external_status: 'paused' })
    await activateListing(COMPANY, row.id, deps())
    expect(repo.rows[0]).toMatchObject({ local_status: 'active', external_status: 'active' })
  })

  it('23. preço ignorado pela automação do ML → aviso registrado, last_sent_price não finge sucesso', async () => {
    const row = await published()
    api.priceAutomation = true
    products[0].base_price = 45
    await syncListing(COMPANY, row.id, deps())
    expect(repo.rows[0].last_sent_price).toBe(49.9)
    expect(repo.rows[0].last_error).toMatch(/preço não aplicado|automation/)
  })

  it('24. multi-tenant: outra empresa não sincroniza/pausa/reconcilia anúncio alheio', async () => {
    const row = await published()
    await expect(syncListing(OTHER, row.id, deps())).rejects.toMatchObject({ code: 'not_found' })
    await expect(pauseListing(OTHER, row.id, deps())).rejects.toMatchObject({ code: 'not_found' })
    await expect(reconcileListing(OTHER, row.id, deps())).rejects.toMatchObject({ code: 'not_found' })
  })

  it('25. erro do ML na sincronização → last_error gravado e erro propagado', async () => {
    const row = await published()
    api.overrides.push({ match: (m, u) => m === 'PUT' && u.pathname.startsWith('/items/'), response: () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }), once: true })
    await expect(syncListing(COMPANY, row.id, deps())).rejects.toMatchObject({ name: 'MercadoLivreError' })
    expect(repo.rows[0].last_error).toMatch(/retryable|500/)
  })
})
