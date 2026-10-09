import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleCatalogPage, listWholesaleCategories } from './catalog'
import { assignCategoryKeys, resolveCategoryKey } from './categoryKeys'
import { setCategoryCover, removeCategoryCover, listCategoriesWithCovers } from './categoryCovers'
import { createWholesaleBanner } from './banners'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/services/media.service', () => ({
  listMediaByEntities: vi.fn(),
  resolveMediaUrl: vi.fn(async (m: { storage_key: string | null }) =>
    m.storage_key ? { ok: true, data: { url: `https://cdn.test/${m.storage_key}`, expiresAt: null } } : { ok: false, error: 'x', status: 500 }),
}))

const A = 1
const B = 2
const SETTINGS = {
  catalogActive: true, displayName: null, whatsappPhone: null, minimumOrderAmount: 300,
  showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null,
}
const pid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`

let tables: FakeTables

function product(id: number, category: number, company = A) {
  tables.products.push({ id, name: `P${id}`, company_id: company, active: true, wholesale_enabled: true, wholesale_price: 20, category_id: category, brand_id: null })
  tables.product_variations.push({ id: id * 10, product_id: id, sku_variation: `S${id}`, active: true, wholesale_price_override: null })
  tables.stock_balances.push({ product_variation_id: id * 10, stock_location_id: company === A ? 1 : 2, quantity: 5 })
}

beforeEach(() => {
  vi.resetAllMocks()
  tables = {
    categories: [
      { id: 1, company_id: A, name: 'Calcinhas', slug: 'calcinhas', active: true },
      { id: 2, company_id: A, name: 'Camisetas Fem', slug: 'camisetas', active: true, product_type_id: 1 },
      { id: 3, company_id: A, name: 'Camisetas Masc', slug: 'camisetas', active: true, product_type_id: 2 },
      { id: 4, company_id: A, name: 'Antiga', slug: 'antiga', active: false },
      { id: 5, company_id: A, name: 'Vazia', slug: 'vazia', active: true },
      { id: 6, company_id: null, name: 'Legada', slug: 'legada', active: true },
      { id: 7, company_id: B, name: 'Da B', slug: 'da-b', active: true },
    ],
    brands: [], variation_types: [], variation_values: [], products: [], product_variations: [], product_variation_attributes: [], stock_balances: [],
    stock_locations: [{ id: 1, company_id: A, active: true }, { id: 2, company_id: B, active: true }],
    media: [
      { id: 1, public_id: pid(1), company_id: A, visibility: 'public', active: true, storage_key: '1/capa.jpg', alt_text: 'Capa calcinhas' },
      { id: 2, public_id: pid(2), company_id: B, visibility: 'public', active: true, storage_key: '2/b.jpg', alt_text: null },
      { id: 3, public_id: pid(3), company_id: A, visibility: 'private', active: true, storage_key: '1/priv.jpg', alt_text: null },
    ],
    wholesale_category_covers: [],
    wholesale_site_banners: [],
  }
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => createFakeAdmin(tables))
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS)
  ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
})

describe('chaves públicas das categorias (slug repetido)', () => {
  it('slug único mantém o próprio slug (links atuais continuam válidos); repetido vira slug~id', () => {
    const keyed = assignCategoryKeys([
      { id: 1, name: 'a', slug: 'calcinhas', active: true },
      { id: 2, name: 'b', slug: 'camisetas', active: true },
      { id: 3, name: 'c', slug: 'camisetas', active: true },
    ])
    expect(keyed.map((c) => c.key)).toEqual(['calcinhas', 'camisetas~2', 'camisetas~3'])
    expect(resolveCategoryKey(keyed, 'camisetas~3')?.id).toBe(3)
    expect(resolveCategoryKey(keyed, 'camisetas')).toBeNull() // ambíguo → não adivinha
  })

  it('filtro do catálogo separa categorias com o mesmo slug (antes as duas se fundiam)', async () => {
    product(1, 2); product(2, 3); product(3, 3)
    const fem = await getWholesaleCatalogPage(A, { categorySlug: 'camisetas~2' })
    const masc = await getWholesaleCatalogPage(A, { categorySlug: 'camisetas~3' })
    expect(fem.products.map((p) => p.productId)).toEqual([1])
    expect(masc.products.map((p) => p.productId)).toEqual([2, 3])
    expect((await getWholesaleCatalogPage(A, { categorySlug: 'camisetas' })).products).toEqual([])
  })

  it('lista de categorias traz as duas, cada uma com sua chave e contagem', async () => {
    product(1, 2); product(2, 3); product(3, 3)
    const list = await listWholesaleCategories(A)
    expect(list.filter((c) => c.slug === 'camisetas').map((c) => [c.key, c.productCount])).toEqual([['camisetas~2', 1], ['camisetas~3', 2]])
  })

  it('banner que aponta para categoria de slug repetido guarda e devolve a chave exata', async () => {
    const r = await createWholesaleBanner(A, { mediaPublicId: pid(1), link: { type: 'category', categorySlug: 'camisetas~3' } })
    expect(r.ok && r.data.link).toEqual({ type: 'category', categorySlug: 'camisetas~3' })
    expect(tables.wholesale_site_banners[0].link_category_id).toBe(3)
    expect(await createWholesaleBanner(A, { mediaPublicId: pid(1), link: { type: 'category', categorySlug: 'camisetas' } })).toMatchObject({ ok: false, status: 422 })
  })
})

describe('categorias válidas para o catálogo público', () => {
  it('só categorias ativas, com produto visível e da empresa (ou legada em uso); nunca de outra empresa', async () => {
    product(1, 1); product(2, 4); product(3, 6); product(4, 7, B)
    const list = await listWholesaleCategories(A)
    expect(list.map((c) => c.slug)).toEqual(['calcinhas', 'legada'])
  })

  it('produto fora do atacado não sustenta categoria', async () => {
    product(1, 1)
    tables.products[0].wholesale_enabled = false
    expect(await listWholesaleCategories(A)).toEqual([])
  })

  it('filtrar por categoria inativa ou de outra empresa devolve vazio', async () => {
    product(1, 4); product(2, 7, B)
    expect((await getWholesaleCatalogPage(A, { categorySlug: 'antiga' })).products).toEqual([])
    expect((await getWholesaleCatalogPage(A, { categorySlug: 'da-b' })).products).toEqual([])
  })
})

describe('imagem dos cards de categoria', () => {
  it('capa configurada > foto de produto > sem imagem', async () => {
    product(1, 1); product(2, 5); product(3, 6)
    tables.wholesale_category_covers.push({ id: 1, company_id: A, category_id: 1, media_id: 1 })
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: [{ entity_id: '2', role: 'primary', position: 0, url: 'https://cdn.test/p2.jpg', alt_text: 'Foto P2', active: true }],
    })

    const list = await listWholesaleCategories(A, { withImages: true })
    const bySlug = Object.fromEntries(list.map((c) => [c.slug, c]))
    expect(bySlug.calcinhas).toMatchObject({ imageUrl: 'https://cdn.test/1/capa.jpg', imageAlt: 'Capa calcinhas' })
    expect(bySlug.vazia).toMatchObject({ imageUrl: 'https://cdn.test/p2.jpg' })
    expect(bySlug.legada.imageUrl).toBeNull()
  })

  it('capa de outra empresa para a mesma categoria é ignorada', async () => {
    product(1, 6)
    tables.wholesale_category_covers.push({ id: 1, company_id: B, category_id: 6, media_id: 2 })
    const list = await listWholesaleCategories(A, { withImages: true })
    expect(list[0].imageUrl).toBeNull()
  })

  it('não busca imagens quando não pedido (nav/filtros)', async () => {
    product(1, 1)
    await listWholesaleCategories(A)
    expect(listMediaByEntities).not.toHaveBeenCalled()
  })
})

describe('capas no ERP — validação no servidor e isolamento', () => {
  it('define, troca e remove a capa da própria categoria', async () => {
    expect(await setCategoryCover(A, 1, pid(1))).toEqual({ ok: true })
    expect(await setCategoryCover(A, 1, pid(1))).toEqual({ ok: true }) // troca/idempotente: continua 1 linha
    expect(tables.wholesale_category_covers).toHaveLength(1)
    const listed = await listCategoriesWithCovers(A)
    expect(listed.find((c) => c.id === 1)?.cover).toMatchObject({ url: 'https://cdn.test/1/capa.jpg' })
    expect(await removeCategoryCover(A, 1)).toEqual({ ok: true })
    expect(await removeCategoryCover(A, 1)).toMatchObject({ ok: false, status: 404 })
  })

  it('rejeita categoria de outra empresa, categoria legada, mídia de outra empresa e mídia privada', async () => {
    expect(await setCategoryCover(A, 7, pid(1))).toMatchObject({ ok: false, status: 404 })
    expect(await setCategoryCover(A, 6, pid(1))).toMatchObject({ ok: false, status: 404 })
    expect(await setCategoryCover(A, 1, pid(2))).toMatchObject({ ok: false, status: 404 })
    expect(await setCategoryCover(A, 1, pid(3))).toMatchObject({ ok: false, status: 404 })
    expect(tables.wholesale_category_covers).toHaveLength(0)
  })

  it('empresa B não remove nem enxerga a capa da A', async () => {
    await setCategoryCover(A, 1, pid(1))
    expect(await removeCategoryCover(B, 1)).toMatchObject({ ok: false, status: 404 })
    expect(tables.wholesale_category_covers).toHaveLength(1)
    expect((await listCategoriesWithCovers(B)).map((c) => c.id)).toEqual([7])
  })

  it('lista do ERP mostra só categorias da própria empresa (não as legadas) com a chave pública', async () => {
    const ids = (await listCategoriesWithCovers(A)).map((c) => [c.id, c.key])
    expect(ids).toContainEqual([2, 'camisetas~2'])
    expect(ids.find(([id]) => id === 6)).toBeUndefined()
    expect(ids.find(([id]) => id === 7)).toBeUndefined()
  })
})
