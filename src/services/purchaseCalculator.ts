/**
 * Calculadora de Compra e Alavancagem — motor de cálculo.
 *
 * 100% manual e 100% client-side: nenhuma tabela, nenhuma RPC, nenhuma
 * chamada de rede. Todas as entradas vêm do formulário; nada é lido do
 * estoque, fornecedores, financeiro ou sugestão de compras (V1
 * deliberadamente isolada dessas integrações).
 *
 * PRINCÍPIO ECONÔMICO (revisado): a calculadora não assume mais que
 * "se cabe à vista, deve pagar à vista". A decisão pondera custo do
 * crédito, valor da liquidez preservada, retorno potencial conservador
 * do uso alternativo desse caixa, giro, capacidade de serviço da dívida
 * e reserva mínima — nessa ordem de prioridade, com a capacidade
 * financeira sempre como trava obrigatória (retorno econômico nunca
 * fabrica capacidade).
 *
 * Toda a matemática mora aqui — nenhuma fórmula deve ser recalculada no
 * componente visual.
 */

import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { COMFORTABLE_COVERAGE_MULTIPLIER } from '@/lib/constants/purchaseCalculator'

// ─── Tipos de entrada ───────────────────────────────────────────────────────────

export type PreservedCashUse = 'RESERVE' | 'REINVEST_IN_INVENTORY'

export interface PurchaseCalculatorInputs {
  // A. Compra
  baseCost: number
  cashDiscountPct: number
  installmentSurchargePct: number
  installmentsCount: number
  supplierAcceptsMixed: boolean

  // B. Caixa e obrigações (próximos 30 dias)
  cashOnHand: number
  expectedInflows30d: number
  operatingCosts30d: number
  existingInstallments30d: number
  otherOutflows30d: number
  minimumCashReserve: number

  // B. (cont.) Faturamento da loja — horizonte de 30 dias, usado SÓ para
  // capacidade financeira (geração operacional). Nunca confundir com
  // expectedMerchandiseSales (venda da mercadoria, horizonte de giro).
  expectedStoreSales30d: number

  // C. Mercadoria / operação — venda esperada DESTA mercadoria ao longo do
  // seu próprio prazo de giro (expectedTurnoverDays), não em 30 dias.
  // Usada só no autopagamento (seção 8), nunca na geração operacional.
  markup: number
  expectedMerchandiseSales: number
  expectedTurnoverDays: number

  // D. Política de risco
  minimumCoverageRatio: number

  // E. Destino do caixa preservado (só relevante quando FINANCED/MIXED
  // preservam caixa frente a CASH). Os 4 campos "alternative*" só são
  // validados/usados quando preservedCashUse = REINVEST_IN_INVENTORY —
  // sob RESERVE, nenhum retorno é inventado (ver seção 7 do pedido).
  preservedCashUse: PreservedCashUse
  alternativeInventoryMarkup: number
  alternativeInventoryTurnoverDays: number
  reinvestmentPct: number
  alternativeReturnRealizationPct: number
}

export type ValidationErrors = Partial<Record<keyof PurchaseCalculatorInputs, string>>

// ─── Validação (seção 14 do pedido original + seção 8 desta correção) ──────────

function isValidNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

function isValidPercentRange(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100
}

/**
 * Campos monetários e de caixa podem ser zero (compra sem histórico de
 * vendas, caixa zerado, sem parcelas existentes etc.) — só bloqueia
 * valores não numéricos ou negativos, e as regras específicas de
 * markup/parcelas/prazo/folga. Os campos de reinvestimento só são
 * exigidos quando preservedCashUse = REINVEST_IN_INVENTORY — sob RESERVE
 * eles não são usados, então não bloqueiam o cálculo mesmo vazios/zerados.
 */
