import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { buildItemBody, normalizeAttributes, parseItem, suggestAttributeValues, validatePictureUrls } from './listingPayload'
import { clearMercadoLivreCatalogCache, getCategoryAttributes, getCategoryDetails, missingRequiredAttributes, normalizeAttribute, searchCategories, checkConditionalAttributes } from './catalog'
import { createMercadoLivreAdapter, listingModelFromTags } from './adapter'
import { setMercadoLivreLogSink } from './log'
import { FakeMlDb, TEST_CONFIG, setTestCipherEnv } from './fakeMercadoLivre.testutil'
import { FakeMlMarket } from './fakeMlMarket.testutil'
import { resolveLocalStatus, type ChannelListingDraft } from '@/lib/channels/types'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
let db: FakeMlDb
let api: FakeMlMarket
let integrationId: number
let logs: string[]

function deps() {
  return { config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} }
}
const ctx = () => ({ integrationId, companyId: COMPANY, deps: deps() })

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlMarket()
  const pair = api.issue()
  integrationId = db.seedConnected(COMPANY, String(api.me.id), { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  logs = []
  setMercadoLivreLogSink((l) => logs.push(l))
  clearMercadoLivreCatalogCache()
})
afterEach(() => setMercadoLivreLogSink(null))

const draft = (over: Partial<ChannelListingDraft> = {}): ChannelListingDraft => ({
  sellerSku: 'SUT-PRETO-M',
  productName: 'Sutiã Renda Teste',
  title: 'Sutiã Renda Teste Preto M',
  description: 'Descrição de teste',
  categoryId: 'MLB1234',
  price: 59.9,
  currencyId: 'BRL',
  quantity: 7,
  pictureUrls: ['https://cdn.example.com/media-public/a.jpg'],
  attributes: [{ id: 'BRAND', value_name: 'Santtorini' }, { id: 'MODEL', value_name: 'Renda' }, { id: 'SIZE', value_name: 'M' }],
  channelOptions: { listing_type_id: 'gold_special' },
  ...over,
})

// ─── payload puro ────────────────────────────────────────────────────────────

describe('listingPayload', () => {
  it('User Products: envia family_name, nunca title nem variations', () => {
    const body = buildItemBody(draft(), 'user_products')
    expect(body.family_name).toBe('Sutiã Renda Teste')
    expect(body).not.toHaveProperty('title')
    expect(body).not.toHaveProperty('variations')
    expect(body).toMatchObject({ category_id: 'MLB1234', price: 59.9, currency_id: 'BRL', available_quantity: 7, buying_mode: 'buy_it_now', listing_type_id: 'gold_special', condition: 'new' })
  })

  it('legado: envia title truncado no limite da categoria', () => {
    const body = buildItemBody(draft({ title: 'X'.repeat(80) }), 'legacy', 60)
    expect(body.title).toHaveLength(60)
    expect(body).not.toHaveProperty('family_name')
  })

  it('SELLER_SKU sempre = SKU vendável (não aceita sobrescrita), vazios e duplicados removidos', () => {
    const attrs = normalizeAttributes([
      { id: 'seller_sku', value_name: 'COMPONENTE-1' }, { id: 'BRAND', value_name: '' }, { id: 'COLOR', value_name: 'Azul' }, { id: 'COLOR', value_id: '52049', value_name: 'Preto' },
    ], 'KIT-001')
    expect(attrs).toEqual([{ id: 'COLOR', value_id: '52049', value_name: 'Preto' }, { id: 'SELLER_SKU', value_name: 'KIT-001' }])
  })

  it('quantidade é absoluta e nunca negativa', () => {
    expect(buildItemBody(draft({ quantity: -3 }), 'user_products').available_quantity).toBe(0)
    expect(buildItemBody(draft({ quantity: 4.9 }), 'user_products').available_quantity).toBe(4)
  })

  it('imagens: aceita JPG/PNG públicas; recusa webp, URL assinada e não-http', () => {
    const r = validatePictureUrls([
      'https://x.supabase.co/storage/v1/object/public/media-public/a.JPG',
      'https://cdn.example.com/b.png',
      'https://cdn.example.com/c.webp',
      'https://x.supabase.co/storage/v1/object/sign/media-private/d.jpg?token=abc',
      'ftp://cdn.example.com/e.jpg',
      'não é url',
    ])
    expect(r.valid).toHaveLength(2)
    expect(r.invalid.map((i) => i.reason)).toEqual([
      expect.stringContaining('.webp'), expect.stringContaining('assinada'), expect.stringContaining('http'), 'URL inválida',
    ])
  })

  it('parseItem extrai ids do User Products, sub_status, SKU e warnings', () => {
    const snap = parseItem({
      id: 'MLB1', user_product_id: 'MLBU2', family_name: 'Sutiã', status: 'paused', sub_status: ['out_of_stock'], price: 10, available_quantity: 0,
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU1' }], warnings: [{ code: 'w', message: 'aviso ml' }], permalink: 'https://p',
    }, { familyId: '99' })
    expect(snap).toMatchObject({
      externalListingId: 'MLB1', externalProductId: 'MLBU2', externalGroupId: '99', externalStatus: 'paused', externalSubStatus: ['out_of_stock'],
      sellerSku: 'SKU1', quantity: 0, warnings: ['aviso ml'], externalIds: { user_product_id: 'MLBU2', family_name: 'Sutiã', family_id: '99' },
    })
  })

  it('sugestões por semântica (BRAND/MODEL/COLOR/SIZE) casando value_id da lista', () => {
    const s = suggestAttributeValues(
      [{ id: 'BRAND', values: [] }, { id: 'COLOR', values: [{ id: '52049', name: 'Preto' }] }, { id: 'SIZE', values: [] }, { id: 'FABRIC', values: [] }],
      { brand: 'Santtorini', model: null, color: 'preto', size: 'M' },
    )
    expect(s).toEqual([
      { id: 'BRAND', value_name: 'Santtorini' },
      { id: 'COLOR', value_id: '52049', value_name: 'Preto' },
      { id: 'SIZE', value_name: 'M' },
    ])
  })

  it('status local × externo: pausa manual nunca desfeita; out_of_stock não é pausa manual', () => {
    expect(resolveLocalStatus('paused', 'active', [])).toBe('paused')
    expect(resolveLocalStatus('active', 'paused', ['out_of_stock'])).toBe('active')
    expect(resolveLocalStatus('active', 'paused', ['paused_by_seller'])).toBe('paused')
    expect(resolveLocalStatus('publishing', 'active', [])).toBe('active')
    expect(resolveLocalStatus('active', 'closed', [])).toBe('closed')
  })

  it('modelo pelo tag user_product_seller', () => {
    expect(listingModelFromTags(['normal', 'user_product_seller'])).toBe('user_products')
    expect(listingModelFromTags(['normal'])).toBe('legacy')
    expect(listingModelFromTags(undefined)).toBe('legacy')
  })
})

