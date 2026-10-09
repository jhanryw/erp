import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { createFakeAdmin, type FakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { configureWholesaleCache, invalidateWholesaleCompany } from '@/lib/wholesale/ttlCache'
import { getWholesaleCatalogPage, listWholesaleCategories } from './catalog'
import { getWholesaleSiteSettings, updateWholesaleSiteSettings } from './settings'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntities: vi.fn(), listMediaByEntity: vi.fn(), resolveMediaUrl: vi.fn() }))

const A = 1
const B = 2
let tables: FakeTables
let admin: FakeAdmin

function seed() {
  tables = {
    wholesale_site_settings: [],
    categories: [{ id: 1, company_id: A, name: 'Cat', slug: 'cat', active: true }, { id: 2, company_id: B, name: 'CatB', slug: 'catb', active: true }],
    brands: [], variation_types: [], variation_values: [], product_variation_attributes: [],
    products: [
      { id: 1, name: 'Calcinha Renda', company_id: A, active: true, wholesale_enabled: true, wholesale_price: 20, category_id: 1, brand_id: null },
      { id: 2, name: 'Sutiã Bojo', company_id: A, active: true, wholesale_enabled: true, wholesale_price: 30, category_id: 1, brand_id: null },
      { id: 3, name: 'Da outra empresa', company_id: B, active: true, wholesale_enabled: true, wholesale_price: 10, category_id: 2, brand_id: null },
    ],
    product_variations: [
      { id: 10, product_id: 1, sku_variation: 'S10', active: true, wholesale_price_override: null },
      { id: 20, product_id: 2, sku_variation: 'S20', active: true, wholesale_price_override: null },
      { id: 30, product_id: 3, sku_variation: 'S30', active: true, wholesale_price_override: null },
    ],
    stock_balances: [
      { product_variation_id: 10, stock_location_id: 1, quantity: 5 },
      { product_variation_id: 20, stock_location_id: 1, quantity: 5 },
      { product_variation_id: 30, stock_location_id: 2, quantity: 5 },
    ],
    stock_locations: [{ id: 1, company_id: A, active: true }, { id: 2, company_id: B, active: true }],
  }
  admin = createFakeAdmin(tables)
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(admin)
}

beforeEach(() => {
  vi.resetAllMocks()
  seed()
  ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
  configureWholesaleCache({ ttlMs: 30_000 })
})
afterEach(() => configureWholesaleCache({ ttlMs: null }))

const ids = (p: { products: { productId: number }[] }) => p.products.map((x) => x.productId)

describe('cache do catálogo público', () => {
  it('repetir a home não volta ao banco: 1 carga de produtos/variações/estoque', async () => {
    await getWholesaleCatalogPage(A)
    const after1 = { ...admin.queryCount }
    await getWholesaleCatalogPage(A)
    await getWholesaleCatalogPage(A)
    expect(admin.queryCount).toEqual(after1)
    expect(after1.products).toBe(1)
    expect(after1.product_variations).toBe(1)
  })

  it('busca e categoria reaproveitam a MESMA carga (filtro em memória, mesmo resultado)', async () => {
    await getWholesaleCatalogPage(A)
    const products = admin.queryCount.products
    expect(ids(await getWholesaleCatalogPage(A, { search: 'sutiã' }))).toEqual([2])
    expect(ids(await getWholesaleCatalogPage(A, { categorySlug: 'cat' }))).toEqual([1, 2])
    expect(ids(await getWholesaleCatalogPage(A, { search: 'inexistente' }))).toEqual([])
    expect(admin.queryCount.products).toBe(products)
  })

  it('isolamento: empresa B nunca recebe a vitrine em cache da A', async () => {
    expect(ids(await getWholesaleCatalogPage(A)).sort()).toEqual([1, 2])
    expect(ids(await getWholesaleCatalogPage(B))).toEqual([3])
    expect((await listWholesaleCategories(B)).map((c) => c.slug)).toEqual(['catb'])
  })

  it('estoque: pode ficar defasado até o TTL, e invalidar da empresa força leitura nova', async () => {
    expect(ids(await getWholesaleCatalogPage(A))).toContain(1)
    tables.stock_balances[0].quantity = 0 // vendeu tudo
    expect(ids(await getWholesaleCatalogPage(A))).toContain(1) // vitrine ainda em cache (≤ TTL)
    invalidateWholesaleCompany(A)
    expect(ids(await getWholesaleCatalogPage(A))).not.toContain(1)
  })

  it('salvar configurações no ERP invalida na hora (texto novo aparece sem esperar o TTL)', async () => {
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'Antes' } })
    expect((await getWholesaleSiteSettings(A)).texts.heroTitle).toBe('Antes')
    await updateWholesaleSiteSettings(A, { texts: { heroTitle: 'Depois' } })
    expect((await getWholesaleSiteSettings(A)).texts.heroTitle).toBe('Depois')
  })

  it('mudar "mostrar sem estoque" muda a vitrine (chave de cache inclui a regra)', async () => {
    tables.stock_balances[0].quantity = 0
    await updateWholesaleSiteSettings(A, { showOutOfStock: false })
    expect(ids(await getWholesaleCatalogPage(A))).toEqual([2])
    await updateWholesaleSiteSettings(A, { showOutOfStock: true })
    expect(ids(await getWholesaleCatalogPage(A)).sort()).toEqual([1, 2])
  })
})
