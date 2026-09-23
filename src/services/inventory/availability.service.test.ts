// Camada central de disponibilidade — cobre a parte TS (quem é kit, expansão
// de requisitos, propagação para kits dependentes, isolamento por empresa).
// A fórmula de disponibilidade em si é do banco (fn_variation_sellable_quantity)
// e está coberta em supabase/tests/product_kits.test.sql; aqui a RPC é
// emulada só para provar o contrato (empresa da sessão, mapa por variação).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, type FakeTables } from '../wholesale/fakeSupabase.testutil'
import {
  findKitVariationIds,
  getAffectedSellableVariationIds,
  getSellableQuantity,
  getVariationAvailability,
  resolveStockRequirementsForItems,
} from './availability.service'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPANY = 1
const OTHER = 2

// Empresa 1: A(1), B(2), C(3) standard; KIT_AB(10)=2×A+1×B; KIT_B(11)=1×B.
// Empresa 2: X(20) standard; KIT_X(21)=1×X.
function tables(): FakeTables {
  return {
    products: [
      { id: 100, company_id: COMPANY, product_kind: 'standard', active: true },
      { id: 101, company_id: COMPANY, product_kind: 'kit', active: true },
      { id: 200, company_id: OTHER, product_kind: 'standard', active: true },
      { id: 201, company_id: OTHER, product_kind: 'kit', active: true },
    ],
    product_variations: [
      { id: 1, product_id: 100, active: true }, { id: 2, product_id: 100, active: true }, { id: 3, product_id: 100, active: true },
      { id: 10, product_id: 101, active: true }, { id: 11, product_id: 101, active: true },
      { id: 20, product_id: 200, active: true }, { id: 21, product_id: 201, active: true },
    ],
    product_kit_components: [
      { company_id: COMPANY, kit_product_variation_id: 10, component_product_variation_id: 1, quantity: 2 },
      { company_id: COMPANY, kit_product_variation_id: 10, component_product_variation_id: 2, quantity: 1 },
      { company_id: COMPANY, kit_product_variation_id: 11, component_product_variation_id: 2, quantity: 1 },
      { company_id: OTHER, kit_product_variation_id: 21, component_product_variation_id: 20, quantity: 1 },
    ],
  }
}

const rpcCalls: Array<{ name: string; args: any }> = []

beforeEach(() => {
  rpcCalls.length = 0
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
    createFakeAdmin(tables(), {
      rpc: (name, args, t) => {
        rpcCalls.push({ name, args })
        // Emula o contrato: só variações da empresa informada; kit = 3, normal = 5.
        const rows = (args.p_variation_ids as number[])
          .map((id) => t.product_variations.find((v) => v.id === id))
          .filter(Boolean)
          .map((v) => ({ v, p: t.products.find((p) => p.id === v!.product_id)! }))
          .filter(({ p }) => p.company_id === args.p_company_id)
          .map(({ v, p }) => {
            const qty = p.product_kind === 'kit' ? 3 : 5
            return { product_variation_id: v!.id, product_id: p.id, product_kind: p.product_kind, manual_enabled: true, sellable_quantity: qty, inventory_available: qty > 0, is_sellable: qty > 0 }
          })
        return { data: rows, error: null }
      },
    }) as any,
  )
})

describe('findKitVariationIds', () => {
  it('só devolve kits da empresa da sessão', async () => {
    const r = await findKitVariationIds(COMPANY, [1, 10, 11, 21])
    expect(r.ok && [...r.data].sort()).toEqual([10, 11])
  })
})

describe('resolveStockRequirementsForItems', () => {
  it('expande kit e agrega com componente avulso (KIT_AB×2 + 1×A → A=5, B=2)', async () => {
    const r = await resolveStockRequirementsForItems(COMPANY, [
      { product_variation_id: 10, quantity: 2 },
      { product_variation_id: 1, quantity: 1 },
    ])
    expect(r.ok && r.data).toEqual([
      { product_variation_id: 1, quantity: 5 },
      { product_variation_id: 2, quantity: 2 },
    ])
  })

  it('kit de outra empresa é tratado como variação desconhecida (nunca expande composição alheia)', async () => {
    const r = await resolveStockRequirementsForItems(COMPANY, [{ product_variation_id: 21, quantity: 1 }])
    expect(r.ok && r.data).toEqual([{ product_variation_id: 21, quantity: 1 }])
  })
})

describe('getAffectedSellableVariationIds', () => {
  it('componente movimentado → ele mesmo + todos os kits que o usam', async () => {
    const r = await getAffectedSellableVariationIds(COMPANY, [2])
    expect(r.ok && r.data).toEqual([2, 10, 11])
  })

  it('kit vendido → kit + componentes + outros kits que dividem componente', async () => {
    const r = await getAffectedSellableVariationIds(COMPANY, [11])
    expect(r.ok && r.data).toEqual([2, 10, 11])
  })

  it('produto sem kit dependente → só ele (comportamento de sempre)', async () => {
    const r = await getAffectedSellableVariationIds(COMPANY, [3])
    expect(r.ok && r.data).toEqual([3])
  })

  it('nunca propaga para kits de outra empresa', async () => {
    const r = await getAffectedSellableVariationIds(COMPANY, [20])
    expect(r.ok && r.data).toEqual([20])
  })
})

describe('getVariationAvailability / getSellableQuantity', () => {
  it('envia a empresa da sessão e o modo à RPC central', async () => {
    await getVariationAvailability(COMPANY, [1, 10], 'main_store')
    expect(rpcCalls[0]).toEqual({
      name: 'rpc_get_variation_availability',
      args: { p_company_id: COMPANY, p_variation_ids: [1, 10], p_stock_mode: 'main_store' },
    })
  })

  it('kit e produto normal respondem pela mesma API', async () => {
    const kit = await getSellableQuantity(COMPANY, 10)
    const std = await getSellableQuantity(COMPANY, 1)
    expect(kit.ok && kit.data).toBe(3)
    expect(std.ok && std.data).toBe(5)
  })

  it('variação de outra empresa → 0 (sem vazar saldo)', async () => {
    const r = await getSellableQuantity(COMPANY, 21)
    expect(r.ok && r.data).toBe(0)
  })

  it('lista vazia não chama o banco', async () => {
    const r = await getVariationAvailability(COMPANY, [])
    expect(r.ok && r.data.size).toBe(0)
    expect(rpcCalls).toHaveLength(0)
  })
})
