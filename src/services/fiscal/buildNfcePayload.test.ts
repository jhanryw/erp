import { describe, it, expect } from 'vitest'
import { buildNfcePayload, NFCE_CFOP_INTERNO } from './buildNfcePayload'
import { FiscalBuildError } from './buildNfePayload'
import { baseFiscalContext } from './testFixtures'

/** Contexto de balcão — presencial, consumidor não identificado, sem endereço de destinatário. */
function nfceContext(overrides: Parameters<typeof baseFiscalContext>[0] = {}) {
  return baseFiscalContext({
    operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
    destinatario: {
      nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null,
      telefone: null, email: null, logradouro: null, numero: null, complemento: null,
      bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null,
    },
    ...overrides,
  })
}

describe('buildNfcePayload — consumidor não identificado (caminho feliz de balcão)', () => {
  it('monta payload sem NENHUM campo de destinatário quando não identificado', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(payload.nome_destinatario).toBeUndefined()
    expect(payload.cpf_destinatario).toBeUndefined()
    expect(payload.cnpj_destinatario).toBeUndefined()
    expect(payload.indicador_inscricao_estadual_destinatario).toBeUndefined()
  })

  it('nunca lança por falta de endereço/nome/documento do destinatário', () => {
    expect(() => buildNfcePayload(nfceContext())).not.toThrow()
  })

  it('presenca_comprador="1", local_destino="1", modalidade_frete="9" — sempre, hardcoded', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(payload.presenca_comprador).toBe('1')
    expect(payload.local_destino).toBe('1')
    expect(payload.modalidade_frete).toBe('9')
  })

  it('data_emissao é um ISO 8601 válido, gerado no momento da montagem', () => {
    const before = Date.now()
    const payload = buildNfcePayload(nfceContext())
    const parsed = Date.parse(payload.data_emissao)
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(Date.now())
  })

  it('CFOP sempre interno (5102), nunca calculado por UF de destino', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(payload.items[0].cfop).toBe(NFCE_CFOP_INTERNO)
    expect(payload.items[0].cfop).toBe('5102')
  })
})

describe('buildNfcePayload — CPF informado (cliente pediu nota)', () => {
  it('inclui só cpf_destinatario, nenhum outro campo de destinatário', () => {
    const ctx = nfceContext({ destinatario: { ...nfceContext().destinatario, cpf: '11144477735' } })
    const payload = buildNfcePayload(ctx)
    expect(payload.cpf_destinatario).toBe('11144477735')
    expect(payload.nome_destinatario).toBeUndefined()
  })
})

describe('buildNfcePayload — itens: unidade/quantidade tributável = comercial (sem conversão fabricada)', () => {
  it('quantidade_tributavel/unidade_tributavel espelham exatamente os valores comerciais', () => {
    const payload = buildNfcePayload(nfceContext())
    const item = payload.items[0]
    expect(item.quantidade_tributavel).toBe(item.quantidade_comercial)
    expect(item.unidade_tributavel).toBe(item.unidade_comercial)
    expect(item.valor_unitario_tributavel).toBe(item.valor_unitario_comercial)
  })

  it('numero_item e icms_origem são STRING (schema real de NFC-e, diferente de NF-e)', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(typeof payload.items[0].numero_item).toBe('string')
    expect(typeof payload.items[0].icms_origem).toBe('string')
  })

  it('nunca envia valor_total_tributos (sem base de cálculo confiável, não fabrica 0)', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(payload.items[0].valor_total_tributos).toBeUndefined()
  })

  it('PIS/COFINS sempre explícitos e zerados (mesmo padrão de NF-e, mesma fonte de evidência)', () => {
    const payload = buildNfcePayload(nfceContext())
    const item = payload.items[0]
    expect(item.pis_situacao_tributaria).toBe('49')
    expect(item.pis_valor).toBe(0)
    expect(item.cofins_situacao_tributaria).toBe('49')
    expect(item.cofins_valor).toBe(0)
  })
})

