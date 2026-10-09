import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleProductDetail } from './catalog'
import { baseNameWithoutColor, buildSuggestions, createColorGroup, deleteColorGroup, listColorGroups, updateColorGroup } from './colorGroups'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('./settings', () => ({ getWholesaleSiteSettings: vi.fn() }))
vi.mock('@/services/media.service', () => ({ listMediaByEntities: vi.fn() }))

const A = 1
const B = 2
const SETTINGS = { catalogActive: true, displayName: null, whatsappPhone: null, minimumOrderAmount: 300, showOutOfStock: false, showStockQuantity: false, showSearch: true, showCategories: true, pixelEnabled: false, pixelId: null, texts: {} }

let tables: FakeTables

function addProduct(id: number, name: string, color: string | null, opts: { company?: number; group?: number | null; active?: boolean; enabled?: boolean; stock?: number; category?: number } = {}) {
  const company = opts.company ?? A
  tables.products.push({ id, name, company_id: company, active: opts.active ?? true, wholesale_enabled: opts.enabled ?? true, wholesale_price: 20, category_id: opts.category ?? 1, brand_id: null, color_group_id: opts.group ?? null })
  tables.product_variations.push({ id: id * 10, product_id: id, sku_variation: `S${id}`, active: true, wholesale_price_override: null })
  tables.stock_balances.push({ product_variation_id: id * 10, stock_location_id: company === A ? 1 : 2, quantity: opts.stock ?? 5 })
  if (color) tables.product_variation_attributes.push({ product_variation_id: id * 10, variation_type_id: 1, variation_value_id: id })
  if (color) tables.variation_values.push({ id, value: color })
}

beforeEach(() => {
  vi.resetAllMocks()
  tables = {
    categories: [{ id: 1, company_id: A, name: 'Cat', slug: 'cat', active: true }, { id: 2, company_id: A, name: 'Sem Costura', slug: 'sem-costura', active: true }],
    brands: [], variation_types: [{ id: 1, name: 'Cor' }], variation_values: [], product_variation_attributes: [],
    products: [], product_variations: [], stock_balances: [],
    stock_locations: [{ id: 1, company_id: A, active: true }, { id: 2, company_id: B, active: true }],
    product_color_groups: [],
  }
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => createFakeAdmin(tables))
  ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SETTINGS)
  ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [] })
})

describe('detalhe do produto — outras cores do grupo explícito', () => {
  it('traz só os irmãos do MESMO grupo, com cor própria; nunca por semelhança de nome', async () => {
    addProduct(1, 'Calcinha Invisible Low Fio Rosa', 'Rosa', { group: 7 })
    addProduct(2, 'Calcinha Invisible Low Fio Preto', 'Preto', { group: 7 })
    addProduct(3, 'Calcinha Invisible Low Fio Nude', 'Nude', { group: 7, category: 2 }) // outra categoria, mesmo grupo
    addProduct(4, 'Calcinha Invisible Low Fio Branco', 'Branco') // nome parecido, SEM grupo
    addProduct(5, 'Calcinha Invisible Low Preto', 'Preto', { group: 8 }) // outro modelo
    const detail = await getWholesaleProductDetail(A, 1)
    expect(detail?.colorLabel).toBe('Rosa')
    expect(detail?.family?.map((p) => [p.productId, p.colorLabel])).toEqual([[3, 'Nude'], [2, 'Preto']])
  })

  it('produto sem grupo → sem outras cores', async () => {
    addProduct(1, 'Calcinha Rosa', 'Rosa')
    addProduct(2, 'Calcinha Preto', 'Preto')
    expect((await getWholesaleProductDetail(A, 1))?.family).toEqual([])
  })

  it('isolamento: produto de outra empresa com o mesmo id de grupo nunca aparece', async () => {
    addProduct(1, 'Calcinha Rosa', 'Rosa', { group: 7 })
    addProduct(2, 'Calcinha Preto da outra empresa', 'Preto', { group: 7, company: B })
    expect((await getWholesaleProductDetail(A, 1))?.family).toEqual([])
    expect(await getWholesaleProductDetail(A, 2)).toBeNull()
  })

  it('cor inativa, fora do atacado ou sem estoque não aparece como disponível', async () => {
    addProduct(1, 'Calcinha Rosa', 'Rosa', { group: 7 })
    addProduct(2, 'Calcinha Preto', 'Preto', { group: 7, active: false })
    addProduct(3, 'Calcinha Nude', 'Nude', { group: 7, enabled: false })
    addProduct(4, 'Calcinha Branco', 'Branco', { group: 7, stock: 0 })
    expect((await getWholesaleProductDetail(A, 1))?.family).toEqual([])

    ;(getWholesaleSiteSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SETTINGS, showOutOfStock: true })
    const withOut = (await getWholesaleProductDetail(A, 1))?.family ?? []
    expect(withOut.map((p) => [p.colorLabel, p.purchasable])).toEqual([['Branco', false]]) // aparece, mas marcada indisponível
  })

  it('cada cor traz as próprias variações, preços e imagens', async () => {
    addProduct(1, 'Calcinha Rosa', 'Rosa', { group: 7 })
    addProduct(2, 'Calcinha Preto', 'Preto', { group: 7 })
    ;(listMediaByEntities as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, data: [{ entity_id: '2', role: 'primary', position: 0, url: 'https://cdn/preto.jpg', alt_text: 'Preto', active: true }],
    })
    const [preto] = (await getWholesaleProductDetail(A, 1))?.family ?? []
    expect(preto.images[0].url).toBe('https://cdn/preto.jpg')
    expect(preto.variations.map((v) => v.variationId)).toEqual([20])
  })

  it('migration ainda não aplicada (coluna ausente) → página abre sem outras cores, sem erro', async () => {
    addProduct(1, 'Calcinha Rosa', 'Rosa', { group: 7 })
    const real = createFakeAdmin(tables)
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      ...real,
      from: (t: string) => {
        const q = real.from(t)
        const select = q.select.bind(q)
        q.select = (cols: string) => (cols === 'color_group_id'
          ? { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column products.color_group_id does not exist' } }) }) }) }
          : select(cols))
        return q
      },
    }))
    const detail = await getWholesaleProductDetail(A, 1)
    expect(detail?.productId).toBe(1)
    expect(detail?.family).toEqual([])
  })
})

