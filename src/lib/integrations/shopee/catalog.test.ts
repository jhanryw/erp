import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { FakeShopeeApi, FakeShopeeDb, TEST_CONFIG, setTestCipherEnv } from './fakeShopee.testutil'
import { setShopeeLogSink } from './log'
import type { ShopeeShopContext } from './client'
import { categoryPath, findCategory, getBrandList, getCategories, getCategoryAttributes, getLogisticsChannels, usableLogisticsChannels } from './catalog'
import { loadRequirementsSnapshot, toPublishRequirements } from './requirements'
import { isShopeeError } from './errors'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
const SHOP = '123456'
let db: FakeShopeeDb
let api: FakeShopeeApi
let ctx: ShopeeShopContext

beforeEach(() => {
  db = new FakeShopeeDb()
  api = new FakeShopeeApi()
  const pair = api.issue(SHOP)
  const id = db.seedConnected(COMPANY, SHOP, { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  ctx = { integrationId: id, companyId: COMPANY, shopId: SHOP, deps: { config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} } }
  setShopeeLogSink(() => {})
})
afterEach(() => setShopeeLogSink(null))

describe('categorias (get_category)', () => {
  it('lista categorias com hierarquia e identifica folha por has_children', async () => {
    const list = await getCategories(ctx)
    expect(list.map((c) => c.category_id)).toEqual([100, 101, 102, 200])
    const leaf = findCategory(list, 102)
    expect(leaf).toMatchObject({ is_leaf: true, name: 'Sutiãs', parent_category_id: 101 })
    expect(leaf.path.map((p) => p.category_id)).toEqual([100, 101, 102])
    expect(findCategory(list, 100).is_leaf).toBe(false)
    expect(categoryPath(list, 200).map((c) => c.name)).toEqual(['Casa'])
    // Shop API assinada com shop_id + access_token da loja certa
    expect(api.lastUrl!.searchParams.get('shop_id')).toBe(SHOP)
    expect(api.lastUrl!.searchParams.get('language')).toBe('pt-br')
  })

  it('categoria inexistente → not_found; resposta incompleta → invalid_response', async () => {
    expect(() => findCategory([], 999)).toThrow(/não existe/)
    api.shop.fail.set('/api/v2/product/get_category', 'incomplete')
    await expect(getCategories(ctx)).rejects.toMatchObject({ kind: 'invalid_response' })
  })
})

describe('atributos (get_attribute_tree)', () => {
  it('diferencia obrigatório/opcional, tipo, valores permitidos; preserva IDs oficiais', async () => {
    const attrs = await getCategoryAttributes(ctx, 102)
    expect(attrs.find((a) => a.attribute_id === 1001)).toMatchObject({ mandatory: true, input_type: 'single_select', accepts_custom_value: false, multiple: false, values: [{ value_id: 11, name: 'Algodão', value_unit: null }, { value_id: 12, name: 'Renda', value_unit: null }] })
    expect(attrs.find((a) => a.attribute_id === 1002)).toMatchObject({ mandatory: false, input_type: 'free_text', validation: 'string', accepts_custom_value: true })
    expect(attrs.find((a) => a.attribute_id === 1003)).toMatchObject({ input_type: 'multi_select', multiple: true, max_value_count: 2 })
    expect(api.lastUrl!.searchParams.get('category_id_list')).toBe('102')
  })

  it('categoria inválida na Shopee → bad_request tipado', async () => {
    await expect(getCategoryAttributes(ctx, 555)).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('marcas (get_brand_list)', () => {
  it('categoria com marca obrigatória: opções + "No Brand" só porque a API ofereceu', async () => {
    const info = await getBrandList(ctx, 102)
    expect(info.is_mandatory).toBe(true)
    expect(info.brands.map((b) => b.brand_id)).toEqual([0, 5001])
    expect(info.no_brand_option).toMatchObject({ brand_id: 0, original_brand_name: 'No Brand' })
  })

  it('categoria sem exigência e sem "No Brand" na lista → no_brand_option null (não inventa brand_id=0)', async () => {
    const info = await getBrandList(ctx, 200)
    expect(info).toMatchObject({ is_mandatory: false, brands: [], no_brand_option: null })
  })

  it('pagina por next_offset', async () => {
    api.shop.brands[102].list = Array.from({ length: 250 }, (_, i) => ({ brand_id: i + 1, original_brand_name: `B${i + 1}` }))
    const info = await getBrandList(ctx, 102)
    expect(info.brands).toHaveLength(250)
    expect(api.shop.calls.filter((c) => c.path.endsWith('get_brand_list'))).toHaveLength(3)
  })
})

describe('logística (get_channel_list)', () => {
  it('lê canais da loja; utilizáveis = habilitados e sem SIZE_SELECTION', async () => {
    api.shop.channels.push({ logistics_channel_id: 90003, logistics_channel_name: 'Por tamanho', enabled: true, fee_type: 'SIZE_SELECTION' })
    const list = await getLogisticsChannels(ctx)
    expect(list.map((c) => c.logistics_channel_id)).toEqual([90001, 90002, 90003])
    expect(usableLogisticsChannels(list).map((c) => c.logistics_channel_id)).toEqual([90001])
  })
})

describe('requisitos de publicação (agregado)', () => {
  it('end-to-end: categoria, atributos obrig./opc., marca, peso obrigatório, dimensões opcionais, condition, logística', async () => {
    const req = toPublishRequirements(await loadRequirementsSnapshot(ctx, 102))
    expect(req.category.category_id).toBe(102)
    expect(req.attributes.required.map((a) => a.attribute_id)).toEqual([1001])
    expect(req.attributes.optional.map((a) => a.attribute_id)).toEqual([1002, 1003])
    expect(req.brand).toMatchObject({ required: true, no_brand_option: { brand_id: 0 } })
    expect(req.weight).toMatchObject({ required: true, unit: 'kg' })
    expect(req.dimensions).toMatchObject({ required: false, all_or_none: true })
    expect(req.condition.values).toEqual(['NEW', 'USED'])
    expect(req.logistics.default_channel_id).toBe(90001)
  })

  it('categoria intermediária: não consulta atributos/marcas', async () => {
    const snap = await loadRequirementsSnapshot(ctx, 100)
    expect(snap.category.is_leaf).toBe(false)
    expect(api.shop.calls.some((c) => c.path.endsWith('get_attribute_tree'))).toBe(false)
  })
})

describe('erros de API e isolamento', () => {
  it('access_token recusado → UMA renovação forçada e nova tentativa', async () => {
    const stale = 'acc-stale'
    const pair = api.issue(SHOP)
    const id = db.seedConnected(COMPANY, SHOP, { access: stale, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
    const list = await getCategories({ ...ctx, integrationId: id })
    expect(list.length).toBeGreaterThan(0)
    expect(api.refreshCalls).toBe(1)
  })

  it('token inválido e refresh recusado → reauth_required (sem laço)', async () => {
    const id = db.seedConnected(COMPANY, SHOP, { access: 'acc-bad', refresh: 'ref-bad', expiresAt: new Date(Date.now() + 3600_000) })
    const err = await getCategories({ ...ctx, integrationId: id }).catch((e) => e)
    expect(isShopeeError(err) && err.kind).toBe('reauth_required')
    expect(api.refreshCalls).toBe(1)
  })

  it('5xx → server retryable; integração de OUTRA empresa → integration_not_found (nenhuma chamada)', async () => {
    api.shop.fail.set('/api/v2/logistics/get_channel_list', 'server_error')
    await expect(getLogisticsChannels(ctx)).rejects.toMatchObject({ kind: 'server', retryable: true })
    const before = api.shop.calls.length
    await expect(getCategories({ ...ctx, companyId: 99 })).rejects.toMatchObject({ kind: 'integration_not_found' })
    expect(api.shop.calls.length).toBe(before)
  })

  it('token de uma loja não serve para outra (shop_id na assinatura/validação)', async () => {
    await expect(getCategories({ ...ctx, shopId: '999999' })).rejects.toMatchObject({ kind: 'reauth_required' })
  })
})
