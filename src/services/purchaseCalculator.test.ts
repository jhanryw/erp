import { describe, it, expect } from 'vitest'
import {
  calculatePurchaseDecision,
  validatePurchaseCalculatorInputs,
  solveImplicitMonthlyRate,
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

    // Default RESERVE preserva o comportamento pré-existente dos cenários
    // A-I (CASH quando cabe e não há retorno alternativo informado) —
    // os testes desta correção que precisam de REINVEST sobrescrevem isso.
    preservedCashUse: 'RESERVE',
    alternativeInventoryMarkup: 3,
    alternativeInventoryTurnoverDays: 90,
    reinvestmentPct: 100,
    alternativeReturnRealizationPct: 50,

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

describe('novo motor econômico — crédito gratuito e retorno alternativo (seções 3-15)', () => {
  // A. Crédito gratuito, parcelas cabem -> FINANCED mesmo com CASH confortável
  it('A: financedCost = cashCost e parcelas cabem -> FINANCED', () => {
    const r = expectValid(
      baseInputs({
        cashDiscountPct: 0,
        installmentSurchargePct: 0,
        installmentsCount: 4, // cashCost=10000, financedCost=10000, parcela=2500
        cashOnHand: 50000,
        minimumCashReserve: 5000, // protectedExcessCash=45000 — CASH também caberia confortavelmente
        expectedStoreSales30d: 30000,
        markup: 3, // generation30d = 30000-10000-0-0 = 20000; capacidade = 13333 >= 2500
      }),
    )
    expect(r.financedCost).toBe(r.cashCost)
    expect(r.monthlyInstallment).toBeLessThanOrEqual(r.maximumNewInstallmentCapacity)
    expect(r.decision.type).toBe('FINANCED')
  })

  // B. Crédito gratuito, mas parcela não cabe -> NÃO recomendar FINANCED só por ser grátis
  it('B: financedCost = cashCost mas parcela excede a capacidade -> não recomenda FINANCED', () => {
    const r = expectValid(
      baseInputs({
        cashDiscountPct: 0,
        installmentSurchargePct: 0,
        installmentsCount: 4, // parcela=2500
        cashOnHand: 50000,
        minimumCashReserve: 5000, // CASH cabe confortavelmente
        expectedStoreSales30d: 1000,
        operatingCosts30d: 1000,
        markup: 3, // generation30d pequena/negativa -> capacidade bem abaixo de 2500
      }),
    )
    expect(r.financedCost).toBe(r.cashCost)
    expect(r.monthlyInstallment).toBeGreaterThan(r.maximumNewInstallmentCapacity)
    expect(r.decision.type).not.toBe('FINANCED')
    expect(r.decision.type).toBe('CASH')
  })

  // C. Juros + reinvestimento compensa -> FINANCED
  it('C: retorno alternativo conservador > custo da liquidez, parcelas cabem -> FINANCED', () => {
    const r = expectValid(
      baseInputs({
        cashDiscountPct: 0,
        installmentSurchargePct: 5,
        installmentsCount: 3, // cashCost=10000, financedCost=10500, liquidityCost=500
        cashOnHand: 50000,
        minimumCashReserve: 5000, // CASH cabe confortavelmente
        expectedStoreSales30d: 30000,
        markup: 3, // generation30d=20000, capacidade=13333 >= parcela(3500)
        preservedCashUse: 'REINVEST_IN_INVENTORY',
        alternativeInventoryMarkup: 3,
        alternativeInventoryTurnoverDays: 90, // == horizonte (3x30) -> turnoverFraction=1
        reinvestmentPct: 100,
        alternativeReturnRealizationPct: 50,
        // capitalReinvested=10000; potentialRevenue=30000; grossMargin=20000;
        // withinHorizon=20000*1=20000; conservativeReturn=20000*0.5=10000 > 500
      }),
    )
    expect(r.liquidityCost).toBe(500)
    expect(r.conservativeAlternativeReturn).toBeGreaterThan(r.liquidityCost)
    expect(r.decision.type).toBe('FINANCED')
  })

  // D. Juros + reinvestimento NÃO compensa -> CASH
  it('D: retorno alternativo conservador < custo da liquidez, CASH cabe -> CASH', () => {
    const r = expectValid(
      baseInputs({
        cashDiscountPct: 0,
        installmentSurchargePct: 10,
        installmentsCount: 3, // cashCost=10000, financedCost=11000, liquidityCost=1000
        cashOnHand: 50000,
        minimumCashReserve: 5000,
        expectedStoreSales30d: 30000,
        markup: 3,
        preservedCashUse: 'REINVEST_IN_INVENTORY',
        alternativeInventoryMarkup: 1.12,
        alternativeInventoryTurnoverDays: 90,
        reinvestmentPct: 100,
        alternativeReturnRealizationPct: 50,
        // capitalReinvested=10000; potentialRevenue=11200; grossMargin=1200;
        // turnoverFraction=1; withinHorizon=1200; conservativeReturn=600 < 1000
      }),
    )
    expect(r.liquidityCost).toBe(1000)
    expect(r.conservativeAlternativeReturn).toBeCloseTo(600, 2)
    expect(r.conservativeAlternativeReturn).toBeLessThan(r.liquidityCost)
    expect(r.decision.type).toBe('CASH')
  })

  // E. Mesmo acréscimo, prazos diferentes -> taxa implícita mensal de 6x menor que a de 2x
  it('E: +5% em 2x tem taxa implícita mensal maior que +5% em 6x', () => {
    const r2x = expectValid(baseInputs({ cashDiscountPct: 0, installmentSurchargePct: 5, installmentsCount: 2 }))
    const r6x = expectValid(baseInputs({ cashDiscountPct: 0, installmentSurchargePct: 5, installmentsCount: 6 }))
    expect(r2x.implicitMonthlyRate).not.toBeNull()
    expect(r6x.implicitMonthlyRate).not.toBeNull()
    expect(r2x.implicitMonthlyRate!).toBeGreaterThan(r6x.implicitMonthlyRate!)
  })

  // F. RESERVE -> não inventar retorno
  it('F: preservedCashUse = RESERVE -> todo o retorno alternativo é zero', () => {
    const r = expectValid(
      baseInputs({
        preservedCashUse: 'RESERVE',
        installmentSurchargePct: 20, // mesmo com juro alto, sem retorno inventado
      }),
    )
    expect(r.capitalReinvested).toBe(0)
    expect(r.alternativePotentialRevenue).toBe(0)
    expect(r.alternativeGrossMargin).toBe(0)
    expect(r.alternativeGrossMarginWithinFinancingHorizon).toBe(0)
    expect(r.conservativeAlternativeReturn).toBe(0)
  })

  // G. Retorno alto mas dívida não cabe -> NÃO recomendar FINANCED
  it('G: retorno alternativo altíssimo não fabrica capacidade financeira -> não recomenda FINANCED', () => {
    const r = expectValid(
      baseInputs({
        cashDiscountPct: 0,
        installmentSurchargePct: 5,
        installmentsCount: 3,
        cashOnHand: 50000,
        minimumCashReserve: 5000, // CASH cabe
        expectedStoreSales30d: 1000,
        operatingCosts30d: 1000,
        markup: 3, // generation30d negativa -> capacidade negativa -> financedViable = false
        preservedCashUse: 'REINVEST_IN_INVENTORY',
        alternativeInventoryMarkup: 10,
        alternativeInventoryTurnoverDays: 90,
        reinvestmentPct: 100,
        alternativeReturnRealizationPct: 100, // retorno conservador gigante de propósito
      }),
    )
    expect(r.monthlyInstallment).toBeGreaterThan(r.maximumNewInstallmentCapacity)
    expect(r.conservativeAlternativeReturn).toBeGreaterThan(10000) // retorno "gigante"
    expect(r.decision.type).not.toBe('FINANCED')
    expect(r.decision.type).toBe('CASH')
  })

  // H. Giro mais lento -> retorno alternativo conservador menor, mesmo horizonte financeiro
  it('H: giro de 180 dias produz retorno alternativo conservador menor que giro de 90 dias (mesmo horizonte)', () => {
    const commonOverrides: Partial<PurchaseCalculatorInputs> = {
      cashDiscountPct: 0,
      installmentSurchargePct: 5,
      installmentsCount: 3, // horizonte = 90 dias
      preservedCashUse: 'REINVEST_IN_INVENTORY' as const,
      alternativeInventoryMarkup: 3,
      reinvestmentPct: 100,
      alternativeReturnRealizationPct: 100,
    }
    const giro90 = expectValid(baseInputs({ ...commonOverrides, alternativeInventoryTurnoverDays: 90 }))
    const giro180 = expectValid(baseInputs({ ...commonOverrides, alternativeInventoryTurnoverDays: 180 }))
    expect(giro90.turnoverFraction).toBeGreaterThan(giro180.turnoverFraction)
    expect(giro90.conservativeAlternativeReturn).toBeGreaterThan(giro180.conservativeAlternativeReturn)
  })

  // I. Realização conservadora -> 50% produz metade do retorno de 100%
  it('I: alternativeReturnRealizationPct = 50 produz metade do retorno de 100%, tudo mais igual', () => {
    const commonOverrides: Partial<PurchaseCalculatorInputs> = {
      cashDiscountPct: 0,
      installmentSurchargePct: 5,
      installmentsCount: 3,
      preservedCashUse: 'REINVEST_IN_INVENTORY' as const,
      alternativeInventoryMarkup: 3,
      alternativeInventoryTurnoverDays: 90,
      reinvestmentPct: 100,
    }
    const realizacao50 = expectValid(baseInputs({ ...commonOverrides, alternativeReturnRealizationPct: 50 }))
    const realizacao100 = expectValid(baseInputs({ ...commonOverrides, alternativeReturnRealizationPct: 100 }))
    expect(realizacao50.conservativeAlternativeReturn).toBeCloseTo(realizacao100.conservativeAlternativeReturn / 2, 2)
  })

  // J. Zero juros -> taxa implícita aproximadamente 0, sem NaN/Infinity
  it('J: financiamento gratuito -> implicitMonthlyRate ~ 0%, sem NaN/Infinity', () => {
    const r = expectValid(
      baseInputs({ cashDiscountPct: 0, installmentSurchargePct: 0, installmentsCount: 4 }),
    )
    expect(r.implicitMonthlyRate).not.toBeNull()
    expect(r.implicitMonthlyRate!).toBeCloseTo(0, 6)
    expect(r.implicitAnnualEffectiveRate).not.toBeNull()
    expect(r.implicitAnnualEffectiveRate!).toBeCloseTo(0, 6)
    expect(Number.isNaN(r.implicitMonthlyRate!)).toBe(false)
    expect(Number.isFinite(r.implicitMonthlyRate!)).toBe(true)
  })
})

describe('solveImplicitMonthlyRate — função pura isolada', () => {
  it('presentValue <= 0 -> null, nunca NaN/Infinity', () => {
    expect(solveImplicitMonthlyRate(0, 1000, 3)).toBeNull()
    expect(solveImplicitMonthlyRate(-100, 1000, 3)).toBeNull()
  })

  it('installment <= 0 -> null', () => {
    expect(solveImplicitMonthlyRate(1000, 0, 3)).toBeNull()
    expect(solveImplicitMonthlyRate(1000, -50, 3)).toBeNull()
  })

  it('crédito gratuito exato (presentValue = installment * periods) -> taxa ~ 0', () => {
    const rate = solveImplicitMonthlyRate(9000, 3000, 3)
    expect(rate).not.toBeNull()
    expect(rate!).toBeCloseTo(0, 4)
  })

  it('financiamento mais caro que o presente -> taxa positiva', () => {
    const rate = solveImplicitMonthlyRate(9500, 3500, 3) // financedCost=10500 > cashCost=9500
    expect(rate).not.toBeNull()
    expect(rate!).toBeGreaterThan(0)
  })
})
