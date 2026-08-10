/**
 * Calculadora de Compra e Alavancagem — motor de cálculo.
 *
 * 100% manual e 100% client-side: nenhuma tabela, nenhuma RPC, nenhuma
 * chamada de rede. Todas as entradas vêm do formulário; nada é lido do
 * estoque, fornecedores, financeiro ou sugestão de compras (V1
 * deliberadamente isolada dessas integrações).
 *
 * Objetivo: comparar comprar à vista, a prazo ou de forma mista,
 * considerando não só o custo nominal, mas a liquidez preservada, a
 * geração operacional projetada e a capacidade de assumir nova parcela
 * dentro de uma política de risco (folga mínima) definida pelo usuário.
 *
 * Toda a matemática mora aqui — nenhuma fórmula deve ser recalculada no
 * componente visual.
 */

import { formatCurrency } from '@/lib/utils/currency'
import { COMFORTABLE_COVERAGE_MULTIPLIER } from '@/lib/constants/purchaseCalculator'

// ─── Tipos de entrada ───────────────────────────────────────────────────────────

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
}

export type ValidationErrors = Partial<Record<keyof PurchaseCalculatorInputs, string>>

// ─── Validação (seção 14) ───────────────────────────────────────────────────────

function isValidNonNegative(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

/**
 * Campos monetários e de caixa podem ser zero (compra sem histórico de
 * vendas, caixa zerado, sem parcelas existentes etc.) — só bloqueia
 * valores não numéricos ou negativos, e as regras específicas de
 * markup/parcelas/prazo/folga descritas na seção 14 do pedido.
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
}

export interface PurchaseCalculatorResult {
  inputs: PurchaseCalculatorInputs

  // 4.1 / 4.2 / 4.3
  cashCost: number
  financedCost: number
  monthlyInstallment: number
  liquidityCost: number
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

  // 10 / 11
  decision: PurchaseDecision

  // 13
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

  // ── 5 — geração operacional em 30 dias (markup > 0 já garantido pela
  // validação). Usa SOMENTE expectedStoreSales30d — faturamento da loja
  // em 30 dias — nunca a venda esperada da mercadoria (horizonte de giro
  // diferente). Corrige a inconsistência de horizontes temporais da V1
  // (venda da mercadoria em N dias de giro sendo usada como se fosse
  // faturamento mensal da loja).
  const projectedStoreCOGS30d = round2(expectedStoreSales30d / markup)
  const projectedStoreGrossMargin30d = round2(expectedStoreSales30d - projectedStoreCOGS30d)
  // Deliberadamente NÃO desconta existingInstallments30d aqui — parcelas
  // entram só no serviço da dívida (seção 6/7), não na geração operacional.
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

  // ── 8 — autopagamento estimado da parcela. Usa SOMENTE
  // expectedMerchandiseSales / expectedTurnoverDays — a velocidade de
  // giro desta mercadoria específica, nunca o faturamento da loja.
  const expectedMerchandiseDailySales = round2(expectedMerchandiseSales / expectedTurnoverDays)
  const expectedMerchandiseDailyCOGSRecovery = round2(expectedMerchandiseDailySales / markup)
  const expectedCOGSRecovered30d = round2(expectedMerchandiseDailyCOGSRecovery * 30)
  const installmentSelfPaymentRatio = safeDiv(expectedCOGSRecovered30d, monthlyInstallment)

  // ── 9 — modalidade mista ─────────────────────────────────────────────────────
  const mixed = computeMixedScenario({
    supplierAcceptsMixed,
    baseCost,
    installmentSurchargePct,
    installmentsCount,
    protectedExcessCash,
    cashCost,
    freeCashBeforePurchase,
    minimumCashReserve,
    existingInstallments30d,
    projectedOperatingGeneration30d,
    minimumCoverageRatio,
    maximumNewInstallmentCapacity,
  })

  // ── 10 — motor de decisão ────────────────────────────────────────────────────
  const cashFitsReserve = cashCost <= protectedExcessCash
  const financedFitsCapacity = monthlyInstallment <= maximumNewInstallmentCapacity
  const financedMeetsCoverage = meetsCoverage(postPurchaseCoverageRatio, minimumCoverageRatio)
  const financedViable = financedFitsCapacity && financedMeetsCoverage

  const decision = decidePurchase({
    cashFitsReserve,
    financedViable,
    mixedViable: mixed.viable,
    cashCost,
    protectedExcessCash,
    financedCost,
    liquidityCost,
    protectedCashAfterCashPurchase,
    monthlyInstallment,
    maximumNewInstallmentCapacityDisplay,
    postPurchaseCoverageRatio,
    minimumCoverageRatio,
    mixed,
  })

  const comparison = buildComparison({
    cashCost,
    financedCost,
    monthlyInstallment,
    freeCashBeforePurchase,
    minimumCashReserve,
    currentCoverageRatio,
    postPurchaseCoverageRatio,
    liquidityCost,
    protectedCashAfterCashPurchase,
    protectedExcessCash,
    mixed,
    decisionType: decision.type,
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
      decision,
      comparison,
    },
  }
}

// ─── Seção 9 — modalidade mista ─────────────────────────────────────────────────

function computeMixedScenario(ctx: {
  supplierAcceptsMixed: boolean
  baseCost: number
  installmentSurchargePct: number
  installmentsCount: number
  protectedExcessCash: number
  cashCost: number
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
  // suportada pelos dados desta V1 (ver seção 9 do pedido).
  const financedCost = round2(remainingBaseToFinance * (1 + installmentSurchargePct / 100))
  const monthlyInstallment = round2(financedCost / installmentsCount)
  const totalCost = round2(safeCashContribution + financedCost)

  const cashAfterInitialPayment = round2(freeCashBeforePurchase - safeCashContribution)
  const protectedCashAfterInitialPayment = round2(cashAfterInitialPayment - minimumCashReserve)
  const reservePreserved = protectedCashAfterInitialPayment >= 0

  const totalInstallmentsAfterPurchase = round2(existingInstallments30d + monthlyInstallment)
  const postPurchaseCoverageRatio = safeDiv(projectedOperatingGeneration30d, totalInstallmentsAfterPurchase)

  // addsValue: fora dessa faixa o misto equivale, na prática, a um dos
  // dois extremos (à vista puro ou financiado puro) — ver seção 9.
  const addsValue = safeCashContribution > 0 && safeCashContribution < cashCost
  const fitsCapacity = monthlyInstallment <= maximumNewInstallmentCapacity
  const meetsCoveragePolicy = meetsCoverage(postPurchaseCoverageRatio, minimumCoverageRatio)

  const viable =
    supplierAcceptsMixed && addsValue && fitsCapacity && meetsCoveragePolicy && reservePreserved

  return {
    applicable: supplierAcceptsMixed,
    addsValue: supplierAcceptsMixed && addsValue,
    safeCashContribution,
    remainingBaseToFinance,
    financedCost,
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
  }
}

// ─── Seção 10/11 — motor de decisão + justificativa ─────────────────────────────

function decidePurchase(ctx: {
  cashFitsReserve: boolean
  financedViable: boolean
  mixedViable: boolean
  cashCost: number
  protectedExcessCash: number
  financedCost: number
  liquidityCost: number
  protectedCashAfterCashPurchase: number
  monthlyInstallment: number
  maximumNewInstallmentCapacityDisplay: number
  postPurchaseCoverageRatio: number | null
  minimumCoverageRatio: number
  mixed: MixedScenario
}): PurchaseDecision {
  const {
    cashFitsReserve,
    financedViable,
    mixedViable,
    cashCost,
    protectedExcessCash,
    liquidityCost,
    protectedCashAfterCashPurchase,
    monthlyInstallment,
    maximumNewInstallmentCapacityDisplay,
    postPurchaseCoverageRatio,
    minimumCoverageRatio,
    mixed,
  } = ctx

  // 10.1 — acima da capacidade: nem à vista, nem a prazo, nem misto cabem.
  if (!cashFitsReserve && !financedViable && !mixedViable) {
    const justification =
      `Esta compra está acima da capacidade financeira definida pelas premissas atuais. ` +
      `O pagamento à vista consumiria ${formatCurrency(cashCost)}, mas o caixa excedente protegido é de ` +
      `apenas ${formatCurrency(protectedExcessCash)}. A parcela de ${formatCurrency(monthlyInstallment)} ` +
      `excede a capacidade mensal estimada de ${formatCurrency(maximumNewInstallmentCapacityDisplay)}` +
      (mixed.applicable ? ', e mesmo a modalidade mista não se encaixa na política de risco atual.' : '.')
    return { type: 'OVER_CAPACITY', title: 'Acima da capacidade financeira', justification, attentionLevel: 'critico' }
  }

  // 10.2 — à vista, preferido por padrão sempre que cabe (10.5: empate CASH x FINANCED -> CASH).
  if (cashFitsReserve) {
    const justification =
      liquidityCost > 0
        ? `O pagamento à vista economiza ${formatCurrency(liquidityCost)} e, após a compra, ainda permanecem ` +
          `${formatCurrency(protectedCashAfterCashPurchase)} acima da reserva mínima. Não há necessidade ` +
          `financeira de pagar o prêmio pelo parcelamento.`
        : `O pagamento à vista cabe integralmente no caixa excedente protegido, mantendo ` +
          `${formatCurrency(protectedCashAfterCashPurchase)} acima da reserva mínima após a compra.`
    return { type: 'CASH', title: 'À vista', justification, attentionLevel: 'ok' }
  }

  // 10.4 — misto preferido sobre financiado puro quando viável (reduz custo financeiro sem violar reserva).
  if (mixedViable) {
    const savings = round2(ctx.financedCost - mixed.totalCost)
    const ratioLabel = mixed.postPurchaseCoverageRatio !== null ? `${mixed.postPurchaseCoverageRatio.toFixed(2)}x` : 'sem parcelas restantes'
    const justification =
      `É possível usar ${formatCurrency(mixed.safeCashContribution)} de caixa sem romper a reserva e financiar ` +
      `apenas o restante (${formatCurrency(mixed.remainingBaseToFinance)}). Isso reduz o custo financeiro em ` +
      `${formatCurrency(savings)} frente ao financiamento total e mantém a nova parcela de ` +
      `${formatCurrency(mixed.monthlyInstallment)} dentro da capacidade projetada, com folga de ${ratioLabel}.`
    return { type: 'MIXED', title: 'Misto — parte à vista, parte financiada', justification, attentionLevel: attentionFor(mixed.postPurchaseCoverageRatio, minimumCoverageRatio) }
  }

  // 10.3 — financiado puro.
  const ratioLabel = postPurchaseCoverageRatio !== null ? `${postPurchaseCoverageRatio.toFixed(2)}x` : 'sem parcelas restantes'
  const justification =
    `Comprar à vista consumiria ${formatCurrency(cashCost)}, mas o caixa excedente protegido é de apenas ` +
    `${formatCurrency(protectedExcessCash)}. A nova parcela de ${formatCurrency(monthlyInstallment)} cabe na ` +
    `capacidade mensal estimada de ${formatCurrency(maximumNewInstallmentCapacityDisplay)} e mantém folga de ${ratioLabel}.`
  return { type: 'FINANCED', title: 'A prazo', justification, attentionLevel: attentionFor(postPurchaseCoverageRatio, minimumCoverageRatio) }
}

function attentionFor(ratio: number | null, minimum: number): AttentionLevel {
  if (ratio === null) return 'ok'
  if (ratio >= minimum * COMFORTABLE_COVERAGE_MULTIPLIER) return 'ok'
  return 'atencao'
}

// ─── Seção 13 — comparador de cenários ───────────────────────────────────────────

function buildComparison(ctx: {
  cashCost: number
  financedCost: number
  monthlyInstallment: number
  freeCashBeforePurchase: number
  minimumCashReserve: number
  currentCoverageRatio: number | null
  postPurchaseCoverageRatio: number | null
  liquidityCost: number
  protectedCashAfterCashPurchase: number
  protectedExcessCash: number
  mixed: MixedScenario
  decisionType: PurchaseDecisionType
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
  } = ctx

  const cashColumn: ComparisonColumn = {
    key: 'cash',
    label: 'À vista',
    immediateOutlay: cashCost,
    totalCost: cashCost,
    monthlyInstallment: null,
    // "Caixa preservado hoje": quanto do custo à vista deixou de ser gasto agora (0 aqui — tudo é gasto agora).
    cashPreservedToday: 0,
    cashAfterInitialOutlay: round2(freeCashBeforePurchase - cashCost),
    installmentSlack: ctx.currentCoverageRatio,
    reservePreserved: protectedCashAfterCashPurchase >= 0,
    additionalFinancialCost: 0,
    isRecommended: decisionType === 'CASH',
  }

  const financedColumn: ComparisonColumn = {
    key: 'financed',
    label: 'A prazo',
    immediateOutlay: 0,
    totalCost: financedCost,
    monthlyInstallment,
    cashPreservedToday: cashCost, // nada pago agora: preserva o equivalente ao custo à vista inteiro
    cashAfterInitialOutlay: freeCashBeforePurchase,
    installmentSlack: postPurchaseCoverageRatio,
    reservePreserved: protectedExcessCash >= 0,
    additionalFinancialCost: liquidityCost,
    isRecommended: decisionType === 'FINANCED',
  }

  const columns: ComparisonColumn[] = [cashColumn, financedColumn]

  if (mixed.applicable) {
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
    })
  }

  return columns
}
