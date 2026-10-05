import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProductSnapshot } from '@/services/produtos.service'
import { initializeStock } from '@/services/estoque.service'
import { fakeAdmin, type Tables } from '@/lib/sku/fakeCatalogAdmin.testutil'
import { POST } from './route'
import { PUT } from './[id]/route'

vi.mock('@/lib/supabase/session', () => ({ requireRole: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/services/estoque.service', () => ({ initializeStock: vi.fn() }))
vi.mock('@/services/produtos.service', () => ({
  getProductSnapshot: vi.fn(), checkPriceChange: vi.fn().mockResolvedValue({ warning: undefined }),
  canDeleteProduct: vi.fn(), deleteProductCascade: vi.fn(),
}))

let tables: Tables
const json = (b: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(b) })
const post = (b: unknown) => POST(json(b))
const put = (id: number, b: unknown) => PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(b) }), { params: { id: String(id) } })

beforeEach(() => {
  vi.clearAllMocks()
  tables = {
    products: [], product_variations: [], product_variation_attributes: [], product_attribute_values: [],
    product_types: [
      { id: 10, company_id: 1, slug: 'cinta', sku_code: '15' },
      { id: 2, company_id: 1, slug: 'calcinha', sku_code: '02' },
      { id: 4, company_id: 1, slug: 'baby_doll', sku_code: '06' }, // sem governança → legacy
    ],
    variation_types: [{ id: 100, slug: 'modelo', value_governance: 'type_restricted' }],
    type_attributes: [
      { id: 1, product_type_id: 10, variation_type_id: 100, active: true },
      { id: 2, product_type_id: 2, variation_type_id: 100, active: true },
    ],
    variation_values: [
      { id: 201, variation_type_id: 100, value: 'Short', slug: 'short', sku_code: '19', active: true },
      { id: 202, variation_type_id: 100, value: 'Fio', slug: 'fio', sku_code: '01', active: true },
      { id: 300, variation_type_id: 1, value: 'Preto', slug: 'preto', sku_code: '01', active: true },
      { id: 301, variation_type_id: 1, value: 'Nude', slug: 'nude', sku_code: '03', active: true },
      { id: 400, variation_type_id: 2, value: 'M', slug: 'm', sku_code: '02', active: true },
    ],
    type_attribute_values: [
      { product_type_id: 10, variation_value_id: 201, active: true },
      { product_type_id: 2, variation_value_id: 202, active: true },
    ],
  }
  ;(createAdminClient as any).mockReturnValue(fakeAdmin(tables))
  ;(requireRole as any).mockResolvedValue({ user: { id: 'u', role: 'gerente', company_id: 1 }, response: null })
  ;(initializeStock as any).mockResolvedValue({ ok: true })
  ;(getProductSnapshot as any).mockImplementation(async (id: number) => tables.products.find(p => p.id === id) ?? null)
})

const base = { origin: 'own_brand', base_cost: 10, base_price: 50, category_id: 1, ano: '2026' }

// POST cria produto + variante; PUT adiciona outra variante válida depois.
// Ambos precisam compor o SKU com a MESMA família (TTMM…AA) e cor/tamanho idênticos.
const CASES = [
  { label: 'dynamic Cinta/Short',     body: { tipo: 'cinta',     modelo_value_id: 201 }, scheme: 'dynamic', ttmm: '1519' },
  { label: 'dynamic Calcinha/Fio',    body: { tipo: 'calcinha',  modelo_value_id: 202 }, scheme: 'dynamic', ttmm: '0201' },
  { label: 'legacy Baby Doll/renda',  body: { tipo: 'baby_doll', modelo: 'Renda' },      scheme: 'legacy',  ttmm: '0602' },
  { label: 'legacy Baby Doll/Clássico (acento/caixa)', body: { tipo: 'Baby Doll', modelo: 'clássico' }, scheme: 'legacy', ttmm: '0601' },
]

describe('paridade POST (criação) × PUT (edição)', () => {
  for (const c of CASES) {
    it(c.label, async () => {
      const res = await post({ ...base, name: `P ${c.label}`, ...c.body, variants: [{ color_value_id: 300, size_value_id: 400 }] })
      expect(res.status).toBe(201)
      const created = tables.products[0]
      expect(created.sku_scheme).toBe(c.scheme)
      const postSku = tables.product_variations[0].sku_variation
      expect(postSku).toBe(`${c.ttmm}010226`)

      const r2 = await put(created.id, { variations_to_add: [{ color_value_id: 301, size_value_id: 400 }] })
      expect(r2.status).toBe(200)
      const putSku = tables.product_variations.find(v => v.sku_variation !== postSku)!.sku_variation
      // mesma família tipo/modelo/ano; cor 03 + tamanho 02 do valor escolhido
      expect(putSku).toBe(`${c.ttmm}030226`)
      expect(putSku.slice(0, 4)).toBe(postSku.slice(0, 4))
      expect(putSku.slice(8)).toBe(postSku.slice(8))
      expect(new Set(tables.product_variations.map(v => v.sku_variation)).size).toBe(2)
    })
  }

  it('toda variação criável no POST é adicionável depois no PUT (mesmo combo repetido ganha sufixo único)', async () => {
    await post({ ...base, name: 'Produto X', tipo: 'cinta', modelo_value_id: 201, variants: [{ color_value_id: 300, size_value_id: 400 }] })
    const id = tables.products[0].id
    expect((await put(id, { variations_to_add: [{ color_value_id: 300, size_value_id: 400 }] })).status).toBe(200)
    const s = tables.product_variations.map(v => v.sku_variation).sort()
    expect(s).toEqual(['1519010226', '151901022602'])
  })
})