export function validatePurchaseCalculatorInputs(
  inputs: PurchaseCalculatorInputs,
): ValidationErrors {
  const errors: ValidationErrors = {}

  const monetaryFields: (keyof PurchaseCalculatorInputs)[] = [
    'baseCost',
    'cashOnHand',
    'expectedInflows30d',
    'operatingCosts30d',
    'existingInstallments30d',
    'otherOutflows30d',
    'minimumCashReserve',
    'expectedStoreSales30d',
    'expectedMerchandiseSales',
  ]
  for (const field of monetaryFields) {
    if (!isValidNonNegative(inputs[field] as number)) {
      errors[field] = 'Informe um valor numérico maior ou igual a zero.'
    }
  }

  if (!isValidNonNegative(inputs.cashDiscountPct)) {
    errors.cashDiscountPct = 'Percentual deve ser maior ou igual a zero.'
  }
  if (!isValidNonNegative(inputs.installmentSurchargePct)) {
    errors.installmentSurchargePct = 'Percentual deve ser maior ou igual a zero.'
  }

  if (!Number.isInteger(inputs.installmentsCount) || inputs.installmentsCount < 1) {
    errors.installmentsCount = 'Número de parcelas deve ser um inteiro maior ou igual a 1.'
  }

  if (!Number.isFinite(inputs.markup) || inputs.markup <= 0) {
    errors.markup = 'Markup deve ser maior que zero.'
  }

  if (!Number.isFinite(inputs.expectedTurnoverDays) || inputs.expectedTurnoverDays <= 0) {
    errors.expectedTurnoverDays = 'Prazo de giro deve ser maior que zero.'
  }

  if (!Number.isFinite(inputs.minimumCoverageRatio) || inputs.minimumCoverageRatio <= 0) {
    errors.minimumCoverageRatio = 'Folga mínima deve ser maior que zero.'
  }

  if (inputs.preservedCashUse === 'REINVEST_IN_INVENTORY') {
    if (!Number.isFinite(inputs.alternativeInventoryMarkup) || inputs.alternativeInventoryMarkup <= 0) {
      errors.alternativeInventoryMarkup = 'Markup da compra adicional deve ser maior que zero.'
    }
    if (!Number.isFinite(inputs.alternativeInventoryTurnoverDays) || inputs.alternativeInventoryTurnoverDays <= 0) {
      errors.alternativeInventoryTurnoverDays = 'Prazo de giro da compra adicional deve ser maior que zero.'
    }
    if (!isValidPercentRange(inputs.reinvestmentPct)) {
      errors.reinvestmentPct = 'Percentual de reinvestimento deve estar entre 0 e 100.'
    }
    if (!isValidPercentRange(inputs.alternativeReturnRealizationPct)) {
      errors.alternativeReturnRealizationPct = 'Percentual de realização conservadora deve estar entre 0 e 100.'
    }
  }

  return errors
}

// ─── Helpers puros ──────────────────────────────────────────────────────────────

/** Divisão protegida: nunca retorna Infinity/NaN — null representa "indefinido" (ex.: sem parcelas para dividir). */
function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  const result = numerator / denominator
  return Number.isFinite(result) ? result : null
}

