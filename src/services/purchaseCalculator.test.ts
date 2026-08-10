import { describe, it, expect } from 'vitest'
import {
  calculatePurchaseDecision,
  validatePurchaseCalculatorInputs,
  type PurchaseCalculatorInputs,
} from './purchaseCalculator'

function baseInputs(overrides: Partial<PurchaseCalculatorInputs> = {}): PurchaseCalculatorInputs {
  return {
    baseCost: 10000,
    cashDiscountPct: 5,
    installmentSurchargePct: 5,
    installmentsCount: 3,
    supplierAcceptsMixed: false,

    cashOnHand: 20000,
    expectedInflows30d: 0,
    operatingCosts30d: 0,
    existingInstallments30d: 0,
    otherOutflows30d: 0,
    minimumCashReserve: 5000,

    markup: 3,
    expectedStoreSales30d: 30000,
    expectedMerchandiseSales: 30000,
    expectedTurnoverDays: 90,

    minimumCoverageRatio: 1.5,
    ...overrides,
  }
}

function expectValid(inputs: PurchaseCalculatorInputs) {
  const outcome = calculatePurchaseDecision(inputs)
  expect(outcome.valid).toBe(true)
  if (!outcome.valid) throw new Error('esperado válido')
  return outcome.result
}

describe('calculatePurchaseDecision — cenários do enunciado', () => {
  // A. À vista cabe com folga
  it('A: caixa excedente protegido > custo à vista -> CASH', () => {
    const r = expectValid(
      baseInputs({
        cashOnHand: 20000,
        minimumCashReserve: 5000, // freeCash=20000, protectedExcessCash=15000
      }),
    )
    expect(r.cashCost).toBe(9500)
    expect(r.protectedExcessCash).toBeGreaterThan(9500)
    expect(r.decision.type).toBe('CASH')
  })

  // B. À vista invade reserva, prazo cabe
  it('B: cash não cabe mas parcelado cabe e mantém folga -> FINANCED', () => {
    const r = expectValid(
      baseInputs({
        cashOnHand: 8000,
        minimumCashReserve: 4000, // freeCash=8000, protectedExcessCash=4000 < cashCost=9500
        operatingCosts30d: 5000,
        existingInstallments30d: 1000,
        expectedStoreSales30d: 30000,
        markup: 3, // projectedStoreCOGS30d=10000 -> generation30d=30000-10000-5000-0=15000
      }),
    )
    expect(r.cashCost).toBeGreaterThan(r.protectedExcessCash)
    expect(r.monthlyInstallment).toBeLessThanOrEqual(r.maximumNewInstallmentCapacity)
    expect(r.postPurchaseCoverageRatio).not.toBeNull()
    expect(r.postPurchaseCoverageRatio!).toBeGreaterThanOrEqual(r.inputs.minimumCoverageRatio)
    expect(r.decision.type).toBe('FINANCED')
  })

  // C. Misto é possível
  it('C: à vista não cabe, misto cabe dentro da capacidade -> MIXED', () => {
    const r = expectValid(
      baseInputs({
        supplierAcceptsMixed: true,
        cashOnHand: 15000,
        minimumCashReserve: 5000, // freeCash=15000-5000-1000=9000, protectedExcessCash=4000 < cashCost=9500, > 0
        operatingCosts30d: 5000,
        existingInstallments30d: 1000,
      }),
    )
    expect(r.cashCost).toBeGreaterThan(r.protectedExcessCash)
    expect(r.protectedExcessCash).toBeGreaterThan(0)
    expect(r.mixed.viable).toBe(true)
    expect(r.decision.type).toBe('MIXED')
  })

  // D. Compra acima da capacidade
  it('D: nem à vista, nem parcelado, nem misto cabem -> OVER_CAPACITY', () => {
    const r = expectValid(
      baseInputs({
        supplierAcceptsMixed: true,
        cashOnHand: 5000,
        minimumCashReserve: 4000, // protectedExcessCash=1000 < cashCost=9500
        expectedStoreSales30d: 5000,
        markup: 2, // COGS=2500
        operatingCosts30d: 3000, // generation30d=5000-2500-3000-0=-500 (negativa)
        existingInstallments30d: 500,
      }),
    )
    expect(r.projectedOperatingGeneration30d).toBeLessThan(0)
    expect(r.cashCost).toBeGreaterThan(r.protectedExcessCash)
    expect(r.mixed.viable).toBe(false)
    expect(r.decision.type).toBe('OVER_CAPACITY')
    expect(r.decision.attentionLevel).toBe('critico')
  })

  // E. Sem parcelas existentes -> sem Infinity/NaN
  it('E: existingInstallments30d = 0 -> currentCoverageRatio null, nada de Infinity/NaN', () => {
    const r = expectValid(baseInputs({ existingInstallments30d: 0 }))
    expect(r.currentCoverageRatio).toBeNull()
    expect(Number.isFinite(r.postPurchaseCoverageRatio ?? 0)).toBe(true)
    expect(Number.isNaN(r.postPurchaseCoverageRatio ?? 0)).toBe(false)
    for (const [key, value] of Object.entries(r)) {
      if (typeof value === 'number') {
        expect(Number.isNaN(value), `${key} não deveria ser NaN`).toBe(false)
        expect(value === Infinity || value === -Infinity, `${key} não deveria ser Infinity`).toBe(false)
      }
    }
  })

  // F. Markup inválido
  it('F: markup <= 0 -> inválido, não calcula', () => {
    const outcome = calculatePurchaseDecision(baseInputs({ markup: 0 }))
    expect(outcome.valid).toBe(false)
    if (outcome.valid) throw new Error('esperado inválido')
    expect(outcome.errors.markup).toBeDefined()

    const negative = calculatePurchaseDecision(baseInputs({ markup: -2 }))
    expect(negative.valid).toBe(false)
  })

  // G. Geração operacional negativa -> nunca capacidade positiva
  it('G: geração operacional negativa -> capacidade de parcela exibida é 0, nunca positiva', () => {
    const r = expectValid(
      baseInputs({
        expectedStoreSales30d: 1000,
        markup: 2, // COGS=500
        operatingCosts30d: 5000, // generation30d = 1000-500-5000-0 = -4500
        existingInstallments30d: 200,
      }),
    )
    expect(r.projectedOperatingGeneration30d).toBeLessThan(0)
    expect(r.maximumNewInstallmentCapacity).toBeLessThan(0)
    expect(r.maximumNewInstallmentCapacityDisplay).toBe(0)
    expect(r.existingInstallmentsExceedPolicy).toBe(true)
  })

  // H. Acréscimo 0%
  it('H: installmentSurchargePct = 0 -> financedCost = baseCost, sem erro', () => {
    const r = expectValid(baseInputs({ installmentSurchargePct: 0 }))
    expect(r.financedCost).toBe(10000)
    expect(r.liquidityCost).toBeCloseTo(r.financedCost - r.cashCost, 6)
    expect(r.decision.type).toBeDefined()
  })

  // I. Reserva mínima maior que caixa livre
  it('I: minimumCashReserve > freeCashBeforePurchase -> protectedExcessCash negativo, sem quebrar', () => {
    const r = expectValid(
      baseInputs({
        cashOnHand: 3000,
        expectedInflows30d: 0,
        minimumCashReserve: 10000, // freeCash=3000, reserve=10000
      }),
    )
    expect(r.freeCashBeforePurchase).toBe(3000)
    expect(r.protectedExcessCash).toBeLessThan(0)
    expect(Number.isFinite(r.protectedExcessCash)).toBe(true)
    expect(r.decision).toBeDefined()
  })
})

