import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntities } from '@/services/media.service'
import { getWholesaleSiteSettings } from './settings'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { getWholesaleProductDetail, getWholesaleCatalogPage, listWholesaleCategories, getWholesaleRecommendations } from './catalog'
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

describe('produtos continuam individuais na vitrine; o grupo só interliga o detalhe', () => {
  function fourColors() {
    addProduct(1, 'Calcinha Invisible Low Rosé', 'Rosé', { group: 7 })
    addProduct(2, 'Calcinha Invisible Low Beige', 'Beige', { group: 7 })
    addProduct(3, 'Calcinha Invisible Low Preta', 'Preta', { group: 7 })
    addProduct(4, 'Calcinha Invisible Low Branca', 'Branca', { group: 7 })
  }

  it('home, categoria e busca listam os 4 produtos, cada um com o próprio id (sem card único)', async () => {
    fourColors()
    const home = await getWholesaleCatalogPage(A)
    expect(home.products.map((p) => p.productId).sort()).toEqual([1, 2, 3, 4])
    expect(home.total).toBe(4)
    expect((await getWholesaleCatalogPage(A, { categorySlug: 'cat' })).products).toHaveLength(4)
    expect((await getWholesaleCatalogPage(A, { search: 'beige' })).products.map((p) => p.productId)).toEqual([2])
    expect((await listWholesaleCategories(A))[0].productCount).toBe(4)
    // os cards da listagem não carregam as outras cores (isso é só do detalhe)
    expect(home.products.every((p) => (p.family ?? []).length === 0)).toBe(true)
  })

  it('recomendações podem sugerir qualquer um dos produtos do grupo (não ocultam irmãos)', async () => {
    fourColors()
    const recs = await getWholesaleRecommendations(A, { excludeProductIds: [], seed: 's', limit: 6 })
    expect(recs.map((p) => p.productId).sort()).toEqual([1, 2, 3, 4])
  })

  it('abrir QUALQUER cor mostra as outras três; a aberta fica fora da lista de irmãos', async () => {
    fourColors()
    for (const id of [1, 2, 3, 4]) {
      const detail = await getWholesaleProductDetail(A, id)
      expect(detail?.productId).toBe(id)
      const others = (detail?.family ?? []).map((p) => p.productId).sort()
      expect(others).toEqual([1, 2, 3, 4].filter((x) => x !== id))
    }
  })

  it('cada cor traz dados reais próprios: nome, variação, preço e estoque', async () => {
    addProduct(1, 'Calcinha Invisible Low Rosé', 'Rosé', { group: 7, stock: 3 })
    addProduct(2, 'Calcinha Invisible Low Beige', 'Beige', { group: 7, stock: 9 })
    tables.products.find((p) => p.id === 2)!.wholesale_price = 31.5
    const detail = await getWholesaleProductDetail(A, 1)
    const beige = detail!.family![0]
    expect(beige).toMatchObject({ productId: 2, name: 'Calcinha Invisible Low Beige', colorLabel: 'Beige', priceFrom: 31.5 })
    expect(beige.variations[0]).toMatchObject({ variationId: 20, sku: 'S2', price: 31.5, maxQuantity: 9 })
    expect(detail!.variations[0]).toMatchObject({ variationId: 10, price: 20, maxQuantity: 3 })
  })

  it('remover um produto do grupo tira a cor da página dos demais (e ele fica sem irmãos)', async () => {
    addProduct(1, 'Calcinha Invisible Low Rosé', 'Rosé'); addProduct(2, 'Calcinha Invisible Low Beige', 'Beige')
    addProduct(3, 'Calcinha Invisible Low Preta', 'Preta'); addProduct(4, 'Calcinha Invisible Low Branca', 'Branca')
    const created = await createColorGroup(A, 'Invisible Low', [1, 2, 3, 4])
    const id = created.ok ? (created as any).data.id : -1
    expect((await updateColorGroup(A, id, { productIds: [1, 2, 3] })).ok).toBe(true)

    const rose = await getWholesaleProductDetail(A, 1)
    expect(rose?.family?.map((p) => p.productId).sort()).toEqual([2, 3])
    const white = await getWholesaleProductDetail(A, 4)
    expect(white?.family).toEqual([])
    expect(tables.products.find((p) => p.id === 4)).toBeTruthy() // produto segue existindo, intacto
  })

  it('produtos de cadastro/SKU/preço/estoque não são tocados ao criar, editar ou desfazer grupo', async () => {
    addProduct(1, 'A Rosé', 'Rosé'); addProduct(2, 'A Beige', 'Beige')
    const snapshot = JSON.stringify({ products: tables.products.map(({ color_group_id, ...rest }) => rest), v: tables.product_variations, s: tables.stock_balances })
    const created = await createColorGroup(A, 'Modelo', [1, 2])
    const id = created.ok ? (created as any).data.id : -1
    await updateColorGroup(A, id, { name: 'Outro nome', productIds: [1] })
    await deleteColorGroup(A, id)
    expect(JSON.stringify({ products: tables.products.map(({ color_group_id, ...rest }) => rest), v: tables.product_variations, s: tables.stock_balances })).toBe(snapshot)
  })
})

