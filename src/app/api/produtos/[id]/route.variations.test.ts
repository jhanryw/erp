import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProductSnapshot } from '@/services/produtos.service'
import { initializeStock } from '@/services/estoque.service'
import { PUT } from './route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/services/estoque.service', () => ({ initializeStock: vi.fn() }))
vi.mock('@/services/produtos.service', () => ({
  getProductSnapshot: vi.fn(),
  checkPriceChange: vi.fn().mockResolvedValue({ warning: undefined }),
  canDeleteProduct: vi.fn(),
  deleteProductCascade: vi.fn(),
}))

import { fakeAdmin, type Tables } from '@/lib/sku/fakeCatalogAdmin.testutil'

let tables: Tables
const put = (id: number, body: unknown) =>
  PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), { params: { id: String(id) } })
const skus = (productId: number) =>
  tables.product_variations.filter(v => v.product_id === productId).map(v => v.sku_variation).sort()

beforeEach(() => {
  vi.clearAllMocks()
  const base = { company_id: 1, category_id: 1, supplier_id: null, brand_id: null, origin: 'own_brand', base_cost: 10, base_price: 50, active: true, product_kind: 'standard', ano: '2026' }
  tables = {
    // 1: Cinta/Short dinâmico (o caso do bug) · 2: Cinta/Liga legado · 3: Cinta/Liga dinâmico
    products: [
      { id: 1, name: 'Short Cinta', sku: '1519000026', tipo: 'cinta', modelo: 'Short', sku_scheme: 'dynamic', ...base },
      { id: 2, name: 'Cinta Liga antiga', sku: '1501000026', tipo: 'cinta', modelo: 'liga', sku_scheme: 'legacy', ...base },
      { id: 3, name: 'Cinta Liga nova', sku: '1515000026', tipo: 'cinta', modelo: 'Liga', sku_scheme: 'dynamic', ...base },
      { id: 4, name: 'Cinta Short legado inválido', sku: 'x', tipo: 'cinta', modelo: 'Short', sku_scheme: 'legacy', ...base },
    ],
    product_types: [{ id: 10, company_id: 1, slug: 'cinta', sku_code: '15' }],
    variation_types: [{ id: 100, slug: 'modelo', value_governance: 'type_restricted' }],
    type_attributes: [{ id: 1, product_type_id: 10, variation_type_id: 100, active: true }],
    variation_values: [
      { id: 200, variation_type_id: 100, value: 'Liga', slug: 'liga', sku_code: '15', active: true },
      { id: 201, variation_type_id: 100, value: 'Short', slug: 'short', sku_code: '19', active: true },
      { id: 300, variation_type_id: 1, value: 'Preto', slug: 'preto', sku_code: '38', active: true },
      { id: 301, variation_type_id: 1, value: 'Nude', slug: 'nude', sku_code: '39', active: true },
      { id: 400, variation_type_id: 2, value: 'M', slug: 'm', sku_code: '03', active: true },
      { id: 401, variation_type_id: 2, value: 'G', slug: 'g', sku_code: '04', active: true },
    ],
    type_attribute_values: [
      { product_type_id: 10, variation_value_id: 200, active: true },
      { product_type_id: 10, variation_value_id: 201, active: true },
    ],
    product_variations: [],
    product_variation_attributes: [],
  }
  ;(createAdminClient as any).mockReturnValue(fakeAdmin(tables))
  ;(requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'gerente', company_id: 1 }, response: null })
  ;(initializeStock as any).mockResolvedValue({ ok: true })
  ;(getProductSnapshot as any).mockImplementation(async (id: number, companyId: number) => {
    const p = tables.products.find(x => x.id === id && x.company_id === companyId)
    return p ? { ...p } : null
  })
})