describe('separação de horizontes temporais — faturamento da loja x venda da mercadoria', () => {
  // Cenário explícito pedido na correção: geração operacional deve usar
  // expectedStoreSales30d (15.000), NUNCA expectedMerchandiseSales (30.000
  // ao longo de 90 dias de giro — horizontes diferentes).
  it('geração operacional 30d usa expectedStoreSales30d, não expectedMerchandiseSales', () => {
    const r = expectValid(
      baseInputs({
        expectedStoreSales30d: 15000,
        expectedMerchandiseSales: 30000,
        expectedTurnoverDays: 90,
        markup: 3,
        operatingCosts30d: 0,
        otherOutflows30d: 0,
      }),
    )
    // projectedStoreCOGS30d = 15000/3 = 5000; generation30d = 15000-5000-0-0 = 10000
    expect(r.projectedStoreCOGS30d).toBe(5000)
    expect(r.projectedOperatingGeneration30d).toBe(10000)
    // Nunca o valor que resultaria de usar 30.000 (COGS=10000, generation=20000)
    expect(r.projectedOperatingGeneration30d).not.toBe(20000)

    // Autopagamento continua usando expectedMerchandiseSales / expectedTurnoverDays (30.000/90), não 15.000 nem /30.
    expect(r.expectedMerchandiseDailySales).toBeCloseTo(30000 / 90, 2)
    expect(r.expectedMerchandiseDailySales).not.toBeCloseTo(15000 / 30, 2)
    expect(r.expectedMerchandiseDailySales).not.toBeCloseTo(30000 / 30, 2)
  })

  // Uma mercadoria "boa" (autopagamento alto) não pode fabricar capacidade
  // financeira artificial quando a loja não tem faturamento previsto.
  it('mercadoria com bom giro não fabrica capacidade financeira quando a loja não fatura', () => {
    const r = expectValid(
      baseInputs({
        expectedStoreSales30d: 0,
        expectedMerchandiseSales: 30000,
        expectedTurnoverDays: 90,
        markup: 3,
        operatingCosts30d: 2000,
        otherOutflows30d: 0,
        existingInstallments30d: 0,
      }),
    )
    // Geração operacional deve ser <= 0 (loja sem faturamento, ainda com custo).
    expect(r.projectedOperatingGeneration30d).toBeLessThanOrEqual(0)
    // Capacidade de nova parcela nunca aparece positiva na UI mesmo com boa mercadoria.
    expect(r.maximumNewInstallmentCapacityDisplay).toBe(0)
    // A mercadoria em si pode mostrar autopagamento positivo — isso é esperado e não deve ser zerado.
    expect(r.installmentSelfPaymentRatio).not.toBeNull()
    expect(r.installmentSelfPaymentRatio!).toBeGreaterThan(0)
  })
})

