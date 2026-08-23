import { describe, it, expect } from 'vitest'
import {
  computeItemTotal,
  computeSubtotal,
  computeProductsTotal,
  computeGrandTotal,
  computeItemAdjustmentFromListPrice,
} from './pricing'

describe('computeItemTotal — preço original preservado, negociado menor/maior, desconto/acréscimo individual', () => {
  it('preço de tabela R$40 → vendido R$35 (desconto implícito, sem discount_amount explícito)', () => {
    expect(computeItemTotal({ unitPrice: 35, quantity: 1, discountAmount: 0, surchargeAmount: 0 })).toBe(35)
  })

  it('preço de tabela R$40 → vendido R$43 (acréscimo implícito, sem surcharge_amount explícito)', () => {
    expect(computeItemTotal({ unitPrice: 43, quantity: 1, discountAmount: 0, surchargeAmount: 0 })).toBe(43)
  })

  it('desconto individual explícito soma-se ao preço unitário', () => {
    expect(computeItemTotal({ unitPrice: 50, quantity: 2, discountAmount: 10, surchargeAmount: 0 })).toBe(90)
  })

  it('acréscimo individual explícito soma-se ao preço unitário', () => {
    expect(computeItemTotal({ unitPrice: 50, quantity: 2, discountAmount: 0, surchargeAmount: 10 })).toBe(110)
  })

  it('desconto e acréscimo simultâneos no mesmo item (combinação improvável mas matematicamente válida)', () => {
    expect(computeItemTotal({ unitPrice: 50, quantity: 1, discountAmount: 5, surchargeAmount: 3 })).toBe(48)
  })
})

describe('computeSubtotal — combinação de múltiplos itens', () => {
  it('exemplo do pedido: Produto A tabela 40 → vendido 45; Produto B tabela 40 → vendido 43. Total comercial = 88.', () => {
    const items = [
      { unitPrice: 45, quantity: 1, discountAmount: 0, surchargeAmount: 0 },
      { unitPrice: 43, quantity: 1, discountAmount: 0, surchargeAmount: 0 },
    ]
    expect(computeSubtotal(items)).toBe(88)
  })

  it('exemplo do pedido: Produto A tabela 40 → vendido 35; Produto B tabela 40 → vendido 40. Total = 75.', () => {
    const items = [
      { unitPrice: 35, quantity: 1, discountAmount: 0, surchargeAmount: 0 },
      { unitPrice: 40, quantity: 1, discountAmount: 0, surchargeAmount: 0 },
    ]
    expect(computeSubtotal(items)).toBe(75)
  })

  it('lista vazia → subtotal zero', () => {
    expect(computeSubtotal([])).toBe(0)
  })
})