describe('buildNfcePayload — formas_pagamento reaproveita paymentRules.ts (mesma tabela nacional)', () => {
  it('PIX/dinheiro/crédito/débito mapeados com os mesmos códigos de NF-e', () => {
    const ctx = nfceContext({ payments: [{ method: 'pix', netAmount: 79.8, cardBrand: null }] })
    expect(buildNfcePayload(ctx).formas_pagamento[0].forma_pagamento).toBe('20')
  })

  it('múltiplos pagamentos → array com uma entrada por pagamento', () => {
    const ctx = nfceContext({ payments: [
      { method: 'cash', netAmount: 40, cardBrand: null },
      { method: 'credit_card', netAmount: 39.8, cardBrand: 'visa' },
    ] })
    const formas = buildNfcePayload(ctx).formas_pagamento
    expect(formas).toHaveLength(2)
    expect(formas[0].forma_pagamento).toBe('01')
    expect(formas[1].forma_pagamento).toBe('03')
    expect(formas[1].bandeira_operadora).toBe('01')
  })

  it('nunca inclui indicador_pagamento (campo não existe no schema real de NFC-e)', () => {
    const payload = buildNfcePayload(nfceContext())
    expect((payload.formas_pagamento[0] as any).indicador_pagamento).toBeUndefined()
  })

  it('método não suportado ("card" legado) → lança FiscalRuleNotImplementedError (propagada, não capturada aqui)', () => {
    const ctx = nfceContext({ payments: [{ method: 'card', netAmount: 79.8, cardBrand: null }] })
    expect(() => buildNfcePayload(ctx)).toThrow()
  })
})