describe('validatePurchaseCalculatorInputs — casos de borda que NÃO devem quebrar', () => {
  it('caixa zero, entradas zero, parcelas existentes zero, desconto zero, acréscimo zero -> válido', () => {
    const outcome = calculatePurchaseDecision(
      baseInputs({
        cashOnHand: 0,
        expectedInflows30d: 0,
        existingInstallments30d: 0,
        cashDiscountPct: 0,
        installmentSurchargePct: 0,
      }),
    )
    expect(outcome.valid).toBe(true)
  })

  it('installmentsCount não inteiro ou < 1 -> inválido', () => {
    expect(validatePurchaseCalculatorInputs(baseInputs({ installmentsCount: 0 })).installmentsCount).toBeDefined()
    expect(validatePurchaseCalculatorInputs(baseInputs({ installmentsCount: 2.5 })).installmentsCount).toBeDefined()
  })

  it('expectedTurnoverDays <= 0 -> inválido', () => {
    expect(validatePurchaseCalculatorInputs(baseInputs({ expectedTurnoverDays: 0 })).expectedTurnoverDays).toBeDefined()
  })

  it('minimumCoverageRatio <= 0 -> inválido', () => {
    expect(validatePurchaseCalculatorInputs(baseInputs({ minimumCoverageRatio: 0 })).minimumCoverageRatio).toBeDefined()
  })

  it('percentuais negativos -> inválido', () => {
    expect(validatePurchaseCalculatorInputs(baseInputs({ cashDiscountPct: -1 })).cashDiscountPct).toBeDefined()
    expect(validatePurchaseCalculatorInputs(baseInputs({ installmentSurchargePct: -1 })).installmentSurchargePct).toBeDefined()
  })
})

describe('modalidade mista — regras da seção 9', () => {
  it('fornecedor não aceita misto -> mixed.applicable = false, viable = false', () => {
    const r = expectValid(baseInputs({ supplierAcceptsMixed: false }))
    expect(r.mixed.applicable).toBe(false)
    expect(r.mixed.viable).toBe(false)
  })

  it('safeCashContribution <= 0 (sem excedente) -> mixed não agrega valor (addsValue false)', () => {
    const r = expectValid(
      baseInputs({
        supplierAcceptsMixed: true,
        cashOnHand: 1000,
        minimumCashReserve: 5000, // protectedExcessCash negativo
      }),
    )
    expect(r.mixed.safeCashContribution).toBe(0)
    expect(r.mixed.addsValue).toBe(false)
  })

  it('safeCashContribution >= cashCost -> na prática equivale a pagamento à vista (addsValue false)', () => {
    const r = expectValid(
      baseInputs({
        supplierAcceptsMixed: true,
        cashOnHand: 100000,
        minimumCashReserve: 1000, // protectedExcessCash bem maior que cashCost
      }),
    )
    expect(r.mixed.safeCashContribution).toBeGreaterThanOrEqual(r.cashCost)
    expect(r.mixed.addsValue).toBe(false)
  })
})

describe('comparador de cenários — seção 13', () => {
  it('gera colunas cash e financed sempre, e mixed só quando aplicável', () => {
    const semMisto = expectValid(baseInputs({ supplierAcceptsMixed: false }))
    expect(semMisto.comparison.map((c) => c.key)).toEqual(['cash', 'financed'])

    const comMisto = expectValid(baseInputs({ supplierAcceptsMixed: true }))
    expect(comMisto.comparison.map((c) => c.key)).toEqual(['cash', 'financed', 'mixed'])
  })

  it('exatamente uma coluna marcada como recomendada, coerente com decision.type', () => {
    const r = expectValid(baseInputs())
    const recommended = r.comparison.filter((c) => c.isRecommended)
    expect(recommended.length).toBe(1)
    expect(recommended[0].key).toBe(r.decision.type === 'CASH' ? 'cash' : r.decision.type === 'FINANCED' ? 'financed' : 'mixed')
  })
})
