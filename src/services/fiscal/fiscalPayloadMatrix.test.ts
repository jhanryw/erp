/**
 * Matriz mínima de homologação (automatizada) — Fase Fiscal 4I, hardening
 * pré-produção.
 *
 * Roda os MESMOS 12 cenários de negócio (1 item/múltiplos itens, desconto/
 * acréscimo/frete globais, dinheiro exato/com troco, múltiplas formas de
 * pagamento, arredondamento com centavos) contra os DOIS builders reais
 * (`buildNfePayload`/`buildNfcePayload`) e prova, pra cada um, a mesma
 * identidade fiscal exigida:
 *
 *   total fiscal (produtos - desconto + frete + outras despesas) = total comercial
 *   soma(pagamentos) - troco = total fiscal
 *
 * Não é um teste de regra tributária (CFOP/CSOSN/CST) — isso já é coberto
 * por `buildNfePayload.test.ts`/`buildNfcePayload.test.ts`. Este arquivo
 * prova só a RECONCILIAÇÃO MONETÁRIA, ponto a ponto, pros dois documentos.
 */

import { describe, it, expect } from 'vitest'
import { buildNfePayload } from './buildNfePayload'
import { buildNfcePayload } from './buildNfcePayload'
import { baseFiscalContext } from './testFixtures'
import type { FiscalDocumentContext, FiscalSaleItemContext, FiscalPaymentContext } from './types'

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function item(overrides: Partial<FiscalSaleItemContext> & { saleItemId: number; unitPrice: number }): FiscalSaleItemContext {
  return {
    productId: overrides.saleItemId,
    variationId: overrides.saleItemId,
    description: `Item real ${overrides.saleItemId}`,
    sku: `SKU-${overrides.saleItemId}`,
    quantity: 1,
    discountAmount: 0,
    unit: 'UN',
    ncm: '61091000',
    cest: null,
    origem: 2,
    ...overrides,
  }
}

interface Scenario {
  name: string
  items: FiscalSaleItemContext[]
  payments: FiscalPaymentContext[]
  adjustments: { discount: number; surcharge: number; shipping: number }
  expectedTotalFiscal: number
  expectedTroco: number
}