// ─── catálogo ───────────────────────────────────────────────────────────────

describe('catalog', () => {
  it('busca categoria pelo preditor e normaliza sugestões', async () => {
    const s = await searchCategories(ctx(), 'MLB', 'sutiã renda', 5)
    expect(s[0]).toMatchObject({ category_id: 'MLB1234', category_name: 'Sutiãs', suggested_attributes: [{ id: 'GENDER', value_id: '339665' }] })
    expect(await searchCategories(ctx(), 'MLB', 'a')).toEqual([])
  })

  it('atributos dinâmicos: filtra read_only/fixed/SELLER_SKU, detecta variação e obrigatórios; cache TTL', async () => {
    const attrs = await getCategoryAttributes(ctx(), 'MLB1234')
    expect(attrs.map((a) => a.id)).toEqual(['BRAND', 'MODEL', 'COLOR', 'SIZE', 'GTIN', 'EMPTY_GTIN_REASON'])
    expect(attrs.find((a) => a.id === 'SIZE')).toMatchObject({ required: true, varies_by_variation: true })
    expect(attrs.find((a) => a.id === 'GTIN')).toMatchObject({ required: false, conditional_required: true })
    const before = api.calls.length
    await getCategoryAttributes(ctx(), 'MLB1234')
    expect(api.calls.length).toBe(before) // cache
    const details = await getCategoryDetails(ctx(), 'MLB1234')
    expect(details).toMatchObject({ listing_allowed: true, max_title_length: 60, children_count: 0 })
  })

  it('tags em array (technical_specs) também são aceitas', () => {
    expect(normalizeAttribute({ id: 'X', tags: ['required', 'variation_attribute'] })).toMatchObject({ required: true, varies_by_variation: true })
  })

  it('obrigatórios faltando; GTIN condicional satisfeito por EMPTY_GTIN_REASON', async () => {
    const defs = await getCategoryAttributes(ctx(), 'MLB1234')
    const extra = await checkConditionalAttributes(ctx(), 'MLB1234', { attributes: [{ id: 'BRAND', value_name: 'X' }] })
    expect(extra).toEqual(['GTIN'])
    expect(missingRequiredAttributes(defs, [{ id: 'BRAND', value_name: 'X' }], extra)).toEqual(['GTIN', 'MODEL', 'SIZE'])
    expect(missingRequiredAttributes(defs, [
      { id: 'BRAND', value_name: 'X' }, { id: 'MODEL', value_name: 'Y' }, { id: 'SIZE', value_name: 'M' }, { id: 'EMPTY_GTIN_REASON', value_id: '17055160' },
    ], extra)).toEqual([])
  })
})

// ─── adapter ────────────────────────────────────────────────────────────────