describe('sugestões (nunca automáticas)', () => {
  it('baseNameWithoutColor remove só a cor do FIM do nome (sem acento/caixa)', () => {
    expect(baseNameWithoutColor('Calcinha Invisible Low Fio Rosê', 'Rose')).toBe('Calcinha Invisible Low Fio')
    expect(baseNameWithoutColor('Calcinha Rosa Choque', 'Rosa')).toBeNull()
    expect(baseNameWithoutColor('Rosa', 'Rosa')).toBeNull()
  })

  it('agrupa por nome-base e exige 2+ produtos; "Low" e "Low Fio" são modelos distintos', () => {
    const s = buildSuggestions([
      { id: 1, name: 'Calcinha Invisible Low Fio Rosa', color: 'Rosa' },
      { id: 2, name: 'Calcinha Invisible Low Fio Preto', color: 'Preto' },
      { id: 3, name: 'Calcinha Invisible Low Preto', color: 'Preto' },
      { id: 4, name: 'Calcinha Invisible Low Rosê', color: 'Rosê' },
      { id: 5, name: 'Body Preto', color: null },
    ])
    expect(s.map((x) => [x.baseName, x.products.map((p) => p.id)])).toEqual([
      ['Calcinha Invisible Low', [3, 4]],
      ['Calcinha Invisible Low Fio', [2, 1]], // ordenado por nome
    ])
  })
})

describe('gestão dos grupos (ERP) — isolamento e validação', () => {
  it('cria grupo com produtos da empresa; recusa outra empresa, já agrupado e menos de 2', async () => {
    addProduct(1, 'A Rosa', 'Rosa'); addProduct(2, 'A Preto', 'Preto'); addProduct(3, 'B Preto', 'Preto', { company: B }); addProduct(4, 'A Nude', 'Nude', { group: 99 })
    expect(await createColorGroup(A, 'Modelo', [1])).toMatchObject({ ok: false, status: 422 })
    expect(await createColorGroup(A, 'Modelo', [1, 3])).toMatchObject({ ok: false, status: 422 })
    expect(await createColorGroup(A, 'Modelo', [1, 4])).toMatchObject({ ok: false, status: 409 })
    const ok = await createColorGroup(A, 'Modelo', [1, 2])
    expect(ok.ok).toBe(true)
    expect(tables.products.filter((p) => p.color_group_id != null && p.id <= 2)).toHaveLength(2)
    expect(tables.products.find((p) => p.id === 3)!.color_group_id).toBeNull()
  })

  it('lista, atualiza membros e desfaz sem apagar produtos; outra empresa não enxerga nem altera', async () => {
    addProduct(1, 'Calcinha X Rosa', 'Rosa'); addProduct(2, 'Calcinha X Preto', 'Preto'); addProduct(3, 'Calcinha X Nude', 'Nude')
    const created = await createColorGroup(A, 'Calcinha X', [1, 2])
    const id = created.ok ? (created as any).data.id : -1

    const listed = await listColorGroups(A)
    expect(listed.groups[0].members.map((m) => m.productId).sort()).toEqual([1, 2])
    expect(listed.ungrouped.map((p) => p.id)).toEqual([3])

    expect((await listColorGroups(B)).groups).toEqual([])
    expect(await updateColorGroup(B, id, { name: 'invadido' })).toMatchObject({ ok: false, status: 404 })
    expect(await deleteColorGroup(B, id)).toMatchObject({ ok: false, status: 404 })

    expect((await updateColorGroup(A, id, { productIds: [2, 3] })).ok).toBe(true)
    expect(tables.products.map((p) => p.color_group_id)).toEqual([null, id, id])

    expect((await deleteColorGroup(A, id)).ok).toBe(true)
    expect(tables.products).toHaveLength(3)
    expect(tables.products.every((p) => p.color_group_id == null)).toBe(true)
  })
})