/** Cobertura nula (sem dívida) é tratada como "atende trivialmente" — dívida zero nunca é o motivo de uma recusa. */
function meetsCoverage(ratio: number | null, minimum: number): boolean {
  return ratio === null || ratio >= minimum
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

// ─── Seção 5 — taxa efetiva implícita do parcelamento ──────────────────────────

/**
 * Fator de valor presente de uma anuidade de `periods` parcelas iguais,
 * a uma taxa mensal `rate` (primeira parcela em t=1, demais a cada 30
 * dias — premissa explícita desta V1).
 */
function annuityPresentValueFactor(rate: number, periods: number): number {
  if (rate === 0) return periods
  return (1 - Math.pow(1 + rate, -periods)) / rate
}

/** installment * fatorAnuidade(rate, periods) - presentValue — raiz em rate é a taxa implícita. */
function annuityNetPresentValueDiff(
  rate: number,
  presentValue: number,
  installment: number,
  periods: number,
): number {
  return installment * annuityPresentValueFactor(rate, periods) - presentValue
}

/**
 * Resolve por bisseção a taxa mensal `r` tal que:
 *   presentValue = Σ installment / (1+r)^t,  t = 1..periods
 *
 * A função é estritamente decrescente em r (para r > -1): quanto maior a
 * taxa, menor o valor presente do fluxo de parcelas. Isso garante no
 * máximo uma raiz, e ela sempre existe em (-1, +∞) quando presentValue e
 * installment são ambos positivos — a busca expande o limite superior
 * exponencialmente até capturar a raiz, depois bissecta.
 *
 * Retorna null (nunca NaN/Infinity) quando a taxa não tem sentido
 * (presentValue <= 0, installment <= 0 sem presentValue correspondente,
 * ou falha de convergência).
 */
export function solveImplicitMonthlyRate(
  presentValue: number,
  installment: number,
  periods: number,
): number | null {
  if (!Number.isFinite(presentValue) || !Number.isFinite(installment) || !Number.isInteger(periods) || periods < 1) {
    return null
  }
  if (presentValue <= 0) return null // nada preservado — taxa implícita não tem sentido
  if (installment <= 0) return null // sem desembolso parcelado — taxa não tem sentido

  const f = (r: number) => annuityNetPresentValueDiff(r, presentValue, installment, periods)

  let lo = -0.99
  let hi = 1
  let guard = 0
  while (f(hi) > 0 && guard < 60) {
    hi *= 2
    guard++
  }

  // Sem troca de sinal no intervalo => não há convergência segura (não deveria
  // acontecer com entradas válidas, mas é uma saída segura em vez de NaN).
  if (f(lo) < 0 || f(hi) > 0) return null

  let rate = (lo + hi) / 2
  for (let i = 0; i < 100; i++) {
    rate = (lo + hi) / 2
    const value = f(rate)
    if (Math.abs(value) < 1e-9 || hi - lo < 1e-12) break
    if (value > 0) lo = rate
    else hi = rate
  }

  return Number.isFinite(rate) ? round4(rate) : null
}

function implicitAnnualEffectiveRate(monthlyRate: number | null): number | null {
  if (monthlyRate === null) return null
  const annual = Math.pow(1 + monthlyRate, 12) - 1
  return Number.isFinite(annual) ? round4(annual) : null
}

// ─── Tipos de saída ─────────────────────────────────────────────────────────────

export type PurchaseDecisionType = 'CASH' | 'FINANCED' | 'MIXED' | 'OVER_CAPACITY'
export type AttentionLevel = 'ok' | 'atencao' | 'critico'

export interface MixedScenario {
  /** false quando o fornecedor não aceita misto — os demais campos ficam zerados/neutros. */
  applicable: boolean
  /** true quando 0 < safeCashContribution < cashCost — faixa em que o misto é distinto de à vista/a prazo puros. */
  addsValue: boolean

  safeCashContribution: number
  remainingBaseToFinance: number
  financedCost: number
  monthlyInstallment: number
  totalCost: number

  cashAfterInitialPayment: number
  protectedCashAfterInitialPayment: number
  reservePreserved: boolean

  totalInstallmentsAfterPurchase: number
  postPurchaseCoverageRatio: number | null

  fitsCapacity: boolean
  meetsCoveragePolicy: boolean
  /** addsValue && fitsCapacity && meetsCoveragePolicy && reservePreserved */
  viable: boolean

  /** financedCost (puro) - mixed.totalCost — sempre >= 0. Economia financeira de contribuir com safeCashContribution em vez de financiar tudo. */
  financialSavings: number
}

export interface PurchaseDecision {
  type: PurchaseDecisionType
  title: string
  justification: string
  attentionLevel: AttentionLevel
}

export interface ComparisonColumn {
  key: 'cash' | 'financed' | 'mixed'
  label: string
  immediateOutlay: number
  totalCost: number
  monthlyInstallment: number | null
  cashPreservedToday: number
  cashAfterInitialOutlay: number
  installmentSlack: number | null // "folga das parcelas" — coverage ratio do cenário
  reservePreserved: boolean
  additionalFinancialCost: number
  isRecommended: boolean

  // Seção 17 — só populados para 'financed' (e 'mixed', proporcionalmente); null para 'cash'.
  implicitMonthlyRate: number | null
  conservativeAlternativeReturn: number | null
  netLiquidityBenefit: number | null
}

export interface PurchaseCalculatorResult {
  inputs: PurchaseCalculatorInputs

  // 4.1 / 4.2 / 4.3
  cashCost: number
  financedCost: number
  monthlyInstallment: number
  liquidityCost: number
  /** = liquidityCost / cashCost. É o "effectiveLiquidityPremiumPct" pedido — mesmo indicador, sem duplicar campo. */
  liquidityCostPct: number | null

  // 4.4 / 4.5 / 4.6
  freeCashBeforePurchase: number
  protectedExcessCash: number
  cashAfterCashPurchase: number
  protectedCashAfterCashPurchase: number

  // 5 — sempre com base em expectedStoreSales30d (30 dias), nunca na venda da mercadoria.
  projectedStoreCOGS30d: number
  projectedStoreGrossMargin30d: number
  projectedOperatingGeneration30d: number

  // 6
  maximumTotalInstallments: number
  /** Valor bruto, pode ser negativo — usado nas comparações internas. */
  maximumNewInstallmentCapacity: number
  /** Nunca negativo — o que a UI deve exibir como "capacidade disponível". */
  maximumNewInstallmentCapacityDisplay: number
  existingInstallmentsExceedPolicy: boolean

  // 7
  currentCoverageRatio: number | null // null = "Sem parcelas atuais"
  totalInstallmentsAfterPurchase: number
  postPurchaseCoverageRatio: number | null

  // 8 — sempre com base em expectedMerchandiseSales / expectedTurnoverDays, nunca em expectedStoreSales30d.
  expectedMerchandiseDailySales: number
  expectedMerchandiseDailyCOGSRecovery: number
  expectedCOGSRecovered30d: number
  installmentSelfPaymentRatio: number | null

  // 9
  mixed: MixedScenario

  // Taxa implícita do parcelamento puro (seção 5 desta correção)
  implicitMonthlyRate: number | null
  implicitAnnualEffectiveRate: number | null

  // Retorno do caixa preservado (seções 9-13 desta correção)
  preservedCash: number
  capitalReinvested: number
  alternativePotentialRevenue: number
  alternativeGrossMargin: number
  financingHorizonDays: number
  turnoverFraction: number
  alternativeGrossMarginWithinFinancingHorizon: number
  conservativeAlternativeReturn: number
  netLiquidityBenefit: number

  // 10 / 11 / 15
  decision: PurchaseDecision

  // 17
  comparison: ComparisonColumn[]
}

export type PurchaseCalculatorOutcome =
  | { valid: true; result: PurchaseCalculatorResult }
  | { valid: false; errors: ValidationErrors }

// ─── Motor principal ────────────────────────────────────────────────────────────

export function calculatePurchaseDecision(
  inputs: PurchaseCalculatorInputs,
): PurchaseCalculatorOutcome {
  const errors = validatePurchaseCalculatorInputs(inputs)
  if (Object.keys(errors).length > 0) return { valid: false, errors }

  const {
    baseCost,
    cashDiscountPct,
    installmentSurchargePct,
    installmentsCount,
    supplierAcceptsMixed,
    cashOnHand,
    expectedInflows30d,
    operatingCosts30d,
    existingInstallments30d,
    otherOutflows30d,
    minimumCashReserve,
    expectedStoreSales30d,
    markup,
    expectedMerchandiseSales,
    expectedTurnoverDays,
    minimumCoverageRatio,
    preservedCashUse,
    alternativeInventoryMarkup,
    alternativeInventoryTurnoverDays,
    reinvestmentPct,
    alternativeReturnRealizationPct,
  } = inputs

  // ── 4.1 / 4.2 / 4.3 — custo à vista, a prazo e da liquidez ──────────────────
  const cashCost = round2(baseCost * (1 - cashDiscountPct / 100))
  const financedCost = round2(baseCost * (1 + installmentSurchargePct / 100))
  const monthlyInstallment = round2(financedCost / installmentsCount)
  const liquidityCost = round2(financedCost - cashCost)
  const liquidityCostPct = safeDiv(liquidityCost, cashCost)

  // ── 4.4 / 4.5 / 4.6 — caixa ──────────────────────────────────────────────────
  const freeCashBeforePurchase = round2(
    cashOnHand + expectedInflows30d - operatingCosts30d - existingInstallments30d - otherOutflows30d,
  )
  const protectedExcessCash = round2(freeCashBeforePurchase - minimumCashReserve)
  const cashAfterCashPurchase = round2(freeCashBeforePurchase - cashCost)
  const protectedCashAfterCashPurchase = round2(cashAfterCashPurchase - minimumCashReserve)

  // ── 5 — geração operacional em 30 dias ───────────────────────────────────────
  const projectedStoreCOGS30d = round2(expectedStoreSales30d / markup)
  const projectedStoreGrossMargin30d = round2(expectedStoreSales30d - projectedStoreCOGS30d)
  const projectedOperatingGeneration30d = round2(
    expectedStoreSales30d - projectedStoreCOGS30d - operatingCosts30d - otherOutflows30d,
  )

  // ── 6 — capacidade de nova parcela ───────────────────────────────────────────
  const maximumTotalInstallments = round2(projectedOperatingGeneration30d / minimumCoverageRatio)
  const maximumNewInstallmentCapacity = round2(maximumTotalInstallments - existingInstallments30d)
  const maximumNewInstallmentCapacityDisplay = Math.max(0, maximumNewInstallmentCapacity)
  const existingInstallmentsExceedPolicy = maximumNewInstallmentCapacity < 0

  // ── 7 — folga de serviço da dívida ───────────────────────────────────────────
  const currentCoverageRatio = safeDiv(projectedOperatingGeneration30d, existingInstallments30d)
  const totalInstallmentsAfterPurchase = round2(existingInstallments30d + monthlyInstallment)
  const postPurchaseCoverageRatio = safeDiv(projectedOperatingGeneration30d, totalInstallmentsAfterPurchase)

  // ── 8 — autopagamento estimado da parcela ────────────────────────────────────
  const expectedMerchandiseDailySales = round2(expectedMerchandiseSales / expectedTurnoverDays)
  const expectedMerchandiseDailyCOGSRecovery = round2(expectedMerchandiseDailySales / markup)
  const expectedCOGSRecovered30d = round2(expectedMerchandiseDailyCOGSRecovery * 30)
  const installmentSelfPaymentRatio = safeDiv(expectedCOGSRecovered30d, monthlyInstallment)

  // ── Taxa implícita do parcelamento puro (seção 5) ────────────────────────────
  const implicitMonthlyRate = solveImplicitMonthlyRate(cashCost, monthlyInstallment, installmentsCount)
  const implicitAnnualRate = implicitAnnualEffectiveRate(implicitMonthlyRate)

  // ── Retorno do caixa preservado (seções 6-13) ────────────────────────────────
  const preservedCash = cashCost
  const financingHorizonDays = installmentsCount * 30

  let capitalReinvested = 0
  let alternativePotentialRevenue = 0
  let alternativeGrossMargin = 0
  let turnoverFraction = 0
  let alternativeGrossMarginWithinFinancingHorizon = 0
  let conservativeAlternativeReturn = 0

  if (preservedCashUse === 'REINVEST_IN_INVENTORY') {
    capitalReinvested = round2(preservedCash * (reinvestmentPct / 100))
    alternativePotentialRevenue = round2(capitalReinvested * alternativeInventoryMarkup)
    alternativeGrossMargin = round2(alternativePotentialRevenue - capitalReinvested)
    // Aproximação gerencial, não previsão contábil: fração do giro da
    // compra alternativa que efetivamente ocorre dentro do horizonte do
    // financiamento desta compra. Sem compor múltiplos giros nesta V1.
    turnoverFraction = Math.min(1, financingHorizonDays / alternativeInventoryTurnoverDays)
    alternativeGrossMarginWithinFinancingHorizon = round2(alternativeGrossMargin * turnoverFraction)
    // Heurística gerencial explícita: só uma fração conservadora da
    // margem teoricamente gerada é considerada "aproveitável" para esta
    // decisão — nunca 100% da margem bruta potencial.
    conservativeAlternativeReturn = round2(
      alternativeGrossMarginWithinFinancingHorizon * (alternativeReturnRealizationPct / 100),
    )
  }
  // Sob RESERVE: tudo acima permanece 0 — "não inventar retorno" (seção 7).

  const netLiquidityBenefit = round2(conservativeAlternativeReturn - liquidityCost)

  // ── 9 — modalidade mista ─────────────────────────────────────────────────────
  const mixed = computeMixedScenario({
    supplierAcceptsMixed,
    baseCost,
    installmentSurchargePct,
    installmentsCount,
    protectedExcessCash,
    cashCost,
    financedCost,
    freeCashBeforePurchase,
    minimumCashReserve,
    existingInstallments30d,
    projectedOperatingGeneration30d,
    minimumCoverageRatio,
    maximumNewInstallmentCapacity,
  })

  // ── Viabilidade (Passo 1) ─────────────────────────────────────────────────────
  const cashFitsReserve = cashCost <= protectedExcessCash
  const financedFitsCapacity = monthlyInstallment <= maximumNewInstallmentCapacity
  const financedMeetsCoverage = meetsCoverage(postPurchaseCoverageRatio, minimumCoverageRatio)
  const financedViable = financedFitsCapacity && financedMeetsCoverage

  // Retorno alternativo "sacrificado" proporcional à fração de caixa que o
  // misto de fato compromete agora (safeCashContribution), nunca o valor
  // cheio de conservativeAlternativeReturn (que pressupõe cashCost inteiro).
  const mixedForegoneAlternativeReturn =
    cashCost > 0 ? round2(conservativeAlternativeReturn * (mixed.safeCashContribution / cashCost)) : 0

  const decision = decidePurchase({
    cashFitsReserve,
    financedViable,
    mixed,
    mixedForegoneAlternativeReturn,
    cashCost,
    protectedExcessCash,
    financedCost,
    liquidityCost,
    protectedCashAfterCashPurchase,
    monthlyInstallment,
    maximumNewInstallmentCapacityDisplay,
    postPurchaseCoverageRatio,
    minimumCoverageRatio,
    preservedCashUse,
    conservativeAlternativeReturn,
    netLiquidityBenefit,
    implicitMonthlyRate,
  })

  const comparison = buildComparison({
    cashCost,
    financedCost,
    monthlyInstallment,
    freeCashBeforePurchase,
    currentCoverageRatio,
    postPurchaseCoverageRatio,
    liquidityCost,
    protectedCashAfterCashPurchase,
    protectedExcessCash,
    mixed,
    decisionType: decision.type,
    implicitMonthlyRate,
    conservativeAlternativeReturn,
    netLiquidityBenefit,
    mixedForegoneAlternativeReturn,
  })

  return {
    valid: true,
    result: {
      inputs,
      cashCost,
      financedCost,
      monthlyInstallment,
      liquidityCost,
      liquidityCostPct,
      freeCashBeforePurchase,
      protectedExcessCash,
      cashAfterCashPurchase,
      protectedCashAfterCashPurchase,
      projectedStoreCOGS30d,
      projectedStoreGrossMargin30d,
      projectedOperatingGeneration30d,
      maximumTotalInstallments,
      maximumNewInstallmentCapacity,
      maximumNewInstallmentCapacityDisplay,
      existingInstallmentsExceedPolicy,
      currentCoverageRatio,
      totalInstallmentsAfterPurchase,
      postPurchaseCoverageRatio,
      expectedMerchandiseDailySales,
      expectedMerchandiseDailyCOGSRecovery,
      expectedCOGSRecovered30d,
      installmentSelfPaymentRatio,
      mixed,
      implicitMonthlyRate,
      implicitAnnualEffectiveRate: implicitAnnualRate,
      preservedCash,
      capitalReinvested,
      alternativePotentialRevenue,
      alternativeGrossMargin,
      financingHorizonDays,
      turnoverFraction,
      alternativeGrossMarginWithinFinancingHorizon,
      conservativeAlternativeReturn,
      netLiquidityBenefit,
      decision,
      comparison,
    },
  }
}

// ─── Seção 9 (pedido anterior) — modalidade mista ───────────────────────────────

function computeMixedScenario(ctx: {
  supplierAcceptsMixed: boolean
  baseCost: number
  installmentSurchargePct: number
  installmentsCount: number
  protectedExcessCash: number
  cashCost: number
  financedCost: number
  freeCashBeforePurchase: number
  minimumCashReserve: number
  existingInstallments30d: number
  projectedOperatingGeneration30d: number
  minimumCoverageRatio: number
  maximumNewInstallmentCapacity: number
}): MixedScenario {
  const {
    supplierAcceptsMixed,
    baseCost,
    installmentSurchargePct,
    installmentsCount,
    protectedExcessCash,
    cashCost,
    financedCost,
    freeCashBeforePurchase,
    minimumCashReserve,
    existingInstallments30d,
    projectedOperatingGeneration30d,
    minimumCoverageRatio,
    maximumNewInstallmentCapacity,
  } = ctx

  // Entrada segura: nunca mais que o caixa excedente protegido, nunca mais
  // que o próprio custo à vista, nunca negativa.
  const safeCashContribution = round2(Math.max(0, Math.min(protectedExcessCash, cashCost)))
  const remainingBaseToFinance = round2(Math.max(0, baseCost - safeCashContribution))
  // Assume explicitamente que o fornecedor aplica o acréscimo do prazo só
  // sobre o saldo financiado — não há regra diferente documentada nem
  // suportada pelos dados desta V1.
  const mixedFinancedCost = round2(remainingBaseToFinance * (1 + installmentSurchargePct / 100))
  const monthlyInstallment = round2(mixedFinancedCost / installmentsCount)
  const totalCost = round2(safeCashContribution + mixedFinancedCost)

  const cashAfterInitialPayment = round2(freeCashBeforePurchase - safeCashContribution)
  const protectedCashAfterInitialPayment = round2(cashAfterInitialPayment - minimumCashReserve)
  const reservePreserved = protectedCashAfterInitialPayment >= 0

  const totalInstallmentsAfterPurchase = round2(existingInstallments30d + monthlyInstallment)
  const postPurchaseCoverageRatio = safeDiv(projectedOperatingGeneration30d, totalInstallmentsAfterPurchase)

  // addsValue: fora dessa faixa o misto equivale, na prática, a um dos
  // dois extremos (à vista puro ou financiado puro).
  const addsValue = safeCashContribution > 0 && safeCashContribution < cashCost
  const fitsCapacity = monthlyInstallment <= maximumNewInstallmentCapacity
  const meetsCoveragePolicy = meetsCoverage(postPurchaseCoverageRatio, minimumCoverageRatio)

  const viable =
    supplierAcceptsMixed && addsValue && fitsCapacity && meetsCoveragePolicy && reservePreserved

  // financedCost(puro) - totalCost(misto) = safeCashContribution * surcharge —
  // sempre >= 0: quanto menos se financia, menos juros nominal se paga.
  const financialSavings = round2(financedCost - totalCost)

  return {
    applicable: supplierAcceptsMixed,
    addsValue: supplierAcceptsMixed && addsValue,
    safeCashContribution,
    remainingBaseToFinance,
    financedCost: mixedFinancedCost,
    monthlyInstallment,
    totalCost,
    cashAfterInitialPayment,
    protectedCashAfterInitialPayment,
    reservePreserved,
    totalInstallmentsAfterPurchase,
    postPurchaseCoverageRatio,
    fitsCapacity,
    meetsCoveragePolicy,
    viable,
    financialSavings,
  }
}

// ─── Novo motor de decisão (seções 3, 14, 15 desta correção) ────────────────────

function decidePurchase(ctx: {
  cashFitsReserve: boolean
  financedViable: boolean
  mixed: MixedScenario
  mixedForegoneAlternativeReturn: number
  cashCost: number
  protectedExcessCash: number
  financedCost: number
  liquidityCost: number
  protectedCashAfterCashPurchase: number
  monthlyInstallment: number
  maximumNewInstallmentCapacityDisplay: number
  postPurchaseCoverageRatio: number | null
  minimumCoverageRatio: number
  preservedCashUse: PreservedCashUse
  conservativeAlternativeReturn: number
  netLiquidityBenefit: number
  implicitMonthlyRate: number | null
}): PurchaseDecision {
  const {
    cashFitsReserve,
    financedViable,
    mixed,
    mixedForegoneAlternativeReturn,
    cashCost,
    protectedExcessCash,
    financedCost,
    liquidityCost,
    protectedCashAfterCashPurchase,
    monthlyInstallment,
    maximumNewInstallmentCapacityDisplay,
    postPurchaseCoverageRatio,
    minimumCoverageRatio,
    preservedCashUse,
    conservativeAlternativeReturn,
    netLiquidityBenefit,
    implicitMonthlyRate,
  } = ctx

  const ratioLabel = (ratio: number | null) => (ratio !== null ? `${ratio.toFixed(2)}x` : 'sem parcelas restantes')
  const rateLabel = (rate: number | null) => (rate !== null ? formatPercent(rate * 100, 2) : 'não aplicável')

  // ── Passo 2 — crédito gratuito ou vantajoso: financiar é tão bom ou
  // melhor que pagar à vista, e cabe na capacidade. Ganha de CASH mesmo
  // que CASH também seja confortável — não há razão econômica para
  // antecipar caixa quando o prazo não custa nada (ou custa menos).
  if (financedViable && financedCost <= cashCost) {
    const justification =
      financedCost < cashCost
        ? `O parcelamento custa ${formatCurrency(cashCost - financedCost)} a menos que o pagamento à vista e ` +
          `preserva liquidez. Como as parcelas cabem na capacidade financeira estimada e mantêm folga de ` +
          `${ratioLabel(postPurchaseCoverageRatio)}, não há motivo para antecipar o desembolso.`
        : `O parcelamento não possui custo adicional e preserva liquidez. Como as parcelas cabem na ` +
          `capacidade financeira informada (folga de ${ratioLabel(postPurchaseCoverageRatio)}), não há ` +
          `vantagem econômica em antecipar o desembolso.`
    return {
      type: 'FINANCED',
      title: 'A prazo',
      justification,
      attentionLevel: attentionFor(postPurchaseCoverageRatio, minimumCoverageRatio),
    }
  }

  // ── Passo 3 — à vista viola a reserva ────────────────────────────────────────
  if (!cashFitsReserve) {
    const mixedIsBetter =
      mixed.viable && mixed.financialSavings > mixedForegoneAlternativeReturn

    if (mixedIsBetter) {
      const ratio = mixed.postPurchaseCoverageRatio
      const justification =
        `É possível usar ${formatCurrency(mixed.safeCashContribution)} de caixa sem romper a reserva e ` +
        `financiar apenas o restante (${formatCurrency(mixed.remainingBaseToFinance)}). Isso reduz o custo ` +
        `financeiro em ${formatCurrency(mixed.financialSavings)} frente ao financiamento total` +
        (mixedForegoneAlternativeReturn > 0
          ? `, mais do que compensando o retorno alternativo conservador (${formatCurrency(mixedForegoneAlternativeReturn)}) que se abriria mão sobre esse valor`
          : '') +
        `, e mantém a nova parcela de ${formatCurrency(mixed.monthlyInstallment)} dentro da capacidade ` +
        `projetada, com folga de ${ratioLabel(ratio)}.`
      return {
        type: 'MIXED',
        title: 'Misto — parte à vista, parte financiada',
        justification,
        attentionLevel: attentionFor(ratio, minimumCoverageRatio),
      }
    }

    if (financedViable) {
      const justification =
        `Comprar à vista consumiria ${formatCurrency(cashCost)}, mas o caixa excedente protegido é de apenas ` +
        `${formatCurrency(protectedExcessCash)}. A nova parcela de ${formatCurrency(monthlyInstallment)} cabe ` +
        `na capacidade mensal estimada de ${formatCurrency(maximumNewInstallmentCapacityDisplay)} e mantém ` +
        `folga de ${ratioLabel(postPurchaseCoverageRatio)}.`
      return {
        type: 'FINANCED',
        title: 'A prazo',
        justification,
        attentionLevel: attentionFor(postPurchaseCoverageRatio, minimumCoverageRatio),
      }
    }

    const justification =
      `Esta compra está acima da capacidade financeira definida pelas premissas atuais. ` +
      `O pagamento à vista consumiria ${formatCurrency(cashCost)}, mas o caixa excedente protegido é de ` +
      `apenas ${formatCurrency(protectedExcessCash)}. A parcela de ${formatCurrency(monthlyInstallment)} ` +
      `excede a capacidade mensal estimada de ${formatCurrency(maximumNewInstallmentCapacityDisplay)}` +
      (mixed.applicable ? ', e mesmo a modalidade mista não se encaixa na política de risco atual.' : '.')
    return { type: 'OVER_CAPACITY', title: 'Acima da capacidade financeira', justification, attentionLevel: 'critico' }
  }

  // ── Passo 4 — à vista E a prazo cabem, e financiar já não é grátis/vantajoso
  // (passo 2 já teria capturado esse caso) — decide pelo destino do caixa. ──────

  // A prazo nem sequer é viável dentro da capacidade/folga: à vista é a
  // única opção real, independente do destino do caixa. A capacidade
  // financeira é trava obrigatória — nenhum retorno alternativo a supera.
  if (!financedViable) {
    const justification =
      `A parcela de ${formatCurrency(monthlyInstallment)} não cabe confortavelmente na capacidade financeira ` +
      `projetada (folga exigida de ${minimumCoverageRatio.toFixed(2)}x). Como o pagamento à vista cabe no ` +
      `caixa excedente protegido e mantém ${formatCurrency(protectedCashAfterCashPurchase)} acima da reserva, ` +
      `é a opção segura.`
    return { type: 'CASH', title: 'À vista', justification, attentionLevel: 'ok' }
  }

  if (preservedCashUse === 'RESERVE') {
    // liquidityCost > 0 aqui sempre — o caso <= 0 já foi resolvido no passo 2.
    const justification =
      `O parcelamento custa ${formatCurrency(liquidityCost)} a mais que o pagamento à vista. Como o caixa ` +
      `preservado ficaria apenas em reserva (sem uso alternativo informado), não há retorno que justifique ` +
      `pagar esse prêmio. O pagamento à vista cabe no caixa excedente protegido, mantendo ` +
      `${formatCurrency(protectedCashAfterCashPurchase)} acima da reserva mínima.`
    return { type: 'CASH', title: 'À vista', justification, attentionLevel: 'ok' }
  }

  // REINVEST_IN_INVENTORY: compara retorno conservador vs. custo do crédito.
  if (conservativeAlternativeReturn > liquidityCost) {
    const justification =
      `Mesmo pagando ${formatCurrency(liquidityCost)} pelo prazo (taxa implícita de ${rateLabel(implicitMonthlyRate)} a.m.), ` +
      `o retorno alternativo conservador estimado do capital preservado (${formatCurrency(conservativeAlternativeReturn)}) ` +
      `supera esse custo — benefício líquido de ${formatCurrency(netLiquidityBenefit)}. As parcelas permanecem ` +
      `dentro da capacidade financeira, com folga de ${ratioLabel(postPurchaseCoverageRatio)}.`
    return {
      type: 'FINANCED',
      title: 'A prazo',
      justification,
      attentionLevel: attentionFor(postPurchaseCoverageRatio, minimumCoverageRatio),
    }
  }

  const justification =
    `Embora o parcelamento preserve caixa, o retorno alternativo conservador informado ` +
    `(${formatCurrency(conservativeAlternativeReturn)}) não compensa o custo adicional de ` +
    `${formatCurrency(liquidityCost)} do prazo (benefício líquido de ${formatCurrency(netLiquidityBenefit)}). ` +
    `Como o pagamento à vista preserva a reserva mínima, a opção à vista é economicamente superior.`
  return { type: 'CASH', title: 'À vista', justification, attentionLevel: 'ok' }
}

function attentionFor(ratio: number | null, minimum: number): AttentionLevel {
  if (ratio === null) return 'ok'
  if (ratio >= minimum * COMFORTABLE_COVERAGE_MULTIPLIER) return 'ok'
  return 'atencao'
}

// ─── Seção 17 — comparador de cenários ───────────────────────────────────────────

function buildComparison(ctx: {
  cashCost: number
  financedCost: number
  monthlyInstallment: number
  freeCashBeforePurchase: number
  currentCoverageRatio: number | null
  postPurchaseCoverageRatio: number | null
  liquidityCost: number
  protectedCashAfterCashPurchase: number
  protectedExcessCash: number
  mixed: MixedScenario
  decisionType: PurchaseDecisionType
  implicitMonthlyRate: number | null
  conservativeAlternativeReturn: number
  netLiquidityBenefit: number
  mixedForegoneAlternativeReturn: number
}): ComparisonColumn[] {
  const {
    cashCost,
    financedCost,
    monthlyInstallment,
    freeCashBeforePurchase,
    postPurchaseCoverageRatio,
    liquidityCost,
    protectedCashAfterCashPurchase,
    protectedExcessCash,
    mixed,
    decisionType,
    implicitMonthlyRate,
    conservativeAlternativeReturn,
    netLiquidityBenefit,
    mixedForegoneAlternativeReturn,
  } = ctx

  const cashColumn: ComparisonColumn = {
    key: 'cash',
    label: 'À vista',
    immediateOutlay: cashCost,
    totalCost: cashCost,
    monthlyInstallment: null,
    cashPreservedToday: 0,
    cashAfterInitialOutlay: round2(freeCashBeforePurchase - cashCost),
    installmentSlack: ctx.currentCoverageRatio,
    reservePreserved: protectedCashAfterCashPurchase >= 0,
    additionalFinancialCost: 0,
    isRecommended: decisionType === 'CASH',
    implicitMonthlyRate: null,
    conservativeAlternativeReturn: null,
    netLiquidityBenefit: null,
  }

  const financedColumn: ComparisonColumn = {
    key: 'financed',
    label: 'A prazo',
    immediateOutlay: 0,
    totalCost: financedCost,
    monthlyInstallment,
    cashPreservedToday: cashCost,
    cashAfterInitialOutlay: freeCashBeforePurchase,
    installmentSlack: postPurchaseCoverageRatio,
    reservePreserved: protectedExcessCash >= 0,
    additionalFinancialCost: liquidityCost,
    isRecommended: decisionType === 'FINANCED',
    implicitMonthlyRate,
    conservativeAlternativeReturn,
    netLiquidityBenefit,
  }

  const columns: ComparisonColumn[] = [cashColumn, financedColumn]

  if (mixed.applicable) {
    const mixedImplicitRate = solveImplicitMonthlyRate(
      mixed.safeCashContribution > 0 ? mixed.safeCashContribution : 0,
      mixed.monthlyInstallment,
      // periods vem implícito no monthlyInstallment/financedCost já calculados;
      // reaproveita o mesmo número de parcelas do cenário puro via razão financedCost/monthlyInstallment.
      monthlyInstallment > 0 ? Math.round(financedCost / monthlyInstallment) : 1,
    )
    columns.push({
      key: 'mixed',
      label: 'Misto',
      immediateOutlay: mixed.safeCashContribution,
      totalCost: mixed.totalCost,
      monthlyInstallment: mixed.monthlyInstallment,
      cashPreservedToday: round2(cashCost - mixed.safeCashContribution),
      cashAfterInitialOutlay: mixed.cashAfterInitialPayment,
      installmentSlack: mixed.postPurchaseCoverageRatio,
      reservePreserved: mixed.reservePreserved,
      additionalFinancialCost: round2(mixed.totalCost - cashCost),
      isRecommended: decisionType === 'MIXED',
      implicitMonthlyRate: mixedImplicitRate,
      conservativeAlternativeReturn: round2(conservativeAlternativeReturn - mixedForegoneAlternativeReturn),
      netLiquidityBenefit: round2(mixed.financialSavings - mixedForegoneAlternativeReturn),
    })
  }

  return columns
}
