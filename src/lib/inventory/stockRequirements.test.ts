import { describe, it, expect } from 'vitest'
import {
  resolveStockRequirements,
  computeKitAvailability,
  componentKitCapacity,
  computeKitUnitCost,
  consolidateKitComponents,
  findBottleneck,
} from './stockRequirements'

const A = 1
const B = 2
const C = 3
const KIT_A = 100 // 2×B + 1×C
const KIT_SHARED = 101 // 1×B

const compositions = new Map([
  [KIT_A, [
    { component_product_variation_id: B, quantity: 2 },
    { component_product_variation_id: C, quantity: 1 },
  ]],
  [KIT_SHARED, [{ component_product_variation_id: B, quantity: 1 }]],
])

describe('resolveStockRequirements', () => {
  it('produto normal → ele mesmo × quantidade', () => {
    expect(resolveStockRequirements([{ product_variation_id: A, quantity: 2 }], compositions))
      .toEqual([{ product_variation_id: A, quantity: 2 }])
  })

  it('kit → componentes × quantidade (resolveStockRequirements(KIT-A, 2) = B×4, C×2)', () => {
    expect(resolveStockRequirements([{ product_variation_id: KIT_A, quantity: 2 }], compositions)).toEqual([
      { product_variation_id: B, quantity: 4 },
      { product_variation_id: C, quantity: 2 },
    ])
  })

  it('3 kits de (2A + 1B) consomem 6A e 3B', () => {
    const comp = new Map([[9, [
      { component_product_variation_id: A, quantity: 2 },
      { component_product_variation_id: B, quantity: 1 },
    ]]])
    expect(resolveStockRequirements([{ product_variation_id: 9, quantity: 3 }], comp)).toEqual([
      { product_variation_id: A, quantity: 6 },
      { product_variation_id: B, quantity: 3 },
    ])
  })

  it('agrega kit + componente avulso + outro kit que compartilha componente, ordenado por id', () => {
    const result = resolveStockRequirements([
      { product_variation_id: C, quantity: 1 },
      { product_variation_id: KIT_A, quantity: 1 },
      { product_variation_id: B, quantity: 1 },
      { product_variation_id: KIT_SHARED, quantity: 3 },
    ], compositions)
    expect(result).toEqual([
      { product_variation_id: B, quantity: 2 + 1 + 3 },
      { product_variation_id: C, quantity: 1 + 1 },
    ])
  })

  it('kit com composição vazia é erro', () => {
    expect(() => resolveStockRequirements([{ product_variation_id: 7, quantity: 1 }], new Map([[7, []]])))
      .toThrow(/sem composição/)
  })
})

describe('computeKitAvailability', () => {
  it('KIT 2×A + 1×B com A=10, B=3 → 3', () => {
    expect(computeKitAvailability([{ quantity: 2, available: 10 }, { quantity: 1, available: 3 }])).toBe(3)
  })

  it('componente com quantidade 2 usa floor', () => {
    expect(componentKitCapacity(7, 2)).toBe(3)
  })

  it('componente zerado → kit 0', () => {
    expect(computeKitAvailability([{ quantity: 1, available: 20 }, { quantity: 2, available: 0 }])).toBe(0)
  })

  it('saldo negativo nunca gera disponibilidade negativa', () => {
    expect(computeKitAvailability([{ quantity: 1, available: -4 }])).toBe(0)
  })

  it('sem componentes → 0', () => {
    expect(computeKitAvailability([])).toBe(0)
  })

  it('exemplo da tela: preta 20/1 e bege 14/2 → 7, gargalo = bege', () => {
    const comps = [
      { sku: 'CALC-PRETA-M', quantity: 1, available: 20 },
      { sku: 'CALC-BEGE-M', quantity: 2, available: 14 },
    ]
    expect(computeKitAvailability(comps)).toBe(7)
    expect(findBottleneck(comps)?.sku).toBe('CALC-BEGE-M')
  })

  it('dois kits compartilhando A=10: KIT1 (2×A)=5 e KIT2 (1×A)=10 (sem reserva)', () => {
    expect(computeKitAvailability([{ quantity: 2, available: 10 }])).toBe(5)
    expect(computeKitAvailability([{ quantity: 1, available: 10 }])).toBe(10)
  })
})

describe('computeKitUnitCost', () => {
  it('custo = soma(custo componente × quantidade)', () => {
    expect(computeKitUnitCost([{ quantity: 1, unit_cost: 12 }, { quantity: 2, unit_cost: 8 }])).toBe(28)
  })

  it('arredonda cada custo a 2 casas antes de multiplicar (igual à RPC)', () => {
    expect(computeKitUnitCost([{ quantity: 3, unit_cost: 1.005 }])).toBe(3.03)
  })
})

describe('consolidateKitComponents', () => {
  it('soma duplicatas de forma determinística', () => {
    expect(consolidateKitComponents([
      { component_product_variation_id: 5, quantity: 1 },
      { component_product_variation_id: 2, quantity: 1 },
      { component_product_variation_id: 5, quantity: 2 },
    ])).toEqual([
      { component_product_variation_id: 2, quantity: 1 },
      { component_product_variation_id: 5, quantity: 3 },
    ])
  })

  it('bloqueia kit vazio', () => {
    expect(() => consolidateKitComponents([])).toThrow(/pelo menos um componente/)
  })

  it('bloqueia quantidade <= 0 e fracionária', () => {
    expect(() => consolidateKitComponents([{ component_product_variation_id: 1, quantity: 0 }])).toThrow(/maior que zero/)
    expect(() => consolidateKitComponents([{ component_product_variation_id: 1, quantity: 1.5 }])).toThrow(/maior que zero/)
  })

  it('bloqueia kit contendo ele mesmo', () => {
    expect(() => consolidateKitComponents([{ component_product_variation_id: 9, quantity: 1 }], 9)).toThrow(/ele mesmo/)
  })
})