describe('gestão — membros inativos e fallback sem migration', () => {
  it('produto inativo continua listado no grupo (para poder ser removido) mas não é candidato', async () => {
    addProduct(1, 'A Rosé', 'Rosé'); addProduct(2, 'A Beige', 'Beige', { active: false }); addProduct(3, 'A Preta', 'Preta', { active: false })
    const created = await createColorGroup(A, 'Modelo', [1, 2])
    expect(created.ok).toBe(true)
    const overview = await listColorGroups(A)
    expect(overview.groups[0].members.map((m) => [m.productId, m.active]).sort()).toEqual([[1, true], [2, false]])
    expect(overview.ungrouped.map((p) => p.id)).toEqual([]) // 3 é inativo
  })

  it('grupo pode ficar com 1 produto ao remover (sem efeito no site); 0 é recusado', async () => {
    addProduct(1, 'A Rosé', 'Rosé'); addProduct(2, 'A Beige', 'Beige')
    const created = await createColorGroup(A, 'Modelo', [1, 2])
    const id = created.ok ? (created as any).data.id : -1
    expect((await updateColorGroup(A, id, { productIds: [1] })).ok).toBe(true)
    expect(await updateColorGroup(A, id, { productIds: [] })).toMatchObject({ ok: false, status: 422 })
  })

  it('produto de outra empresa nunca entra, e um produto já agrupado não vai para um segundo grupo', async () => {
    addProduct(1, 'A Rosé', 'Rosé'); addProduct(2, 'A Beige', 'Beige'); addProduct(3, 'A Preta', 'Preta'); addProduct(9, 'B Preta', 'Preta', { company: B })
    const g1 = await createColorGroup(A, 'G1', [1, 2])
    expect(await createColorGroup(A, 'G2', [2, 3])).toMatchObject({ ok: false, status: 409 })
    const id = g1.ok ? (g1 as any).data.id : -1
    expect(await updateColorGroup(A, id, { productIds: [1, 2, 9] })).toMatchObject({ ok: false, status: 422 })
  })

  it('sem a migration: o ERP recebe migrationPending (não 500) e o detalhe segue sem cores', async () => {
    addProduct(1, 'A Rosé', 'Rosé', { group: 7 })
    const real = createFakeAdmin(tables)
    ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      ...real,
      from: (t: string) => {
        if (t === 'product_color_groups') {
          const q: any = { select: () => q, eq: () => q, order: () => q, then: (r: any) => r({ data: null, error: { code: '42P01', message: 'relation "product_color_groups" does not exist' } }) }
          return q
        }
        return real.from(t)
      },
    }))
    const overview = await listColorGroups(A)
    expect(overview).toMatchObject({ migrationPending: true, groups: [], ungrouped: [], suggestions: [] })
  })
})