describe('buildNfcePayload — troco real (Fase Fiscal 4I, hardening pré-produção)', () => {
  it('amountTendered/changeAmount ausentes (compatibilidade) → valor_pagamento cai pra netAmount, nenhum valor_troco', () => {
    const ctx = nfceContext({ payments: [{ method: 'pix', netAmount: 79.8, cardBrand: null }] })
    const payload = buildNfcePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(79.8)
    expect(payload.valor_troco).toBeUndefined()
  })

  it('dinheiro com troco real (total=80, entregue=100, troco=20 — cenário exato do pedido) → valor_pagamento=100 (tendered), valor_troco=20 no documento', () => {
    const ctx = nfceContext({
      items: [{ ...nfceContext().items[0], unitPrice: 80, quantity: 1, discountAmount: 0 }],
      payments: [{ method: 'cash', netAmount: 80, cardBrand: null, amountTendered: 100, changeAmount: 20 }],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(100)
    expect(payload.valor_troco).toBe(20)
  })

  it('PIX (sem troco) + dinheiro com troco → valor_troco reflete só o troco real', () => {
    const ctx = nfceContext({
      items: [{ ...nfceContext().items[0], unitPrice: 100, quantity: 1 }],
      payments: [
        { method: 'pix', netAmount: 60, cardBrand: null, amountTendered: 60, changeAmount: 0 },
        { method: 'cash', netAmount: 40, cardBrand: null, amountTendered: 50, changeAmount: 10 },
      ],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(60)
    expect(payload.formas_pagamento[1].valor_pagamento).toBe(50)
    expect(payload.valor_troco).toBe(10)
  })
})

describe('buildNfcePayload — campos obrigatórios ausentes lançam FiscalBuildError', () => {
  it('NCM ausente → lança', () => {
    const ctx = nfceContext({ items: [{ ...nfceContext().items[0], ncm: null }] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('NCM malformado → lança', () => {
    const ctx = nfceContext({ items: [{ ...nfceContext().items[0], ncm: '123' }] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('origem ausente → lança', () => {
    const ctx = nfceContext({ items: [{ ...nfceContext().items[0], origem: null }] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('unidade ausente → lança', () => {
    const ctx = nfceContext({ items: [{ ...nfceContext().items[0], unit: null }] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('emitente sem CRT → lança', () => {
    const ctx = nfceContext({ emitente: { ...nfceContext().emitente, crt: null } })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('venda sem itens → lança', () => {
    const ctx = nfceContext({ items: [] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('venda sem pagamentos → lança', () => {
    const ctx = nfceContext({ payments: [] })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('presencaComprador fora de {1,4} → lança (defesa própria do builder, NFC-e nunca aceita outros valores)', () => {
    const ctx = nfceContext({ operation: { ...nfceContext().operation, presencaComprador: 2 } })
    expect(() => buildNfcePayload(ctx)).toThrow(FiscalBuildError)
    expect(() => buildNfcePayload(ctx)).toThrow(/presencaComprador/)
  })

  it('presencaComprador=4 (entrega a domicílio) é aceito', () => {
    const ctx = nfceContext({ operation: { ...nfceContext().operation, presencaComprador: 4 } })
    expect(() => buildNfcePayload(ctx)).not.toThrow()
    expect(buildNfcePayload(ctx).presenca_comprador).toBe('4')
  })
})

describe('buildNfcePayload — grupos proibidos no modelo 65 (achado real, rejeição SEFAZ 742, venda 626)', () => {
  it('nunca inclui grupo IPI, mesmo quando o produto teria CST/enquadramento suficientes pra NF-e', () => {
    const payload = buildNfcePayload(nfceContext())
    const item = payload.items[0] as any
    expect(item.ipi_situacao_tributaria).toBeUndefined()
    expect(item.ipi_codigo_enquadramento_legal).toBeUndefined()
    expect('ipi_situacao_tributaria' in item).toBe(false)
    expect('ipi_codigo_enquadramento_legal' in item).toBe(false)
  })

  it('nunca inclui grupo II (imposto de importação) — não implementado em nenhum builder deste ERP', () => {
    const item = buildNfcePayload(nfceContext()).items[0] as any
    expect(item.ii_valor).toBeUndefined()
    expect(item.ii_base_calculo).toBeUndefined()
  })

  it('nunca inclui PIS-ST/COFINS-ST — só CST 49 (não tributado) é usado, nunca substituição tributária', () => {
    const item = buildNfcePayload(nfceContext()).items[0] as any
    expect(item.pis_st_valor).toBeUndefined()
    expect(item.pis_st_base_calculo).toBeUndefined()
    expect(item.cofins_st_valor).toBeUndefined()
    expect(item.cofins_st_base_calculo).toBeUndefined()
  })

  it('nunca inclui grupo de transporte/volumes — retirada não tem transportador (modalidade_frete="9" é o único sinal enviado)', () => {
    const payload = buildNfcePayload(nfceContext()) as any
    expect(payload.transporte).toBeUndefined()
    expect(payload.volumes).toBeUndefined()
    expect(payload.transportador).toBeUndefined()
    expect(payload.modalidade_frete).toBe('9')
  })
})

/**
 * Total fiscal reconstituído exatamente como a Focus computa (soma de
 * `valor_bruto - valor_desconto + valor_frete + valor_outras_despesas` de
 * cada item) — mesma fórmula da identidade exigida pelo pedido:
 * "valor total dos itens - descontos + frete + outras despesas = total
 * fiscal da nota".
 */
function reconciledNfceTotal(payload: ReturnType<typeof buildNfcePayload>): number {
  const itemsTotal = payload.items.reduce(
    (sum, item) => sum + item.valor_bruto - (item.valor_desconto ?? 0) + (item.valor_frete ?? 0) + (item.valor_outras_despesas ?? 0),
    0,
  )
  return Math.round(itemsTotal * 100) / 100
}

function paymentsTotal(payload: ReturnType<typeof buildNfcePayload>): number {
  return Math.round(payload.formas_pagamento.reduce((sum, f) => sum + f.valor_pagamento, 0) * 100) / 100
}

describe('buildNfcePayload — reconciliação monetária (achado real, rejeição SEFAZ 866, venda 626)', () => {
  it('venda sem acréscimo/frete/desconto de pedido — primeiro item não ganha nenhum campo extra', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(payload.items[0].valor_frete).toBeUndefined()
    expect(payload.items[0].valor_outras_despesas).toBeUndefined()
    expect(payload.items[0].valor_desconto).toBeUndefined()
    expect(reconciledNfceTotal(payload)).toBe(paymentsTotal(payload))
  })

  it('venda com acréscimo (surcharge_amount) — vai pro primeiro item como valor_outras_despesas (vOutro), nunca vira troco nem é ignorado', () => {
    const ctx = nfceContext({
      saleSurchargeAmount: 10,
      saleTotal: 89.8,
      payments: [{ method: 'pix', netAmount: 89.8, cardBrand: null }],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.items[0].valor_outras_despesas).toBe(10)
    expect(payload.items[0].valor_frete).toBeUndefined()
    expect(reconciledNfceTotal(payload)).toBe(89.8)
    expect(reconciledNfceTotal(payload)).toBe(paymentsTotal(payload))
  })

  it('venda com frete (shipping_charged) — vai pro primeiro item como valor_frete (vFrete), distinto de outras despesas', () => {
    const ctx = nfceContext({
      saleShippingCharged: 8,
      saleTotal: 87.8,
      payments: [{ method: 'pix', netAmount: 87.8, cardBrand: null }],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.items[0].valor_frete).toBe(8)
    expect(payload.items[0].valor_outras_despesas).toBeUndefined()
    expect(reconciledNfceTotal(payload)).toBe(87.8)
  })

  it('venda com desconto de pedido (sales.discount_amount) — SOMA ao valor_desconto do primeiro item, nunca substitui desconto por item já existente', () => {
    const ctx = nfceContext({
      items: [{ ...nfceContext().items[0], discountAmount: 2 }],
      saleDiscountAmount: 5,
      saleTotal: 72.8, // 79.8 - 2 (item) - 5 (pedido)
      payments: [{ method: 'pix', netAmount: 72.8, cardBrand: null }],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.items[0].valor_desconto).toBe(7) // 2 (item) + 5 (pedido), nunca 5 sozinho
    expect(reconciledNfceTotal(payload)).toBe(72.8)
  })

  it('combinação desconto + acréscimo — os dois aparecem simultaneamente no primeiro item, reconciliação continua exata', () => {
    const ctx = nfceContext({
      saleDiscountAmount: 5,
      saleSurchargeAmount: 10,
      saleTotal: 84.8, // 79.8 - 5 + 10
      payments: [{ method: 'pix', netAmount: 84.8, cardBrand: null }],
    })
    const payload = buildNfcePayload(ctx)
    expect(payload.items[0].valor_desconto).toBe(5)
    expect(payload.items[0].valor_outras_despesas).toBe(10)
    expect(reconciledNfceTotal(payload)).toBe(84.8)
    expect(reconciledNfceTotal(payload)).toBe(paymentsTotal(payload))
  })

  it('PIX exato, sem troco — pagamentos batem exatamente com o total fiscal, nenhum campo de troco existe no tipo do payload (prova estática)', () => {
    const payload = buildNfcePayload(nfceContext())
    expect(paymentsTotal(payload)).toBe(reconciledNfceTotal(payload))
    // FocusNfcePayload não declara nenhum campo de troco — não há como
    // enviar um valor de troco mesmo por engano (prova estática, não em runtime).
    expect('valor_troco' in payload).toBe(false)
  })

  it('dinheiro com troco real — sale_payments.net_amount já vem líquido (amount_tendered - change_amount, invariante garantida pelo banco), então o troco NUNCA precisa ser declarado à Focus: o valor enviado já é o que a loja efetivamente ficou', () => {
    // Cenário real: cliente paga R$ 100,00 em dinheiro (amount_tendered) por
    // uma compra de R$ 79,80, recebe R$ 20,20 de troco (change_amount).
    // `sale_payments.net_amount` (79.8) é o que chega em `FiscalPaymentContext.
    // netAmount` — nunca o valor tendered bruto. O troco nunca vaza pro
    // payload fiscal, então a reconciliação bate sem nenhum campo extra.
    const ctx = nfceContext({ payments: [{ method: 'cash', netAmount: 79.8, cardBrand: null }] })
    const payload = buildNfcePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(79.8)
    expect(reconciledNfceTotal(payload)).toBe(79.8)
    expect(reconciledNfceTotal(payload)).toBe(paymentsTotal(payload))
  })

  it('garantia geral: para qualquer combinação de desconto/frete/acréscimo, total fiscal reconstituído dos itens == soma de formas_pagamento (nunca diverge, nunca precisa de troco fabricado)', () => {
    const scenarios: Array<{ saleDiscountAmount: number; saleSurchargeAmount: number; saleShippingCharged: number; total: number }> = [
      { saleDiscountAmount: 0, saleSurchargeAmount: 0, saleShippingCharged: 0, total: 79.8 },
      { saleDiscountAmount: 0, saleSurchargeAmount: 10, saleShippingCharged: 0, total: 89.8 },
      { saleDiscountAmount: 0, saleSurchargeAmount: 0, saleShippingCharged: 15, total: 94.8 },
      { saleDiscountAmount: 20, saleSurchargeAmount: 0, saleShippingCharged: 0, total: 59.8 },
      { saleDiscountAmount: 20, saleSurchargeAmount: 10, saleShippingCharged: 15, total: 84.8 },
    ]
    for (const s of scenarios) {
      const ctx = nfceContext({
        saleDiscountAmount: s.saleDiscountAmount,
        saleSurchargeAmount: s.saleSurchargeAmount,
        saleShippingCharged: s.saleShippingCharged,
        saleTotal: s.total,
        payments: [{ method: 'pix', netAmount: s.total, cardBrand: null }],
      })
      const payload = buildNfcePayload(ctx)
      expect(reconciledNfceTotal(payload)).toBe(paymentsTotal(payload))
      expect(reconciledNfceTotal(payload)).toBe(s.total)
    }
  })
})

describe('buildNfcePayload — venda 626 real (regressão específica, dados confirmados no banco: subtotal=19.99, discount_amount=0, surcharge_amount=10.00, shipping_charged=0, total=29.99, PIX)', () => {
  function venda626Context() {
    return nfceContext({
      items: [{
        saleItemId: 6260001, productId: 1, variationId: 1, description: 'Item real venda 626', sku: 'SKU-626',
        quantity: 1, unitPrice: 19.99, discountAmount: 0, unit: 'UN', ncm: '61091000', cest: null, origem: 2,
      }],
      saleDiscountAmount: 0,
      saleSurchargeAmount: 10.00,
      saleShippingCharged: 0,
      saleTotal: 29.99,
      payments: [{ method: 'pix', netAmount: 29.99, cardBrand: null }],
    })
  }

  it('produz exatamente o payload esperado: item com valor_bruto=19.99 e valor_outras_despesas=10.00, forma_pagamento PIX "20" com valor_pagamento=29.99', () => {
    const payload = buildNfcePayload(venda626Context())

    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].valor_bruto).toBe(19.99)
    expect(payload.items[0].valor_outras_despesas).toBe(10.00)
    // shipping_charged=0 e discount_amount=0 reais desta venda — nenhum
    // campo artificial deve aparecer.
    expect(payload.items[0].valor_frete).toBeUndefined()
    expect(payload.items[0].valor_desconto).toBeUndefined()

    expect(payload.formas_pagamento).toHaveLength(1)
    expect(payload.formas_pagamento[0].forma_pagamento).toBe('20')
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(29.99)

    // Nenhum grupo IPI (regressão da correção anterior, SEFAZ 742) — continua valendo aqui.
    expect((payload.items[0] as any).ipi_situacao_tributaria).toBeUndefined()
  })

  it('reconciliação exata: produtos 19.99 + outras despesas 10.00 = total fiscal 29.99 = pagamentos 29.99, troco 0.00', () => {
    const payload = buildNfcePayload(venda626Context())

    const produtos = payload.items.reduce((sum, i) => sum + i.valor_bruto, 0)
    const desconto = payload.items.reduce((sum, i) => sum + (i.valor_desconto ?? 0), 0)
    const frete = payload.items.reduce((sum, i) => sum + (i.valor_frete ?? 0), 0)
    const outrasDespesas = payload.items.reduce((sum, i) => sum + (i.valor_outras_despesas ?? 0), 0)
    const totalFiscal = Math.round((produtos - desconto + frete + outrasDespesas) * 100) / 100
    const pagamentos = payload.formas_pagamento.reduce((sum, f) => sum + f.valor_pagamento, 0)
    const troco = 0 // nenhum campo de troco existe no payload — nunca fabricado

    expect(produtos).toBe(19.99)
    expect(desconto).toBe(0)
    expect(frete).toBe(0)
    expect(outrasDespesas).toBe(10.00)
    expect(totalFiscal).toBe(29.99)
    expect(pagamentos).toBe(29.99)
    expect(pagamentos - troco).toBe(totalFiscal)
  })
})

describe('buildNfcePayload — determinismo (puro, sem I/O)', () => {
  it('mesma entrada → mesma saída (exceto data_emissao, que varia com o relógio)', () => {
    const ctx = nfceContext()
    const a = buildNfcePayload(ctx)
    const b = buildNfcePayload(ctx)
    expect({ ...a, data_emissao: null }).toEqual({ ...b, data_emissao: null })
  })
})
