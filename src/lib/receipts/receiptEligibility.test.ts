import { describe, it, expect } from 'vitest'
import { computeExchangeEligibility } from './receiptEligibility'

describe('computeExchangeEligibility', () => {
  it('sem nenhuma troca — tudo elegível', () => {
    const result = computeExchangeEligibility([{ id: 1, quantity: 3 }], [])
    expect(result).toEqual([
      { sale_item_id: 1, quantity_purchased: 3, already_returned: 0, available_to_return: 3 },
    ])
  })

  it('troca parcial reduz a quantidade elegível', () => {
    const result = computeExchangeEligibility(
      [{ id: 1, quantity: 5 }],
      [{ sale_item_id: 1, quantity_returned: 2 }],
    )
    expect(result[0].already_returned).toBe(2)
    expect(result[0].available_to_return).toBe(3)
  })

  it('soma múltiplas trocas do mesmo item', () => {
    const result = computeExchangeEligibility(
      [{ id: 1, quantity: 5 }],
      [
        { sale_item_id: 1, quantity_returned: 1 },
        { sale_item_id: 1, quantity_returned: 2 },
      ],
    )
    expect(result[0].already_returned).toBe(3)
    expect(result[0].available_to_return).toBe(2)
  })

  it('item totalmente trocado — elegibilidade zero, nunca negativa', () => {
    const result = computeExchangeEligibility(
      [{ id: 1, quantity: 2 }],
      [{ sale_item_id: 1, quantity_returned: 2 }],
    )
    expect(result[0].available_to_return).toBe(0)
  })

  it('nunca fica negativo mesmo se quantity_returned somado exceder quantity (dado inconsistente)', () => {
    const result = computeExchangeEligibility(
      [{ id: 1, quantity: 2 }],
      [{ sale_item_id: 1, quantity_returned: 5 }],
    )
    expect(result[0].available_to_return).toBe(0)
  })

  it('itens de outras vendas/sale_item_id não relacionados são ignorados', () => {
    const result = computeExchangeEligibility(
      [{ id: 1, quantity: 4 }],
      [{ sale_item_id: 999, quantity_returned: 4 }],
    )
    expect(result[0].already_returned).toBe(0)
    expect(result[0].available_to_return).toBe(4)
  })

  it('múltiplos itens da venda calculados independentemente', () => {
    const result = computeExchangeEligibility(
      [
        { id: 1, quantity: 3 },
        { id: 2, quantity: 5 },
      ],
      [{ sale_item_id: 1, quantity_returned: 1 }],
    )
    expect(result.find((r) => r.sale_item_id === 1)?.available_to_return).toBe(2)
    expect(result.find((r) => r.sale_item_id === 2)?.available_to_return).toBe(5)
  })
})