describe('computeProductsTotal — nenhum ajuste individual é duplicado no desconto/acréscimo global; nunca inclui shipping_charged', () => {
  it('exemplo do pedido: produtos R$80 + acréscimo de item R$8 já embutido no unit_price (subtotal=88), sem ajuste de PEDIDO → products_total = 88', () => {
    // Produto único, unit_price já negociado com o acréscimo embutido (preço de tabela 80 → vendido 88)
    const items = [{ unitPrice: 88, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items)
    expect(computeProductsTotal(subtotal, 0, 0)).toBe(88)
  })

  it('exemplo LITERAL do pedido revisado: produtos R$80 SEM ajuste de item + acréscimo GLOBAL de mercadoria R$8 (sales.surcharge_amount) → products_total = 88', () => {
    // Mesmo resultado (88) por um caminho DIFERENTE: aqui o acréscimo é
    // registrado como ajuste de PEDIDO (não embutido no item), porque não
    // tem origem por item conhecida — é exatamente o cenário descrito no
    // Blocker 2 ("acréscimo comercial sobre mercadorias" = 8, genérico).
    const items = [{ unitPrice: 80, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items) // 80
    const productsTotal = computeProductsTotal(subtotal, 0, 8) // 80 - 0 + 8
    expect(productsTotal).toBe(88)
  })

  it('ajuste por item (já dentro do subtotal) + desconto de PEDIDO adicional não se sobrepõem — são fontes independentes, somadas uma vez cada', () => {
    // Item já vendido com desconto embutido (unit_price 45 em vez de tabela 50) — R$45 no subtotal.
    // Desconto de pedido adicional de R$5 (ex.: cupom, sem origem por item) — subtraído por cima, uma única vez.
    const items = [{ unitPrice: 45, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items) // 45
    const productsTotal = computeProductsTotal(subtotal, 5, 0) // 45 - 5 + 0
    expect(productsTotal).toBe(40)
    // Nunca 45 - 5 - 5 = 35 (dupla contagem) — o ajuste do item já está
    // dentro do subtotal UMA vez; o desconto de pedido é aplicado por cima
    // UMA vez. Nenhuma outra subtração acontece.
  })

  it('ajuste por item (embutido) + acréscimo de PEDIDO adicional não se sobrepõem — simétrico ao teste de desconto acima', () => {
    const items = [{ unitPrice: 43, quantity: 1, discountAmount: 0, surchargeAmount: 0 }] // já vendido com +3 embutido (tabela 40)
    const subtotal = computeSubtotal(items) // 43
    const productsTotal = computeProductsTotal(subtotal, 0, 5) // 43 + 5, nunca 43 + 3 + 5
    expect(productsTotal).toBe(48)
  })

  it('desconto E acréscimo de pedido simultâneos — cada um aplicado exatamente uma vez', () => {
    const items = [{ unitPrice: 100, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items) // 100
    expect(computeProductsTotal(subtotal, 10, 5)).toBe(95) // 100 - 10 + 5
  })

  it('products_total NUNCA inclui shipping_charged, mesmo quando o frete é alto', () => {
    const items = [{ unitPrice: 80, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items) // 80
    const productsTotal = computeProductsTotal(subtotal, 0, 0)
    expect(productsTotal).toBe(80)
    // Frete de R$12 não é parâmetro desta função — nunca pode vazar aqui.
    // Confirma a decisão central da Fase 5C: shipping_charged não compõe
    // o valor de mercadoria/fiscal.
  })

  it('exemplo completo do pedido (Blocker 2): mercadoria R$80 + acréscimo global R$8 = R$88 de products_total, frete R$12 fica de fora, total financeiro R$100', () => {
    const items = [{ unitPrice: 80, quantity: 1, discountAmount: 0, surchargeAmount: 0 }]
    const subtotal = computeSubtotal(items)
    const productsTotal = computeProductsTotal(subtotal, 0, 8)
    const total = computeGrandTotal({
      subtotal,
      discountAmount: 0,
      surchargeAmount: 8,
      shippingCharged: 12,
      cashbackUsed: 0,
    })
    expect(productsTotal).toBe(88)
    expect(total).toBe(100)
    expect(total - productsTotal).toBe(12) // a diferença é exatamente o frete
  })
})

describe('computeGrandTotal', () => {
  it('subtotal + frete + acréscimo - desconto - cashback, nunca negativo', () => {
    expect(computeGrandTotal({
      subtotal: 100, discountAmount: 10, surchargeAmount: 5, shippingCharged: 12, cashbackUsed: 20,
    })).toBe(87)
  })

  it('cashback maior que o total → resultado nunca fica negativo', () => {
    expect(computeGrandTotal({
      subtotal: 50, discountAmount: 0, surchargeAmount: 0, shippingCharged: 0, cashbackUsed: 999,
    })).toBe(0)
  })
})

describe('computeItemAdjustmentFromListPrice — derivação para exibição (single source of truth = unit_price)', () => {
  it('vendido abaixo da tabela → desconto implícito', () => {
    expect(computeItemAdjustmentFromListPrice(35, 40)).toEqual({ desconto: 5, acrescimo: 0 })
  })

  it('vendido acima da tabela → acréscimo implícito', () => {
    expect(computeItemAdjustmentFromListPrice(45, 40)).toEqual({ desconto: 0, acrescimo: 5 })
  })

  it('vendido igual à tabela → nenhum ajuste', () => {
    expect(computeItemAdjustmentFromListPrice(40, 40)).toEqual({ desconto: 0, acrescimo: 0 })
  })

  it('sem preço de tabela capturado (list_price_snapshot null) → nenhum ajuste exibido, nunca inventa', () => {
    expect(computeItemAdjustmentFromListPrice(45, null)).toEqual({ desconto: 0, acrescimo: 0 })
  })
})
