import { describe, it, expect } from 'vitest'
import { computeModalityComparison, type ModalitySaleInput } from './modalityMetrics'

function sale(overrides: Partial<ModalitySaleInput> & Pick<ModalitySaleInput, 'saleType' | 'total'>): ModalitySaleInput {
  return { grossProfit: 0, itemsQuantity: 0, ...overrides }
}

describe('computeModalityComparison', () => {
  it('1. somente retail — wholesale fica zerado, nunca undefined/NaN', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 2 }),
      sale({ saleType: 'retail', total: 200, grossProfit: 80, itemsQuantity: 3 }),
    ])
    expect(result.retail.revenue).toBe(300)
    expect(result.retail.orders).toBe(2)
    expect(result.wholesale.revenue).toBe(0)
    expect(result.wholesale.orders).toBe(0)
    expect(result.wholesale.grossMarginPct).toBeNull()
  })

  it('2. somente wholesale — retail fica zerado', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'wholesale', total: 1000, grossProfit: 300, itemsQuantity: 10 }),
    ])
    expect(result.wholesale.revenue).toBe(1000)
    expect(result.retail.revenue).toBe(0)
    expect(result.retail.orders).toBe(0)
  })

  it('3. retail + wholesale misturados — cada um agregado separadamente', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 900, grossProfit: 180, itemsQuantity: 9 }),
    ])
    expect(result.retail.revenue).toBe(100)
    expect(result.wholesale.revenue).toBe(900)
  })

  it('4. total correto — soma retail + wholesale, nunca recalculado do zero', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 900, grossProfit: 180, itemsQuantity: 9 }),
    ])
    expect(result.total.revenue).toBe(1000)
    expect(result.total.orders).toBe(2)
    expect(result.total.itemsSold).toBe(10)
    expect(result.total.grossProfit).toBe(220)
  })

  it('5. venda cancelada excluída — responsabilidade do CHAMADOR (função nunca filtra sozinha, só agrega o que recebe)', () => {
    // Vendas canceladas/devolvidas nunca devem chegar aqui — o teste prova
    // que se o chamador filtrar corretamente (não passar a linha), o
    // resultado não inclui nada dela. A função em si não tem noção de status.
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 1 }),
      // venda cancelada de R$ 500 NÃO está na lista — simula filtro já aplicado
    ])
    expect(result.retail.revenue).toBe(100)
    expect(result.total.revenue).toBe(100)
  })

  it('7. ticket médio retail', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, itemsQuantity: 1 }),
      sale({ saleType: 'retail', total: 300, itemsQuantity: 1 }),
    ])
    expect(result.retail.avgTicket).toBe(200)
  })

  it('8. ticket médio wholesale', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'wholesale', total: 1000, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 2000, itemsQuantity: 1 }),
    ])
    expect(result.wholesale.avgTicket).toBe(1500)
  })

  it('9. divisão por zero — sem nenhuma venda, tudo zerado/null, nunca NaN/Infinity', () => {
    const result = computeModalityComparison([])
    for (const bucket of [result.retail, result.wholesale, result.total]) {
      expect(bucket.revenue).toBe(0)
      expect(bucket.orders).toBe(0)
      expect(bucket.avgTicket).toBe(0)
      expect(Number.isNaN(bucket.avgTicket)).toBe(false)
      expect(bucket.grossMarginPct).toBeNull()
      expect(bucket.revenueSharePct).toBe(0)
      expect(bucket.grossProfitSharePct).toBe(0)
      expect(Number.isFinite(bucket.revenueSharePct)).toBe(true)
    }
  })

  it('10-11. CMV = receita - lucro bruto, para retail e wholesale independentemente', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 900, grossProfit: 180, itemsQuantity: 1 }),
    ])
    expect(result.retail.cmv).toBe(60)
    expect(result.wholesale.cmv).toBe(720)
    expect(result.total.cmv).toBe(780)
  })

  it('12. lucro bruto agregado corretamente por modalidade', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: 40, itemsQuantity: 1 }),
      sale({ saleType: 'retail', total: 100, grossProfit: 10, itemsQuantity: 1 }),
    ])
    expect(result.retail.grossProfit).toBe(50)
  })

  it('13. margem bruta = lucro bruto / receita', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'wholesale', total: 1000, grossProfit: 250, itemsQuantity: 1 }),
    ])
    expect(result.wholesale.grossMarginPct).toBe(25)
  })

  it('14. participação em receita — modalidade / total', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 300, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 700, itemsQuantity: 1 }),
    ])
    expect(result.retail.revenueSharePct).toBe(30)
    expect(result.wholesale.revenueSharePct).toBe(70)
    expect(result.total.revenueSharePct).toBe(100)
  })

  it('15. participação em lucro bruto — modalidade / total', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 300, grossProfit: 60, itemsQuantity: 1 }),
      sale({ saleType: 'wholesale', total: 700, grossProfit: 140, itemsQuantity: 1 }),
    ])
    expect(result.retail.grossProfitSharePct).toBe(30)
    expect(result.wholesale.grossProfitSharePct).toBe(70)
  })

  it('32. zero wholesale — R$ 0,00 / 0 vendas / 0%, nunca erro/NaN/oculto', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 500, grossProfit: 100, itemsQuantity: 5 }),
    ])
    expect(result.wholesale.revenue).toBe(0)
    expect(result.wholesale.orders).toBe(0)
    expect(result.wholesale.revenueSharePct).toBe(0)
    expect(result.wholesale.grossProfitSharePct).toBe(0)
    expect(result.wholesale.avgTicket).toBe(0)
    expect(result.wholesale.grossMarginPct).toBeNull()
  })

  it('33. histórico antigo como retail — sale_type ausente tratado como retail (nunca perdido/undefined)', () => {
    const result = computeModalityComparison([
      // @ts-expect-error — simula linha antiga sem sale_type explícito (NOT NULL DEFAULT 'retail' garante isso no banco, mas o teste prova que a função também nunca quebra)
      { total: 100, grossProfit: 20, itemsQuantity: 1 },
    ])
    expect(result.retail.revenue).toBe(100)
    expect(result.wholesale.revenue).toBe(0)
  })

  it('lucro bruto negativo (venda abaixo do custo) não quebra margem/participação', () => {
    const result = computeModalityComparison([
      sale({ saleType: 'retail', total: 100, grossProfit: -20, itemsQuantity: 1 }),
    ])
    expect(result.retail.grossMarginPct).toBe(-20)
    expect(result.retail.cmv).toBe(120)
    expect(Number.isFinite(result.retail.grossProfitSharePct)).toBe(true)
  })
})