const SCENARIOS: Scenario[] = [
  {
    name: '1 item, PIX, sem ajustes',
    items: [item({ saleItemId: 1, unitPrice: 29.99 })],
    payments: [{ method: 'pix', netAmount: 29.99, cardBrand: null, amountTendered: 29.99, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 29.99,
    expectedTroco: 0,
  },
  {
    name: '1 item, PIX, com acréscimo global (achado real, venda 626)',
    items: [item({ saleItemId: 1, unitPrice: 19.99 })],
    payments: [{ method: 'pix', netAmount: 29.99, cardBrand: null, amountTendered: 29.99, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 10, shipping: 0 },
    expectedTotalFiscal: 29.99,
    expectedTroco: 0,
  },
  {
    name: '1 item com desconto POR ITEM (não global)',
    items: [item({ saleItemId: 1, unitPrice: 50, discountAmount: 5 })],
    payments: [{ method: 'pix', netAmount: 45, cardBrand: null, amountTendered: 45, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 45,
    expectedTroco: 0,
  },
  {
    name: 'múltiplos itens, sem ajuste',
    items: [item({ saleItemId: 1, unitPrice: 30 }), item({ saleItemId: 2, unitPrice: 20 })],
    payments: [{ method: 'pix', netAmount: 50, cardBrand: null, amountTendered: 50, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 50,
    expectedTroco: 0,
  },
  {
    name: 'múltiplos itens, com desconto GLOBAL (rateio proporcional 30:20)',
    items: [item({ saleItemId: 1, unitPrice: 30 }), item({ saleItemId: 2, unitPrice: 20 })],
    payments: [{ method: 'pix', netAmount: 40, cardBrand: null, amountTendered: 40, changeAmount: 0 }],
    adjustments: { discount: 10, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 40,
    expectedTroco: 0,
  },
  {
    name: 'múltiplos itens, com acréscimo GLOBAL (rateio proporcional)',
    items: [item({ saleItemId: 1, unitPrice: 30 }), item({ saleItemId: 2, unitPrice: 20 })],
    payments: [{ method: 'pix', netAmount: 60, cardBrand: null, amountTendered: 60, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 10, shipping: 0 },
    expectedTotalFiscal: 60,
    expectedTroco: 0,
  },
  {
    name: 'múltiplos itens, com frete (rateio proporcional)',
    items: [item({ saleItemId: 1, unitPrice: 30 }), item({ saleItemId: 2, unitPrice: 20 })],
    payments: [{ method: 'pix', netAmount: 60, cardBrand: null, amountTendered: 60, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 10 },
    expectedTotalFiscal: 60,
    expectedTroco: 0,
  },
  {
    name: 'desconto + acréscimo + frete GLOBAIS combinados',
    items: [item({ saleItemId: 1, unitPrice: 30 }), item({ saleItemId: 2, unitPrice: 20 })],
    payments: [{ method: 'pix', netAmount: 48, cardBrand: null, amountTendered: 48, changeAmount: 0 }],
    adjustments: { discount: 10, surcharge: 5, shipping: 3 }, // 50 - 10 + 5 + 3 = 48
    expectedTotalFiscal: 48,
    expectedTroco: 0,
  },
  {
    name: 'dinheiro exato — sem troco',
    items: [item({ saleItemId: 1, unitPrice: 29.99 })],
    payments: [{ method: 'cash', netAmount: 29.99, cardBrand: null, amountTendered: 29.99, changeAmount: 0 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 29.99,
    expectedTroco: 0,
  },
  {
    name: 'dinheiro com troco real — total=80, entregue=100, troco=20 (cenário exato do pedido)',
    items: [item({ saleItemId: 1, unitPrice: 80 })],
    payments: [{ method: 'cash', netAmount: 80, cardBrand: null, amountTendered: 100, changeAmount: 20 }],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 80,
    expectedTroco: 20,
  },
  {
    name: 'múltiplas formas de pagamento (PIX + dinheiro com troco só na parte em dinheiro)',
    items: [item({ saleItemId: 1, unitPrice: 100 })],
    payments: [
      { method: 'pix', netAmount: 60, cardBrand: null, amountTendered: 60, changeAmount: 0 },
      { method: 'cash', netAmount: 40, cardBrand: null, amountTendered: 50, changeAmount: 10 },
    ],
    adjustments: { discount: 0, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 100,
    expectedTroco: 10,
  },
  {
    name: 'arredondamento com centavos — 3 itens (10.00 + 10.00 + 10.01), desconto global 10.00 força rateio fracionário',
    items: [
      item({ saleItemId: 1, unitPrice: 10.0 }),
      item({ saleItemId: 2, unitPrice: 10.0 }),
      item({ saleItemId: 3, unitPrice: 10.01 }),
    ],
    payments: [{ method: 'pix', netAmount: 20.01, cardBrand: null, amountTendered: 20.01, changeAmount: 0 }],
    adjustments: { discount: 10, surcharge: 0, shipping: 0 },
    expectedTotalFiscal: 20.01,
    expectedTroco: 0,
  },
]

function nfceCtx(scenario: Scenario): FiscalDocumentContext {
  return baseFiscalContext({
    items: scenario.items,
    payments: scenario.payments,
    saleDiscountAmount: scenario.adjustments.discount,
    saleSurchargeAmount: scenario.adjustments.surcharge,
    saleShippingCharged: scenario.adjustments.shipping,
    operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
    destinatario: {
      nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null,
      telefone: null, email: null, logradouro: null, numero: null, complemento: null,
      bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null,
    },
  })
}

function nfeCtx(scenario: Scenario): FiscalDocumentContext {
  return baseFiscalContext({
    items: scenario.items,
    payments: scenario.payments,
    saleDiscountAmount: scenario.adjustments.discount,
    saleSurchargeAmount: scenario.adjustments.surcharge,
    saleShippingCharged: scenario.adjustments.shipping,
  })
}

function reconcile(payload: { items: Array<{ valor_bruto: number; valor_desconto?: number; valor_frete?: number; valor_outras_despesas?: number }>; formas_pagamento: Array<{ valor_pagamento: number }>; valor_troco?: number }) {
  const produtos = round2(payload.items.reduce((sum, i) => sum + i.valor_bruto, 0))
  const desconto = round2(payload.items.reduce((sum, i) => sum + (i.valor_desconto ?? 0), 0))
  const frete = round2(payload.items.reduce((sum, i) => sum + (i.valor_frete ?? 0), 0))
  const outrasDespesas = round2(payload.items.reduce((sum, i) => sum + (i.valor_outras_despesas ?? 0), 0))
  const totalFiscal = round2(produtos - desconto + frete + outrasDespesas)
  const pagamentos = round2(payload.formas_pagamento.reduce((sum, f) => sum + f.valor_pagamento, 0))
  const troco = round2(payload.valor_troco ?? 0)
  return { produtos, desconto, frete, outrasDespesas, totalFiscal, pagamentos, troco }
}

describe.each(SCENARIOS)('Matriz de homologação — NFC-e — $name', (scenario) => {
  it('total fiscal = total comercial; pagamentos - troco = total fiscal; nenhum item negativo', () => {
    const payload = buildNfcePayload(nfceCtx(scenario))
    const r = reconcile(payload)

    expect(r.totalFiscal).toBe(scenario.expectedTotalFiscal)
    expect(r.troco).toBe(scenario.expectedTroco)
    expect(round2(r.pagamentos - r.troco)).toBe(r.totalFiscal)

    for (const it of payload.items) {
      expect(it.valor_bruto - (it.valor_desconto ?? 0)).toBeGreaterThanOrEqual(-0.001) // nunca negativo (tolerância de ponto flutuante)
    }
  })
})

describe.each(SCENARIOS)('Matriz de homologação — NF-e — $name', (scenario) => {
  it('total fiscal = total comercial; pagamentos - troco = total fiscal; nenhum item negativo', () => {
    const payload = buildNfePayload(nfeCtx(scenario))
    const r = reconcile(payload)

    expect(r.totalFiscal).toBe(scenario.expectedTotalFiscal)
    expect(r.troco).toBe(scenario.expectedTroco)
    expect(round2(r.pagamentos - r.troco)).toBe(r.totalFiscal)

    for (const it of payload.items) {
      expect(it.valor_bruto - (it.valor_desconto ?? 0)).toBeGreaterThanOrEqual(-0.001)
    }
  })
})

describe('Matriz de homologação — arredondamento não perde nem sobra centavo (prova de exatidão)', () => {
  it('soma dos valor_bruto - valor_desconto + valor_frete + valor_outras_despesas dos itens bate EXATAMENTE com o total esperado, mesmo com 3 itens e desconto que não divide igualmente', () => {
    const scenario = SCENARIOS.find((s) => s.name.startsWith('arredondamento'))!
    const payloadNfce = buildNfcePayload(nfceCtx(scenario))
    const payloadNfe = buildNfePayload(nfeCtx(scenario))

    for (const payload of [payloadNfce, payloadNfe]) {
      const somaDescontos = payload.items.reduce((sum, i) => sum + (i.valor_desconto ?? 0), 0)
      expect(round2(somaDescontos)).toBe(10) // exatamente o desconto global pedido, sem sobra/falta de centavo
    }
  })
})
