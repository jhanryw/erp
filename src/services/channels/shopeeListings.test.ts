/**
 * Shopee pelo núcleo GENÉRICO real (listings.service.publishListings):
 * lease/idempotência, persistência em channel_listings (repo em memória com
 * a semântica das RPCs), adaptador Shopee real sobre HTTP Shopee FAKE.
 * Nenhuma chamada de rede real.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { ListingError, publishListings, type AvailabilityInfo, type ChannelContext, type ListingsServiceDeps, type ProductSource, type PublishInput } from './listings.service'
import { MemoryRepo } from './memoryListingsRepo.testutil'
import { getShopeePublishRequirements, resolveShopeeChannel } from './shopeeChannel'
import { createShopeeAdapter } from '@/lib/integrations/shopee/adapter'
import { FakeShopeeApi, FakeShopeeDb, TEST_CONFIG as SHOPEE_CONFIG, fakeImageDownloader, setTestCipherEnv } from '@/lib/integrations/shopee/fakeShopee.testutil'
import { setShopeeLogSink } from '@/lib/integrations/shopee/log'
import { createMercadoLivreAdapter } from '@/lib/integrations/mercadolivre/adapter'
import { setMercadoLivreLogSink } from '@/lib/integrations/mercadolivre/log'
import { FakeMlDb, TEST_CONFIG as ML_CONFIG } from '@/lib/integrations/mercadolivre/fakeMercadoLivre.testutil'
import { FakeMlMarket } from '@/lib/integrations/mercadolivre/fakeMlMarket.testutil'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const OTHER = 20
const USER = '00000000-0000-0000-0000-000000000001'
const SHOP_A = '700001'
const SHOP_B = '700002'
const JPG = 'https://x.supabase.co/storage/v1/object/public/media-public/p.jpg'
const JPG2 = 'https://x.supabase.co/storage/v1/object/public/media-public/p2.jpg'
const session = { companyId: COMPANY, userId: USER }

let sdb: FakeShopeeDb
let sapi: FakeShopeeApi
let shopA: number
let shopB: number
let shopOther: number
let mldb: FakeMlDb
let mlapi: FakeMlMarket
let mlIntegration: number
let repo: MemoryRepo
let products: Array<ProductSource & { company_id: number }>
let pictures: Record<number, string[]>
let pictureOpts: Array<{ allowLegacyPhotoUrl?: boolean } | undefined>
let downloader: ReturnType<typeof fakeImageDownloader>
const savedEnv = process.env.SHOPEE_LISTINGS_ALLOW_PUBLISH

function seedShop(companyId: number, shopId: string): number {
  const pair = sapi.issue(shopId)
  return sdb.seedConnected(companyId, shopId, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
}

function mlChannel(): ChannelContext {
  return { provider: 'mercadolivre', integrationId: mlIntegration, companyId: COMPANY, sellerId: String(mlapi.me.id), siteId: 'MLB', currencyId: 'BRL', model: 'user_products', accountLabel: 'LOJA_TESTE', isTestAccount: true }
}

function deps(over: Partial<ListingsServiceDeps> = {}): ListingsServiceDeps {
  return {
    repo,
    source: {
      loadProduct: async (companyId, productId) => products.find((p) => p.id === productId && p.company_id === companyId) ?? null,
      loadPictures: async (_c, _p, variationId, opts) => { pictureOpts.push(opts); return pictures[variationId] ?? [JPG] },
    },
    availability: async (_companyId, ids) => new Map<number, AvailabilityInfo>(ids.map((id) => [id, { sellable_quantity: 7, manual_enabled: true }])),
    resolveChannel: async (companyId, target) => {
      if (target?.provider === 'shopee') return resolveShopeeChannel(companyId, target.integrationId ?? 0, { repo: sdb.repo() })
      if (companyId !== COMPANY) throw new ListingError('not_connected', 'Mercado Livre não conectado.')
      return mlChannel()
    },
    adapterFor: (ctx) => ctx.provider === 'shopee'
      ? createShopeeAdapter({
          integrationId: ctx.integrationId, companyId: ctx.companyId, shopId: ctx.shopId!,
          deps: { config: SHOPEE_CONFIG, store: sdb.store(), fetchImpl: sapi.fetch, sleep: async () => {}, downloadImage: downloader.download },
        })
      : createMercadoLivreAdapter({
          integrationId: ctx.integrationId, companyId: ctx.companyId, sellerId: ctx.sellerId, model: 'user_products',
          deps: { config: ML_CONFIG, store: mldb.store(), fetchImpl: mlapi.fetch, sleep: async () => {} },
        }),
    ...over,
  }
}

function shopeeInput(integrationId: number, shopee: Record<string, unknown> = {}, over: Partial<PublishInput> = {}): PublishInput {
  return {
    target: { provider: 'shopee', integrationId },
    productId: 1,
    categoryId: '102',
    description: 'Sutiã de renda, confortável e sem aro.',
    variations: [{ productVariationId: 11 }],
    channelOptions: { shopee: { condition: 'NEW', weight_kg: 0.2, brand: { no_brand: true }, attributes: [{ attribute_id: 1001, values: [{ value_id: 12 }] }], ...shopee } },
    ...over,
  }
}

const addItems = () => sapi.shop.calls.filter((c) => c.path === '/api/v2/product/add_item').length

beforeEach(() => {
  process.env.SHOPEE_LISTINGS_ALLOW_PUBLISH = 'true'
  sdb = new FakeShopeeDb()
  sdb.nextId = 100 // ids distintos das integrações ML (mesma tabela company_integrations em produção)
  sapi = new FakeShopeeApi()
  shopA = seedShop(COMPANY, SHOP_A)
  shopB = seedShop(COMPANY, SHOP_B)
  shopOther = seedShop(OTHER, '700009')
  mldb = new FakeMlDb()
  mlapi = new FakeMlMarket()
  const pair = mlapi.issue()
  mlIntegration = mldb.seedConnected(COMPANY, String(mlapi.me.id), { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  repo = new MemoryRepo()
  pictures = {}
  pictureOpts = []
  downloader = fakeImageDownloader()
  products = [
    { id: 1, company_id: COMPANY, name: 'Sutiã Renda TESTE', base_price: 49.9, active: true, brand: 'Santtorini', model: 'Renda', is_kit: false,
      variations: [{ id: 11, sku: 'SUT-PRETO-M', price_override: null, active: true, color: null, size: null }] },
    { id: 3, company_id: COMPANY, name: 'Sem SKU', base_price: 10, active: true, brand: null, model: null, is_kit: false,
      variations: [{ id: 31, sku: '', price_override: null, active: true, color: null, size: null }] },
  ]
  setShopeeLogSink(() => {})
  setMercadoLivreLogSink(() => {})
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.SHOPEE_LISTINGS_ALLOW_PUBLISH
  else process.env.SHOPEE_LISTINGS_ALLOW_PUBLISH = savedEnv
  setShopeeLogSink(null)
  setMercadoLivreLogSink(null)
})

describe('Shopee — publicação simples pelo núcleo genérico', () => {
  it('sucesso: payload correto, item_id persistido, confirmação pós-publicação', async () => {
    const { results, channel } = await publishListings(session, shopeeInput(shopA), deps())
    expect(channel).toMatchObject({ provider: 'shopee', integrationId: shopA, shopId: SHOP_A })
    expect(results).toEqual([expect.objectContaining({ status: 'published', productVariationId: 11 })])

    const call = sapi.shop.addItemCalls[0]
    expect(sapi.shop.addItemCalls).toHaveLength(1)
    expect(call.shop_id).toBe(SHOP_A)
    expect(call.body).toMatchObject({
      original_price: 49.9, weight: 0.2, item_name: 'Sutiã Renda TESTE', item_sku: 'SUT-PRETO-M', category_id: 102, condition: 'NEW',
      seller_stock: [{ stock: 7 }], logistic_info: [{ logistic_id: 90001, enabled: true }], brand: { brand_id: 0, original_brand_name: 'No Brand' },
      attribute_list: [{ attribute_id: 1001, attribute_value_list: [{ value_id: 12 }] }], image: { image_id_list: [`img-${SHOP_A}-1`] },
    })
    expect(call.body).not.toHaveProperty('dimension')

    const row = repo.rows[0]
    const itemId = String(sapi.shop.items[0].item_id)
    expect(row).toMatchObject({
      provider: 'shopee', integration_id: shopA, product_variation_id: 11, seller_sku: 'SUT-PRETO-M', offer_key: 'default', listing_type_id: null,
      local_status: 'active', external_listing_id: itemId, external_product_id: itemId, external_variant_id: null, external_group_id: null,
      external_category_id: '102', external_status: 'active', channel_price: null, last_sent_price: 49.9, synced_quantity: 7, last_error: null,
    })
    expect(row.external_ids).toMatchObject({ item_id: itemId, shop_id: SHOP_A, image_ids: [`img-${SHOP_A}-1`], logistic_id: 90001, condition: 'NEW' })
    expect((row.metadata as Record<string, any>).channel_options.shopee).toMatchObject({ weight_kg: 0.2, condition: 'NEW' })
    // confirmação via get_item_base_info na MESMA loja
    expect(sapi.shop.calls.filter((c) => c.path === '/api/v2/product/get_item_base_info')).toEqual([{ path: '/api/v2/product/get_item_base_info', shop_id: SHOP_A }])
    // imagens só do Media Hub (sem fallback para products.photo_url)
    expect(pictureOpts[0]).toEqual({ allowLegacyPhotoUrl: false })
  })

  it('imagens: upload 1x por URL na mesma tentativa (sem duplicar)', async () => {
    pictures[11] = [JPG, JPG2, JPG]
    await publishListings(session, shopeeInput(shopA), deps())
    expect(sapi.shop.uploads).toHaveLength(2)
    expect(downloader.calls).toEqual([JPG, JPG2])
    expect(sapi.shop.addItemCalls[0].body.image).toEqual({ image_id_list: [`img-${SHOP_A}-1`, `img-${SHOP_A}-2`] })
  })

  it('dimensões completas vão no payload', async () => {
    await publishListings(session, shopeeInput(shopA, { dimension: { package_height: 4, package_length: 25, package_width: 18 } }), deps())
    expect(sapi.shop.addItemCalls[0].body.dimension).toEqual({ package_height: 4, package_length: 25, package_width: 18 })
  })

  it.each([
    ['categoria inválida', { }, { categoryId: '999' }, 'invalid_category'],
    ['categoria não-folha', { }, { categoryId: '101' }, 'category_not_leaf'],
    ['atributo obrigatório ausente', { attributes: [] }, {}, 'missing_attribute'],
    ['peso ausente', { weight_kg: null }, {}, 'missing_weight'],
    ['condition ausente', { condition: null }, {}, 'missing_condition'],
    ['dimensões incompletas', { dimension: { package_height: 3 } }, {}, 'incomplete_dimensions'],
    ['marca obrigatória ausente', { brand: null }, {}, 'missing_brand'],
    ['sem descrição', {}, { description: null }, 'missing_description'],
  ])('%s → validation_failed antes de qualquer upload/add_item; vínculo republicável', async (_n, shopee, over, code) => {
    const { results } = await publishListings(session, shopeeInput(shopA, shopee, over as Partial<PublishInput>), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect((results[0] as { message: string }).message).toContain(code)
    expect(addItems()).toBe(0)
    expect(sapi.shop.uploads).toHaveLength(0)
    expect(repo.rows[0]).toMatchObject({ local_status: 'draft', external_listing_id: null })
  })

  it('logística indisponível → validation_failed', async () => {
    sapi.shop.channels = sapi.shop.channels.map((c) => ({ ...c, enabled: false }))
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect((results[0] as { message: string }).message).toContain('logistics_unavailable')
    expect(addItems()).toBe(0)
  })

  it('SKU ausente → validation_failed missing_sku', async () => {
    const { results } = await publishListings(session, shopeeInput(shopA, {}, { productId: 3, variations: [{ productVariationId: 31 }] }), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'validation_failed' })
    expect((results[0] as { message: string }).message).toContain('missing_sku')
    expect(addItems()).toBe(0)
  })

  it('sem imagem → invalid_images (core) sem chamar a Shopee', async () => {
    pictures[11] = []
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'invalid_images' })
    expect(sapi.shop.calls).toHaveLength(0)
  })

  it('falha no upload (download ou upload_image) → nada criado → republicável; nenhum add_item', async () => {
    downloader = fakeImageDownloader({ failFor: [JPG] })
    let r = await publishListings(session, shopeeInput(shopA), deps())
    expect(r.results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect(repo.rows[0]).toMatchObject({ local_status: 'draft', external_listing_id: null })

    downloader = fakeImageDownloader()
    sapi.shop.fail.set('/api/v2/media_space/upload_image', 'server_error')
    r = await publishListings(session, shopeeInput(shopA), deps())
    expect(r.results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect(repo.rows[0]).toMatchObject({ local_status: 'draft' })
    expect(addItems()).toBe(0)

    sapi.shop.fail.delete('/api/v2/media_space/upload_image')
    r = await publishListings(session, shopeeInput(shopA), deps())
    expect(r.results[0]).toMatchObject({ status: 'published', listingId: repo.rows[0].id })
    expect(repo.rows).toHaveLength(1)
  })

  it('add_item recusado (400 ou error em HTTP 200) → rejeição definitiva → republicável', async () => {
    for (const mode of ['bad_request', 'error_200'] as const) {
      sapi.shop.fail.set('/api/v2/product/add_item', mode)
      const { results } = await publishListings(session, shopeeInput(shopA), deps())
      expect(results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
      expect(repo.rows[0]).toMatchObject({ local_status: 'draft', external_listing_id: null })
    }
    expect(sapi.shop.items).toHaveLength(0)
  })

  it.each([['timeout'], ['server_error'], ['no_item_id']] as const)('add_item %s (ambíguo) → error + reconciliação exigida; nova tentativa NÃO republica às cegas', async (mode) => {
    sapi.shop.createThenFail = true
    sapi.shop.fail.set('/api/v2/product/add_item', mode)
    const first = await publishListings(session, shopeeInput(shopA), deps())
    expect(first.results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect(repo.rows[0]).toMatchObject({ local_status: 'error', external_listing_id: null })
    expect((repo.rows[0].metadata as Record<string, any>).last_attempt.stage).toBe('create_unknown')
    expect(sapi.shop.items).toHaveLength(1) // o item EXISTE na Shopee

    sapi.shop.fail.delete('/api/v2/product/add_item')
    const retry = await publishListings(session, shopeeInput(shopA), deps())
    expect(retry.results[0]).toMatchObject({ status: 'failed', reason: 'needs_reconciliation' })
    expect(addItems()).toBe(1)
    expect(sapi.shop.items).toHaveLength(1)
  })

  it('lease vencido sem confirmação (processo caiu) → needs_reconciliation, sem novo add_item', async () => {
    await repo.begin({ companyId: COMPANY, integrationId: shopA, provider: 'shopee', productId: 1, productVariationId: 11, sellerSku: 'SUT-PRETO-M', attemptId: 'x', leaseSeconds: 10, channelPrice: null, metadata: {}, userId: USER, offerKey: 'default', listingTypeId: null })
    repo.rows[0].publish_lease_until = new Date(Date.now() - 1000).toISOString()
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'needs_reconciliation' })
    expect(addItems()).toBe(0)
  })

  it('idempotência: publicar de novo após sucesso → already_published, sem novo add_item', async () => {
    await publishListings(session, shopeeInput(shopA), deps())
    const again = await publishListings(session, shopeeInput(shopA), deps())
    expect(again.results[0]).toMatchObject({ status: 'skipped', reason: 'already_published' })
    expect(addItems()).toBe(1)
    expect(repo.rows).toHaveLength(1)
  })

  it('idempotência: duas publicações simultâneas da MESMA variação/loja → uma publica, outra in_progress', async () => {
    const [a, b] = await Promise.all([publishListings(session, shopeeInput(shopA), deps()), publishListings(session, shopeeInput(shopA), deps())])
    expect([a.results[0].status, b.results[0].status].sort()).toEqual(['published', 'skipped'])
    expect([a.results[0], b.results[0]].find((r) => r.status === 'skipped')).toMatchObject({ reason: 'in_progress' })
    expect(addItems()).toBe(1)
  })

  it('consistência eventual: item ainda não visível no get_item_base_info → publicado com aviso, sem republicar', async () => {
    sapi.shop.hideNewItems = true
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect(results[0]).toMatchObject({ status: 'published' })
    expect((results[0] as { warnings: string[] }).warnings.join(' ')).toMatch(/confirmação pendente/)
    expect(repo.rows[0].external_listing_id).toBe(String(sapi.shop.items[0].item_id))
    expect(addItems()).toBe(1)
  })

  it('shop_id divergente na confirmação → NÃO aceita o vínculo (error, reconciliação manual)', async () => {
    sapi.shop.reportShopIdOverride = '999999'
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'channel_error' })
    expect((results[0] as { message: string }).message).toMatch(/outra loja/)
    expect(repo.rows[0]).toMatchObject({ local_status: 'error', external_listing_id: null })
  })

  it('integration_id de OUTRA empresa → bloqueado antes de qualquer chamada', async () => {
    await expect(publishListings(session, shopeeInput(shopOther), deps())).rejects.toMatchObject({ code: 'not_connected' })
    expect(sapi.shop.calls).toHaveLength(0)
    expect(repo.rows).toHaveLength(0)
  })

  it('trava: sem SHOPEE_LISTINGS_ALLOW_PUBLISH=true não publica', async () => {
    delete process.env.SHOPEE_LISTINGS_ALLOW_PUBLISH
    await expect(publishListings(session, shopeeInput(shopA), deps())).rejects.toMatchObject({ code: 'real_account_blocked' })
    expect(sapi.shop.calls).toHaveLength(0)
  })

  it('duas lojas Shopee da mesma empresa publicam o mesmo produto em paralelo sem colisão', async () => {
    const [a, b] = await Promise.all([publishListings(session, shopeeInput(shopA), deps()), publishListings(session, shopeeInput(shopB), deps())])
    expect(a.results[0].status).toBe('published')
    expect(b.results[0].status).toBe('published')
    expect(repo.rows.map((r) => r.integration_id).sort()).toEqual([shopA, shopB].sort())
    expect(sapi.shop.items.map((i) => i.shop_id).sort()).toEqual([SHOP_A, SHOP_B])
    const byShop = Object.fromEntries(repo.rows.map((r) => [r.integration_id, r.external_ids.shop_id]))
    expect(byShop).toEqual({ [shopA]: SHOP_A, [shopB]: SHOP_B })
  })

  it('MESMA variação publicada ao mesmo tempo no Mercado Livre e na Shopee → 2 vínculos independentes, sem colisão', async () => {
    const mlInput: PublishInput = {
      productId: 1, categoryId: 'MLB1234', commonAttributes: [{ id: 'BRAND', value_name: 'Santtorini' }, { id: 'MODEL', value_name: 'Renda' }],
      requiredAttributeIds: ['BRAND', 'MODEL'], variations: [{ productVariationId: 11, attributes: [{ id: 'SIZE', value_name: 'M' }] }],
    }
    const [ml, sh] = await Promise.all([publishListings(session, mlInput, deps()), publishListings(session, shopeeInput(shopA), deps())])
    expect(ml.channel.provider).toBe('mercadolivre')
    expect(sh.channel.provider).toBe('shopee')
    expect(ml.results[0]).toMatchObject({ status: 'published' })
    expect(sh.results[0]).toMatchObject({ status: 'published' })
    expect(repo.rows).toHaveLength(2)
    const mlRow = repo.rows.find((r) => r.provider === 'mercadolivre')!
    const shRow = repo.rows.find((r) => r.provider === 'shopee')!
    expect(mlRow).toMatchObject({ product_variation_id: 11, integration_id: mlIntegration, offer_key: 'gold_special', local_status: 'active' })
    expect(shRow).toMatchObject({ product_variation_id: 11, integration_id: shopA, offer_key: 'default', local_status: 'active' })
    expect(mlRow.external_listing_id).toMatch(/^MLB/)
    expect(shRow.external_listing_id).toMatch(/^\d+$/)
    // repetir as duas: nada duplica em nenhum canal
    const again = await Promise.all([publishListings(session, mlInput, deps()), publishListings(session, shopeeInput(shopA), deps())])
    expect(again.map((r) => r.results[0].status)).toEqual(['skipped', 'skipped'])
    expect(repo.rows).toHaveLength(2)
    expect(addItems()).toBe(1)
  })
})

describe('Shopee — dados físicos e fiscais vindos do PIM pelo core', () => {
  const withPim = (productPhysical: Record<string, unknown>, variationPhysical: Record<string, unknown> | null = null, fiscal: ProductSource['fiscal'] = null) => {
    products[0] = { ...products[0], physical: productPhysical, fiscal, variations: [{ ...products[0].variations[0], physical: variationPhysical }] }
  }

  it('peso/dimensões do PRODUTO chegam ao adapter via draft e vão ao add_item (sem weight_kg manual)', async () => {
    withPim({ weight_kg: '0.350', package_length_cm: 25, package_width_cm: 18, package_height_cm: 4 })
    const { results } = await publishListings(session, shopeeInput(shopA, { weight_kg: undefined }), deps())
    expect(results[0]).toMatchObject({ status: 'published' })
    expect(sapi.shop.addItemCalls[0].body).toMatchObject({ weight: 0.35, dimension: { package_height: 4, package_length: 25, package_width: 18 } })
  })

  it('override da VARIAÇÃO tem prioridade sobre o produto e sobre o manual', async () => {
    withPim({ weight_kg: 0.35, package_length_cm: 25, package_width_cm: 18, package_height_cm: 4 }, { weight_kg_override: 0.5, package_height_cm_override: 6 })
    await publishListings(session, shopeeInput(shopA, { weight_kg: 9 }), deps())
    expect(sapi.shop.addItemCalls[0].body).toMatchObject({ weight: 0.5, dimension: { package_height: 6, package_length: 25, package_width: 18 } })
  })

  it('dimensão parcial no PIM bloqueia antes de qualquer upload', async () => {
    withPim({ weight_kg: 0.35, package_width_cm: 18 })
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect((results[0] as { message: string }).message).toContain('incomplete_dimensions')
    expect(addItems()).toBe(0)
  })

  it('sem peso no PIM nem manual → missing_weight', async () => {
    withPim({})
    const { results } = await publishListings(session, shopeeInput(shopA, { weight_kg: null }), deps())
    expect((results[0] as { message: string }).message).toContain('missing_weight')
    expect(addItems()).toBe(0)
  })

  it('fiscal do produto (NCM/CEST/origem) → tax_info no add_item', async () => {
    withPim({ weight_kg: 0.3 }, null, { ncm: '62121000', cest: null, origin: 0, measureUnit: 'UN' })
    await publishListings(session, shopeeInput(shopA), deps())
    expect(sapi.shop.addItemCalls[0].body.tax_info).toEqual({ ncm: '62121000', origin: '0', measure_unit: 'UN' })
  })

  it('NCM inválido no produto → invalid_ncm, nada criado', async () => {
    withPim({ weight_kg: 0.3 }, null, { ncm: '999', cest: null, origin: null, measureUnit: null })
    const { results } = await publishListings(session, shopeeInput(shopA), deps())
    expect((results[0] as { message: string }).message).toContain('invalid_ncm')
    expect(addItems()).toBe(0)
  })

  it('Mercado Livre ignora shippingDimensions/fiscalInfo (publica igual)', async () => {
    withPim({ weight_kg: 0.3, package_width_cm: 18 }, null, { ncm: '999', cest: null, origin: null, measureUnit: null })
    const ml = await publishListings(session, {
      productId: 1, categoryId: 'MLB1234', commonAttributes: [{ id: 'BRAND', value_name: 'Santtorini' }, { id: 'MODEL', value_name: 'Renda' }],
      requiredAttributeIds: ['BRAND', 'MODEL'], variations: [{ productVariationId: 11, attributes: [{ id: 'SIZE', value_name: 'M' }] }],
    }, deps())
    expect(ml.results[0]).toMatchObject({ status: 'published' })
  })
})

describe('Shopee — resolver de canal e requisitos (shopeeChannel)', () => {
  const request = () => ({ config: SHOPEE_CONFIG, store: sdb.store(), fetchImpl: sapi.fetch, sleep: async () => {} })

  it('resolve pela integração EXATA; outra empresa, desconectada ou needs_reauth → bloqueio tipado', async () => {
    await expect(resolveShopeeChannel(COMPANY, shopB, { repo: sdb.repo() })).resolves.toMatchObject({ integrationId: shopB, shopId: SHOP_B, provider: 'shopee' })
    await expect(resolveShopeeChannel(COMPANY, shopOther, { repo: sdb.repo() })).rejects.toMatchObject({ code: 'not_connected' })
    await expect(resolveShopeeChannel(COMPANY, 0, { repo: sdb.repo() })).rejects.toMatchObject({ code: 'not_connected' })
    sdb.row(shopA)!.status = 'needs_reauth'
    await expect(resolveShopeeChannel(COMPANY, shopA, { repo: sdb.repo() })).rejects.toMatchObject({ code: 'needs_reauth' })
    await sdb.repo().disconnect(shopB, COMPANY, USER)
    await expect(resolveShopeeChannel(COMPANY, shopB, { repo: sdb.repo() })).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('shop_id da linha divergente de settings.shop_id → recusa', async () => {
    sdb.row(shopA)!.settings = { shop_id: '1' }
    await expect(resolveShopeeChannel(COMPANY, shopA, { repo: sdb.repo() })).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('getShopeePublishRequirements end-to-end pela loja certa', async () => {
    const req = await getShopeePublishRequirements(COMPANY, shopB, 102, { repo: sdb.repo(), request: request() })
    expect(req.attributes.required.map((a) => a.attribute_id)).toEqual([1001])
    expect(req.brand.no_brand_option?.brand_id).toBe(0)
    expect(req.logistics.default_channel_id).toBe(90001)
    expect(new Set(sapi.shop.calls.map((c) => c.shop_id))).toEqual(new Set([SHOP_B]))
    await expect(getShopeePublishRequirements(OTHER, shopB, 102, { repo: sdb.repo(), request: request() })).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('operações fora do escopo lançam not_implemented (nunca simulam sucesso)', async () => {
    const adapter = createShopeeAdapter({ integrationId: shopA, companyId: COMPANY, shopId: SHOP_A, deps: request() })
    await expect(adapter.updateQuantity({ externalListingId: '1' }, 3)).rejects.toMatchObject({ kind: 'not_implemented' })
    await expect(adapter.findListingsBySellerSku('X')).rejects.toMatchObject({ kind: 'not_implemented' })
  })
})