describe('MercadoLivreAdapter', () => {
  const adapter = (model: 'user_products' | 'legacy' = 'user_products') =>
    createMercadoLivreAdapter({ integrationId, companyId: COMPANY, sellerId: String(api.me.id), model, deps: deps() })

  it('publica (UP): POST /items com family_name, descrição, family_id via /user-products; token nunca na URL', async () => {
    const snap = await adapter().publishListing(draft())
    expect(snap).toMatchObject({ externalStatus: 'active', sellerSku: 'SUT-PRETO-M', quantity: 7, price: 59.9 })
    expect(snap.externalProductId).toMatch(/^MLBU/)
    expect(snap.externalGroupId).toMatch(/^\d+$/)
    const item = api.item(snap.externalListingId)!
    expect(item.family_name).toBe('Sutiã Renda Teste')
    expect(item.description).toBe('Descrição de teste')
    for (const c of api.calls) expect(c.url).not.toMatch(/APP_USR|access_token/)
  })

  it('publica (legado): envia title; conta UP recusaria title', async () => {
    api.userProductsSeller = false
    const snap = await adapter('legacy').publishListing(draft())
    expect(api.item(snap.externalListingId)!.title).toBe('Sutiã Renda Teste Preto M')
    api.userProductsSeller = true
    await expect(adapter('legacy').publishListing(draft())).rejects.toMatchObject({ name: 'MercadoLivreError' })
  })

  it('quantidade 0 → paused/out_of_stock; reposição reativa sozinho; pausa manual não', async () => {
    const a = adapter()
    const snap = await a.publishListing(draft())
    const ref = { externalListingId: snap.externalListingId }
    expect(await a.updateQuantity(ref, 0)).toMatchObject({ externalStatus: 'paused', externalSubStatus: ['out_of_stock'], quantity: 0 })
    expect(await a.updateQuantity(ref, 3)).toMatchObject({ externalStatus: 'active', quantity: 3 })
    expect(await a.pauseListing(ref)).toMatchObject({ externalStatus: 'paused', externalSubStatus: ['paused_by_seller'] })
    expect(await a.updateQuantity(ref, 5)).toMatchObject({ externalStatus: 'paused', externalSubStatus: ['paused_by_seller'] })
    expect(await a.activateListing(ref)).toMatchObject({ externalStatus: 'active' })
  })

  it('preço: aplicado; com automação de preço do ML → warning', async () => {
    const a = adapter()
    const snap = await a.publishListing(draft())
    const ref = { externalListingId: snap.externalListingId }
    expect((await a.updatePrice(ref, 64.9)).price).toBe(64.9)
    api.priceAutomation = true
    const w = await a.updatePrice(ref, 70)
    expect(w.price).toBe(64.9)
    expect(w.warnings.join(' ')).toMatch(/preço não aplicado/)
    await expect(a.updatePrice(ref, 0)).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('reconciliação: busca por seller_sku e devolve só itens com o SKU exato', async () => {
    const a = adapter()
    await a.publishListing(draft())
    await a.publishListing(draft({ sellerSku: 'OUTRO' }))
    const found = await a.findListingsBySellerSku('SUT-PRETO-M')
    expect(found).toHaveLength(1)
    expect(found[0].sellerSku).toBe('SUT-PRETO-M')
    expect(found[0].externalGroupId).toBeTruthy()
  })

  it('validateListing: 204 → ok; 400 com cause → erros/warnings separados; nada criado', async () => {
    const a = adapter()
    expect(await a.validateListing!(draft())).toEqual({ ok: true, errors: [], warnings: [] })
    const bad = await a.validateListing!(draft({ categoryId: 'MLB9999', attributes: [] }))
    expect(bad.ok).toBe(false)
    expect(bad.errors.map((e) => e.code)).toEqual(['item.category_id.invalid', 'item.attributes.missing_required'])
    api.validateWarnings = [{ code: 'w1', message: 'só aviso' }]
    expect(await a.validateListing!(draft())).toEqual({ ok: true, errors: [], warnings: [{ code: 'w1', message: 'só aviso' }] })
    expect(api.items.size).toBe(0)
  })

  it('validateListing: 401 persistente/5xx continuam exceção (não viram "inválido")', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items/validate', response: () => new Response('{}', { status: 502 }), once: true })
    await expect(adapter().validateListing!(draft())).rejects.toMatchObject({ kind: 'server' })
  })

  it('causes do ML são redigidas (sem token) e ficam no erro tipado', async () => {
    api.overrides.push({ match: (m, u) => m === 'POST' && u.pathname === '/items', once: true, response: () => new Response(JSON.stringify({ message: 'x', status: 400, cause: [{ type: 'error', code: 'c1', message: 'token APP_USR-123-abc vazou' }] }), { status: 400 }) })
    const err = await adapter().publishListing(draft()).catch((e) => e)
    expect(err.causes).toEqual([{ type: 'error', code: 'c1', message: 'token APP_USR-[REDACTED] vazou' }])
  })

  it('imagem webp recusada pelo ML → erro tipado', async () => {
    await expect(adapter().publishListing(draft({ pictureUrls: ['https://cdn.example.com/a.webp'] }))).rejects.toMatchObject({ name: 'MercadoLivreError' })
  })
})
