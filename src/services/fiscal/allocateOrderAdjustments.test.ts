import { describe, it, expect } from 'vitest'
import { allocateProportionalCents, applyOrderLevelAdjustments, FiscalAllocationError, type RateableItemPayload } from './allocateOrderAdjustments'

describe('allocateProportionalCents — exatidão de centavos (Largest Remainder / Hare-Niemeyer)', () => {
  it('soma sempre bate exatamente com o total, mesmo quando a divisão não é exata', () => {
    expect(allocateProportionalCents(1000, [3000, 2000])).toEqual([600, 400]) // divisão exata
    expect(allocateProportionalCents(1000, [3001, 2000])).toEqual(
      allocateProportionalCents(1000, [3001, 2000]), // determinístico (mesma entrada → mesma saída)
    )
    const alloc = allocateProportionalCents(1000, [3001, 2000])
    expect(alloc[0] + alloc[1]).toBe(1000)
  })

  it('3 pesos que não dividem igualmente — nunca perde nem sobra centavo', () => {
    const alloc = allocateProportionalCents(1000, [1000, 1000, 1001])
    expect(alloc.reduce((s, v) => s + v, 0)).toBe(1000)
    expect(alloc).toEqual([333, 333, 334]) // maior fração (1001/3001) vence o desempate
  })

  it('desempate de fração igual é resolvido por índice crescente — determinístico', () => {
    const alloc = allocateProportionalCents(99, [50, 50])
    expect(alloc.reduce((s, v) => s + v, 0)).toBe(99)
    expect(alloc[0]).toBe(50) // índice 0 vence o empate de fração (ambos 0.5)
    expect(alloc[1]).toBe(49)
  })

  it('todos os pesos zero → cai pra partes iguais, ainda exato', () => {
    const alloc = allocateProportionalCents(100, [0, 0, 0])
    expect(alloc.reduce((s, v) => s + v, 0)).toBe(100)
    expect(alloc).toEqual([34, 33, 33])
  })

  it('total zero → todas as posições zero, nenhuma divisão acontece', () => {
    expect(allocateProportionalCents(0, [100, 200, 300])).toEqual([0, 0, 0])
  })

  it('peso único → recebe 100% do total', () => {
    expect(allocateProportionalCents(12345, [999])).toEqual([12345])
  })

  it('nunca aloca mais que o peso do item quando total ≤ soma dos pesos (prova por amostragem determinística)', () => {
    // Vários casos de fronteira (total = soma dos pesos exatamente, ou logo abaixo).
    const cases: Array<[number, number[]]> = [
      [100, [100]],
      [100, [50, 50]],
      [99, [50, 50]],
      [301, [100, 100, 101]],
      [300, [100, 100, 101]],
      [1, [1, 1, 1]],
    ]
    for (const [total, weights] of cases) {
      const alloc = allocateProportionalCents(total, weights)
      expect(alloc.reduce((s, v) => s + v, 0)).toBe(total)
      alloc.forEach((a, i) => expect(a).toBeLessThanOrEqual(weights[i]))
    }
  })
})

function nfceLikeItem(valorBruto: number, valorDesconto = 0): RateableItemPayload {
  return { valor_bruto: valorBruto, ...(valorDesconto > 0 ? { valor_desconto: valorDesconto } : {}) }
}