describe('PUT /api/produtos/[id] — identidade (discriminador) do produto', () => {
  const seed = (d: number | null, existing: string[]) => {
    tables.products.push({ id: 9, name: 'Dyn', sku: '151900002607', tipo: 'cinta', modelo: 'Short', sku_scheme: 'dynamic', sku_identity_id: d === null ? null : 77, company_id: 1, category_id: 1, supplier_id: null, brand_id: null, origin: 'own_brand', base_cost: 10, base_price: 50, active: true, product_kind: 'standard', ano: '2026' })
    if (d !== null) (tables.product_sku_identities ??= []).push({ id: 77, discriminator: d })
    existing.forEach((sku, i) => tables.product_variations.push({ id: 500 + i, product_id: 9, sku_variation: sku }))
  }

  it('produto da era RPC (variantes terminam no discriminador): nova variante embute o discriminador', async () => {
    seed(7, ['151911012607'])
    expect((await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })).status).toBe(200)
    expect(skus(9)).toContain('151938032607')
  })

  it('mesma cor/tamanho no produto com discriminador → 409, sem sufixo arbitrário', async () => {
    seed(7, ['151938032607'])
    const res = await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(409)
    expect(skus(9)).toEqual(['151938032607'])
  })

  // Admin que falha SÓ na consulta (select) da tabela indicada; demais operações são reais.
  const failSelectOn = (table: string) => {
    const real = fakeAdmin(tables)
    ;(createAdminClient as any).mockReturnValue({
      ...real,
      from(t: string) {
        if (t !== table) return real.from(t)
        const failing: any = new Proxy({}, { get: (_, p) => p === 'then'
          ? (res: any) => res({ data: null, error: { code: 'XX000', message: 'db indisponível' } })
          : p === 'maybeSingle' || p === 'single' ? () => Promise.resolve({ data: null, error: { code: 'XX000', message: 'db indisponível' } })
          : p === 'insert' ? real.from(t).insert : () => failing })
        return failing
      },
    })
  }

  it('falha ao consultar a identidade → 500, nada inserido, sem fallback para SKU sem discriminador', async () => {
    seed(7, ['151911012607'])
    failSelectOn('product_sku_identities')
    const res = await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(500)
    expect(skus(9)).toEqual(['151911012607'])
    expect(skus(9)).not.toContain('1519380326')
  })

  it('identidade referenciada inexistente → 500, nada inserido', async () => {
    seed(7, ['151911012607'])
    tables.product_sku_identities = []
    const res = await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(500)
    expect(skus(9)).toEqual(['151911012607'])
  })

  it('falha ao consultar variantes existentes → 500, nada inserido, sem embutir discriminador indevidamente', async () => {
    seed(7, ['1519110126']) // era antiga: o correto seria NÃO embutir
    failSelectOn('product_variations')
    const res = await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(500)
    expect(skus(9)).toEqual(['1519110126'])
    expect(skus(9)).not.toContain('151938032607')
  })

  it('corrida: SKU ocupado entre a checagem e o insert (23505) → 409, nunca outro sufixo', async () => {
    seed(7, ['151911012607'])
    const real = fakeAdmin(tables)
    ;(createAdminClient as any).mockReturnValue({
      ...real,
      from(t: string) {
        const q = real.from(t)
        if (t !== 'product_variations') return q
        const ins = q.insert.bind(q)
        q.insert = (v: any) => (v.sku_variation === '151938032607'
          ? { select: () => ({ single: async () => ({ data: null, error: { code: '23505', message: 'dup' } }) }) }
          : ins(v))
        return q
      },
    })
    const res = await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(409)
    expect(skus(9)).toEqual(['151911012607'])
  })

  it('produto da era antiga (variantes sem discriminador) mantém o comportamento anterior', async () => {
    seed(7, ['1519110126'])
    expect((await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })).status).toBe(200)
    expect(skus(9)).toContain('1519380326')
  })

  it('sem identidade ou discriminador 1 → sem sufixo', async () => {
    seed(null, [])
    expect((await put(9, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })).status).toBe(200)
    expect(skus(9)).toEqual(['1519380326'])
  })
})

describe('PUT /api/produtos/[id] — novas variações', () => {
  it('Cinta/Short (dinâmico): adiciona variação com SKU do PIM (tipo 15, modelo 19)', async () => {
    const res = await put(1, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(200)
    expect(skus(1)).toEqual(['1519380326'])
    expect(tables.product_variation_attributes).toHaveLength(2)
  })

  it('várias novas variações no mesmo salvamento: SKUs distintos e corretos', async () => {
    const res = await put(1, { variations_to_add: [
      { color_value_id: 300, size_value_id: 400 },
      { color_value_id: 300, size_value_id: 401 },
      { color_value_id: 301, size_value_id: 400 },
    ] })
    expect(res.status).toBe(200)
    expect(skus(1)).toEqual(['1519380326', '1519380426', '1519390326'])
  })

  it('mesma combinação repetida recebe sufixo único (02), sem colidir', async () => {
    const res = await put(1, { variations_to_add: [
      { color_value_id: 300, size_value_id: 400 },
      { color_value_id: 300, size_value_id: 400 },
    ] })
    expect(res.status).toBe(200)
    expect(skus(1)).toEqual(['1519380326', '151938032602'])
  })

  it('produto legado (Cinta/liga, sku_scheme=legacy) continua pelo mapa estático (liga=01)', async () => {
    const res = await put(2, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(200)
    expect(skus(2)).toEqual(['1501380326'])
  })

  it('Cinta/Liga dinâmico usa o código do PIM (15), não o legado (01)', async () => {
    const res = await put(3, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(200)
    expect(skus(3)).toEqual(['1515380326'])
  })

  it('dynamic: caixa/acento/espaços no Modelo gravado no produto resolvem para o mesmo código do PIM', async () => {
    for (const modelo of ['SHORT', 'short', ' Short ', 'Shörт'.replace('ö', 'o').replace('т', 't')]) {
      tables.product_variations = []
      tables.products[0].modelo = modelo
      const res = await put(1, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
      expect(res.status).toBe(200)
      expect(skus(1)).toEqual(['1519380326'])
    }
  })

  it('combinação realmente incompatível (legacy + Short) é rejeitada sem gravar nada', async () => {
    const res = await put(4, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })
    expect(res.status).toBe(422)
    expect(skus(4)).toEqual([])
  })

  it('dinâmico com Modelo desvinculado do Tipo no PIM é rejeitado com lista de válidos', async () => {
    tables.type_attribute_values = tables.type_attribute_values.filter(l => l.variation_value_id !== 201)
    const res = await put(1, { variations_to_add: [{ color_value_id: 300 }] })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('Modelos válidos: Liga')
    expect(skus(1)).toEqual([])
  })

  it('edição de variação existente não altera o SKU', async () => {
    tables.product_variations.push({ id: 1, product_id: 1, sku_variation: '1519380326', price_override: null, wholesale_price_override: null })
    const res = await put(1, { variations_to_update: [{ id: 1, price_override: 59.9 }] })
    expect(res.status).toBe(200)
    expect(tables.product_variations[0].sku_variation).toBe('1519380326')
    expect(tables.product_variations[0].price_override).toBe(59.9)
  })
})
