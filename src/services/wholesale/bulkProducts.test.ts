import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeAdmin, type FakeTables } from './fakeSupabase.testutil'
import { applyBulkWholesaleChanges, bulkProductsSchema, computeWholesalePriceFromPercent, BULK_MAX_PRODUCT_IDS } from './bulkProducts'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

const CTX = { companyId: 1, userId: 'u1', userRole: 'gerente' }

function setup() {
  const tables: FakeTables = {
    products: [
      { id: 1, company_id: 1, base_price: 59.9, wholesale_enabled: false, wholesale_price: null },
      { id: 2, company_id: 1, base_price: 100, wholesale_enabled: false, wholesale_price: null },
      { id: 3, company_id: 1, base_price: 10, wholesale_enabled: true, wholesale_price: 9 },
      { id: 99, company_id: 2, base_price: 50, wholesale_enabled: false, wholesale_price: null }, // outra empresa
    ],
    product_variations: [
      { id: 10, product_id: 1, wholesale_price_override: 30 },
      { id: 11, product_id: 2, wholesale_price_override: null },
    ],
  }
  return { tables, admin: createFakeAdmin(tables) as any }
}
const enabled = (t: FakeTables) => t.products.map((p) => [p.id, p.wholesale_enabled])

beforeEach(() => vi.clearAllMocks())

describe('bulkProductsSchema', () => {
  const ok = { product_ids: [1], changes: { wholesale_enabled: true } }
  it('aceita payload válido', () => expect(bulkProductsSchema.safeParse(ok).success).toBe(true))
  it('rejeita lista vazia, ids inválidos e payload excessivo', () => {
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: [] }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: [0] }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: [-3] }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: ['a'] }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: [1.5] }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: Array.from({ length: BULK_MAX_PRODUCT_IDS + 1 }, (_, i) => i + 1) }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, product_ids: Array.from({ length: BULK_MAX_PRODUCT_IDS }, (_, i) => i + 1) }).success).toBe(true)
  })
  it('exige ao menos uma alteração e rejeita campos desconhecidos (ex.: company_id, active)', () => {
    expect(bulkProductsSchema.safeParse({ product_ids: [1], changes: {} }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ product_ids: [1], changes: { active: false } }).success).toBe(false)
    expect(bulkProductsSchema.safeParse({ ...ok, company_id: 2 }).success).toBe(false)
  })
  it('percentual: 1..100 e até 2 casas', () => {
    expect(bulkProductsSchema.safeParse({ product_ids: [1], changes: { wholesale_price_percent: 70 } }).success).toBe(true)
    expect(bulkProductsSchema.safeParse({ product_ids: [1], changes: { wholesale_price_percent: 72.55 } }).success).toBe(true)
    for (const bad of [0, -5, 101, 70.123]) {
      expect(bulkProductsSchema.safeParse({ product_ids: [1], changes: { wholesale_price_percent: bad } }).success).toBe(false)
    }
  })
})

describe('applyBulkWholesaleChanges', () => {
  it('ativação em massa altera só os selecionados', async () => {
    const { tables, admin } = setup()
    const r = await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1, 2], changes: { wholesale_enabled: true } })
    expect(r).toMatchObject({ ok: true, updated: 2 })
    expect(enabled(tables)).toEqual([[1, true], [2, true], [3, true], [99, false]])
  })

  it('desativação em massa', async () => {
    const { tables, admin } = setup()
    const r = await applyBulkWholesaleChanges(admin, CTX, { product_ids: [3], changes: { wholesale_enabled: false } })
    expect(r).toMatchObject({ ok: true, updated: 1 })
    expect(tables.products.find((p) => p.id === 3)!.wholesale_enabled).toBe(false)
  })

  it('produto de outro tenant → 404 e NADA é alterado (nem os ids válidos)', async () => {
    const { tables, admin } = setup()
    const r = await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1, 99], changes: { wholesale_enabled: true } })
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(enabled(tables)).toEqual([[1, false], [2, false], [3, true], [99, false]])
  })

  it('id inexistente → 404 sem alterar', async () => {
    const { tables, admin } = setup()
    expect(await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1, 12345], changes: { wholesale_enabled: true } })).toMatchObject({ ok: false, status: 404 })
    expect(tables.products[0].wholesale_enabled).toBe(false)
  })

  it('ids duplicados são deduplicados', async () => {
    const { admin } = setup()
    expect(await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1, 1, 1], changes: { wholesale_enabled: true } })).toMatchObject({ ok: true, updated: 1 })
  })

  it('ativar NÃO mexe no preço (nunca recalcula automaticamente)', async () => {
    const { tables, admin } = setup()
    await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1], changes: { wholesale_enabled: true } })
    expect(tables.products[0].wholesale_price).toBeNull()
  })

  it('preço em massa: base × percentual, arredondado a centavos; não toca overrides de variação', async () => {
    const { tables, admin } = setup()
    const r = await applyBulkWholesaleChanges(admin, CTX, { product_ids: [1, 2], changes: { wholesale_price_percent: 70 } })
    expect(r).toMatchObject({ ok: true, pricedProducts: 2, variationOverridesUntouched: 1 })
    expect(tables.products[0].wholesale_price).toBe(41.93) // 59,90 × 0,70 = 41,93
    expect(tables.products[1].wholesale_price).toBe(70)
    expect(tables.product_variations[0].wholesale_price_override).toBe(30) // intacto
    expect(tables.products[3].wholesale_price).toBeNull() // outra empresa intocada
  })

  it('ativar + precificar na mesma ação', async () => {
    const { tables, admin } = setup()
    await applyBulkWholesaleChanges(admin, CTX, { product_ids: [2], changes: { wholesale_enabled: true, wholesale_price_percent: 50 } })
    expect(tables.products[1]).toMatchObject({ wholesale_enabled: true, wholesale_price: 50 })
  })
})

describe('computeWholesalePriceFromPercent', () => {
  it('arredonda para 2 casas sem erro de ponto flutuante', () => {
    expect(computeWholesalePriceFromPercent(59.9, 70)).toBe(41.93)
    expect(computeWholesalePriceFromPercent(0.01, 50)).toBe(0.01) // meio centavo arredonda pra cima
    expect(computeWholesalePriceFromPercent(19.99, 72.5)).toBe(14.49)
    expect(computeWholesalePriceFromPercent(100, 100)).toBe(100)
  })
})