describe('applyOrderLevelAdjustments — rateio determinístico entre múltiplos itens (Fase Fiscal 4I)', () => {
  it('sem ajustes → não toca nenhum item', () => {
    const items = [nfceLikeItem(30), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 0, surchargeAmount: 0, shippingCharged: 0 })
    expect(items).toEqual([{ valor_bruto: 30 }, { valor_bruto: 20 }])
  })

  it('1 item → recebe 100% de cada ajuste (mesmo comportamento da versão anterior, agora generalizado)', () => {
    const items = [nfceLikeItem(19.99)]
    applyOrderLevelAdjustments(items, { discountAmount: 0, surchargeAmount: 10, shippingCharged: 0 })
    expect(items[0].valor_outras_despesas).toBe(10)
  })

  it('múltiplos itens, desconto global → rateado proporcionalmente ao valor de cada item, soma exata', () => {
    const items = [nfceLikeItem(30), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 10, surchargeAmount: 0, shippingCharged: 0 })
    expect(items[0].valor_desconto).toBe(6) // 30/50 × 10
    expect(items[1].valor_desconto).toBe(4) // 20/50 × 10
    const somaDesconto = (items[0].valor_desconto ?? 0) + (items[1].valor_desconto ?? 0)
    expect(somaDesconto).toBe(10)
  })

  it('múltiplos itens, acréscimo global → rateado proporcionalmente, soma exata', () => {
    const items = [nfceLikeItem(30), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 0, surchargeAmount: 10, shippingCharged: 0 })
    expect(items[0].valor_outras_despesas).toBe(6)
    expect(items[1].valor_outras_despesas).toBe(4)
  })

  it('múltiplos itens, frete → rateado proporcionalmente, soma exata', () => {
    const items = [nfceLikeItem(30), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 0, surchargeAmount: 0, shippingCharged: 10 })
    expect(items[0].valor_frete).toBe(6)
    expect(items[1].valor_frete).toBe(4)
  })

  it('desconto global SOMA ao desconto por item já existente — nunca substitui', () => {
    const items = [nfceLikeItem(30, 3), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 10, surchargeAmount: 0, shippingCharged: 0 })
    // peso item0 = 30-3=27, peso item1=20 → total peso=47
    // desconto global 10: item0 = 10×27/47 = 5.74 → 574 centavos de 1000; item1 = 10×20/47=4.25→426 centavos
    // 574+426=1000 exato (sem perda de centavo)
    const desconto0 = items[0].valor_desconto ?? 0
    const desconto1 = items[1].valor_desconto ?? 0
    expect(Math.round((desconto0 - 3) * 100) + Math.round(desconto1 * 100)).toBe(1000) // parte global soma exatamente 10.00
    expect(desconto0).toBeGreaterThan(3) // preservou o desconto de item (3) e somou o rateio
  })

  it('desconto global maior que o valor total dos itens → lança, nunca gera item negativo', () => {
    const items = [nfceLikeItem(10), nfceLikeItem(5)]
    expect(() => applyOrderLevelAdjustments(items, { discountAmount: 20, surchargeAmount: 0, shippingCharged: 0 })).toThrow(FiscalAllocationError)
  })

  it('desconto global EXATAMENTE igual ao valor total dos itens → permitido, cada item fica com desconto = seu próprio valor_bruto', () => {
    const items = [nfceLikeItem(30), nfceLikeItem(20)]
    applyOrderLevelAdjustments(items, { discountAmount: 50, surchargeAmount: 0, shippingCharged: 0 })
    expect(items[0].valor_desconto).toBe(30)
    expect(items[1].valor_desconto).toBe(20)
  })

  it('quantidade > 1 refletida no valor_bruto do item (peso usa o valor total do item, não o unitário) — funciona igual, valor_bruto já vem multiplicado pelo builder', () => {
    // valor_bruto de um item com quantidade>1 já é unitPrice*quantity (responsabilidade do builder,
    // não deste módulo) — aqui só confirmamos que o rateio trata qualquer valor_bruto corretamente.
    const items = [nfceLikeItem(100), nfceLikeItem(50)] // ex.: 2× R$50 vs 1× R$50
    applyOrderLevelAdjustments(items, { discountAmount: 30, surchargeAmount: 0, shippingCharged: 0 })
    expect(items[0].valor_desconto).toBe(20) // 100/150×30
    expect(items[1].valor_desconto).toBe(10) // 50/150×30
  })

  it('3 itens com desconto que não divide igualmente — nenhum centavo perdido, nenhum item negativo', () => {
    const items = [nfceLikeItem(10), nfceLikeItem(10), nfceLikeItem(10.01)]
    applyOrderLevelAdjustments(items, { discountAmount: 10, surchargeAmount: 0, shippingCharged: 0 })
    const soma = items.reduce((s, i) => s + (i.valor_desconto ?? 0), 0)
    expect(Math.round(soma * 100)).toBe(1000)
    items.forEach((i) => expect((i.valor_desconto ?? 0)).toBeLessThanOrEqual(i.valor_bruto))
  })
})
