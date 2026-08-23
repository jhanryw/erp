import { describe, it, expect } from 'vitest'
import { buildNfePayload, FiscalBuildError } from './buildNfePayload'
import { FiscalRuleNotImplementedError } from '@/lib/fiscal/taxRules'
import { baseFiscalContext } from './testFixtures'

describe('buildNfePayload — cenário base (MEI, RN → SP, consumidor final)', () => {
  it('monta CFOP correto (6102, não 6108 — MEI interestadual)', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.items[0].cfop).toBe('6102')
  })

  it('CSOSN 102 no item', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.items[0].icms_situacao_tributaria).toBe('102')
  })

  it('regime_tributario_emitente espelha o CRT do emitente (4, MEI) — nunca hardcoded', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.regime_tributario_emitente).toBe(4)
  })

  it('local_destino = 2 (interestadual) pra RN → SP', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.local_destino).toBe(2)
  })

  it('nenhum segredo (token) aparece em nenhum lugar do payload serializado', () => {
    const payload = buildNfePayload(baseFiscalContext())
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toMatch(/token|senha|password|secret/i)
  })

  it('destinatário pessoa física: cpf_destinatario preenchido, cnpj_destinatario ausente, indicador_ie = 9 (não contribuinte)', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.cpf_destinatario).toBe('11144477735')
    expect(payload.cnpj_destinatario).toBeUndefined()
    expect(payload.indicador_inscricao_estadual_destinatario).toBe(9)
  })
})

describe('buildNfePayload — venda RN → RN (mesmo estado)', () => {
  it('CFOP 5102 tanto pra MEI quanto pra Simples Nacional normal', () => {
    const ctxMei = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, uf: 'RN' } })
    expect(buildNfePayload(ctxMei).items[0].cfop).toBe('5102')
    expect(buildNfePayload(ctxMei).local_destino).toBe(1)

    const ctxSimples = baseFiscalContext({
      emitente: { ...baseFiscalContext().emitente, crt: 1 },
      destinatario: { ...baseFiscalContext().destinatario, uf: 'RN' },
    })
    expect(buildNfePayload(ctxSimples).items[0].cfop).toBe('5102')
  })
})

describe('buildNfePayload — futuro: transição MEI → Simples Nacional (CRT 1)', () => {
  it('mesma venda interestadual, só mudando crt: 4→1, muda CFOP pra 6108 (regra não-MEI) — nenhuma outra alteração de código necessária', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 1 } })
    const payload = buildNfePayload(ctx)
    expect(payload.items[0].cfop).toBe('6108')
    expect(payload.regime_tributario_emitente).toBe(1)
  })
})

describe('buildNfePayload — origem da mercadoria', () => {
  it('origem 0 (nacional) é repassada sem alteração', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], origem: 0 }] })
    expect(buildNfePayload(ctx).items[0].icms_origem).toBe(0)
  })

  it('origem 2 (estrangeira, mercado interno) é repassada sem alteração', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], origem: 2 }] })
    expect(buildNfePayload(ctx).items[0].icms_origem).toBe(2)
  })
})

describe('buildNfePayload — GTIN e valores calculados', () => {
  it('sem GTIN modelado no ERP → codigo_barras_comercial = "SEM GTIN" sempre', () => {
    expect(buildNfePayload(baseFiscalContext()).items[0].codigo_barras_comercial).toBe('SEM GTIN')
  })

  it('valor_bruto = valor_unitario_comercial × quantidade_comercial (invariante exigido pela Focus)', () => {
    const payload = buildNfePayload(baseFiscalContext())
    const item = payload.items[0]
    expect(item.valor_bruto).toBeCloseTo(item.valor_unitario_comercial * item.quantidade_comercial, 2)
  })

  it('desconto zero não aparece no payload (omitido, não enviado como 0)', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.items[0].valor_desconto).toBeUndefined()
  })

  it('desconto > 0 aparece explicitamente', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], discountAmount: 5 }] })
    expect(buildNfePayload(ctx).items[0].valor_desconto).toBe(5)
  })
})

describe('buildNfePayload — campos obrigatórios ausentes lançam FiscalBuildError (nunca monta payload incompleto silenciosamente)', () => {
  it('NCM ausente no item → lança', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: null }] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
    expect(() => buildNfePayload(ctx)).toThrow(/ncm/i)
  })

  it('origem ausente no item → lança', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], origem: null }] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('endereço do destinatário incompleto (sem logradouro) → lança', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, logradouro: null } })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('emitente sem CRT → lança (CFOP/CSOSN dependem do CRT, não há como montar)', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: null } })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('venda sem itens → lança', () => {
    const ctx = baseFiscalContext({ items: [] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('destinatário sem CPF nem CNPJ → lança', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cpf: null, cnpj: null } })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })

  it('venda sem pagamentos → lança (Fase Fiscal 3A)', () => {
    const ctx = baseFiscalContext({ payments: [] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
    expect(() => buildNfePayload(ctx)).toThrow(/pagamento/i)
  })

  it('NCM malformado (7 dígitos) → lança, mesma defesa própria do builder que NCM ausente (independe de validateFiscalReadiness ter rodado antes)', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220' }] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
    expect(() => buildNfePayload(ctx)).toThrow(/ncm/i)
  })

  it('NCM com letras → lança', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220A' }] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
  })
})

describe('buildNfePayload — NCM normalizado (fechamento de blocker de readiness)', () => {
  it('NCM com pontuação legada ("6108.22.00") → payload envia SEM pontuação ("61082200"), nunca a string bruta', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108.22.00' }] })
    const payload = buildNfePayload(ctx)
    expect(payload.items[0].codigo_ncm).toBe('61082200')
  })

  it('NCM já limpo (8 dígitos) → payload envia exatamente o mesmo valor', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '61082200' }] })
    const payload = buildNfePayload(ctx)
    expect(payload.items[0].codigo_ncm).toBe('61082200')
  })
})

describe('buildNfePayload — formas_pagamento (Fase Fiscal 3A)', () => {
  it('pagamento único em PIX → forma_pagamento="20", indicador_pagamento="0", sem bandeira_operadora', () => {
    const payload = buildNfePayload(baseFiscalContext())
    expect(payload.formas_pagamento).toEqual([
      { forma_pagamento: '20', valor_pagamento: 79.8, indicador_pagamento: '0' },
    ])
  })

  it('pagamento em cartão com bandeira reconhecida → inclui bandeira_operadora', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'credit_card', netAmount: 79.8, cardBrand: 'visa' }] })
    expect(buildNfePayload(ctx).formas_pagamento).toEqual([
      { forma_pagamento: '03', valor_pagamento: 79.8, indicador_pagamento: '0', bandeira_operadora: '01' },
    ])
  })

  it('pagamento em cartão sem bandeira cadastrada → omite bandeira_operadora, nunca inventa', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'debit_card', netAmount: 79.8, cardBrand: null }] })
    const forma = buildNfePayload(ctx).formas_pagamento[0] as any
    expect(forma.bandeira_operadora).toBeUndefined()
  })

  it('múltiplos pagamentos (split) → uma entrada por pagamento, cada um com seu próprio valor', () => {
    const ctx = baseFiscalContext({ payments: [
      { method: 'pix', netAmount: 40, cardBrand: null },
      { method: 'cash', netAmount: 39.8, cardBrand: null },
    ] })
    const formas = buildNfePayload(ctx).formas_pagamento
    expect(formas).toHaveLength(2)
    expect(formas[0].forma_pagamento).toBe('20')
    expect(formas[1].forma_pagamento).toBe('01')
  })

  it('método de pagamento "card" (legado) → lança FiscalRuleNotImplementedError, propagada (não engolida)', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'card', netAmount: 79.8, cardBrand: null }] })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalRuleNotImplementedError)
  })

  it('nunca inclui campos de credenciadora/integração/parcelas — nenhum dado fiscal confiável pra isso nesta fase', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'credit_card', netAmount: 79.8, cardBrand: 'visa' }] })
    const forma = buildNfePayload(ctx).formas_pagamento[0] as any
    expect(forma.tipo_integracao).toBeUndefined()
    expect(forma.cnpj_credenciadora).toBeUndefined()
    expect(forma.numero_autorizacao).toBeUndefined()
    expect(forma.cnpj_beneficiario).toBeUndefined()
    expect(forma.id_terminal_pagamento).toBeUndefined()
    expect(forma.parcelas).toBeUndefined()
    expect(forma.installments).toBeUndefined()
  })
})

describe('buildNfePayload — troco real (Fase Fiscal 4I, hardening pré-produção)', () => {
  it('amountTendered/changeAmount ausentes (compatibilidade) → valor_pagamento cai pra netAmount, nenhum valor_troco', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'pix', netAmount: 79.8, cardBrand: null }] })
    const payload = buildNfePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(79.8)
    expect(payload.valor_troco).toBeUndefined()
  })

  it('dinheiro com troco real (total=80, entregue=100, troco=20) → valor_pagamento=100 (tendered), valor_troco=20 no documento', () => {
    const ctx = baseFiscalContext({
      items: [{ ...baseFiscalContext().items[0], unitPrice: 40, quantity: 2, discountAmount: 0 }], // 80 total
      payments: [{ method: 'cash', netAmount: 80, cardBrand: null, amountTendered: 100, changeAmount: 20 }],
    })
    const payload = buildNfePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(100)
    expect(payload.valor_troco).toBe(20)
  })

  it('PIX (sem troco) + dinheiro com troco → valor_troco reflete só o troco real, PIX usa seu próprio valor exato', () => {
    const ctx = baseFiscalContext({
      items: [{ ...baseFiscalContext().items[0], unitPrice: 100, quantity: 1 }],
      payments: [
        { method: 'pix', netAmount: 60, cardBrand: null, amountTendered: 60, changeAmount: 0 },
        { method: 'cash', netAmount: 40, cardBrand: null, amountTendered: 50, changeAmount: 10 },
      ],
    })
    const payload = buildNfePayload(ctx)
    expect(payload.formas_pagamento[0].valor_pagamento).toBe(60)
    expect(payload.formas_pagamento[1].valor_pagamento).toBe(50)
    expect(payload.valor_troco).toBe(10)
  })
})

describe('buildNfePayload — PIS/COFINS sempre explicitamente zerados (Fase 2B, confirmado por XML real — NUNCA omitidos)', () => {
  it('pis_base_calculo/pis_aliquota_porcentual/pis_valor presentes e iguais a 0', () => {
    const item = buildNfePayload(baseFiscalContext()).items[0]
    expect(item.pis_base_calculo).toBe(0)
    expect(item.pis_aliquota_porcentual).toBe(0)
    expect(item.pis_valor).toBe(0)
  })

  it('cofins_base_calculo/cofins_aliquota_porcentual/cofins_valor presentes e iguais a 0', () => {
    const item = buildNfePayload(baseFiscalContext()).items[0]
    expect(item.cofins_base_calculo).toBe(0)
    expect(item.cofins_aliquota_porcentual).toBe(0)
    expect(item.cofins_valor).toBe(0)
  })

  it('IPI continua sem sub-campos de valor (grupo IPINT não tributado não tem vBC/pIPI/vIPI no XML nacional)', () => {
    const item = buildNfePayload(baseFiscalContext()).items[0] as any
    expect(item.ipi_base_calculo).toBeUndefined()
    expect(item.ipi_aliquota).toBeUndefined()
    expect(item.ipi_valor).toBeUndefined()
  })
})

describe('buildNfePayload — IBS/CBS (reforma tributária, obrigatório desde 01/2026, Fase 2B)', () => {
  it('todo item carrega os campos de IBS/CBS do ano-teste 2026', () => {
    const item = buildNfePayload(baseFiscalContext()).items[0]
    expect(item.ibs_cbs_situacao_tributaria).toBe('000')
    expect(item.ibs_cbs_classificacao_tributaria).toBe('000001')
    expect(item.ibs_cbs_base_calculo).toBe(0)
    expect(item.ibs_uf_aliquota).toBe(0.1)
    expect(item.ibs_mun_aliquota).toBe(0)
    expect(item.cbs_aliquota).toBe(0.9)
  })

  it('IBS/CBS não varia entre MEI (CRT 4) e Simples Nacional normal (CRT 1) — reforma se aplica uniformemente', () => {
    const itemMei = buildNfePayload(baseFiscalContext()).items[0]
    const itemSimples = buildNfePayload(baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 1 } })).items[0]
    expect(itemMei.ibs_cbs_classificacao_tributaria).toBe(itemSimples.ibs_cbs_classificacao_tributaria)
    expect(itemMei.cbs_aliquota).toBe(itemSimples.cbs_aliquota)
  })
})

describe('buildNfePayload — indFinal/indIntermed (Fase 2B, confirmado por XML real)', () => {
  it('consumidor_final = 1 no cenário padrão (varejo direto ao consumidor)', () => {
    expect(buildNfePayload(baseFiscalContext()).consumidor_final).toBe(1)
  })

  it('indicador_intermediario = 0 no cenário padrão (loja própria, sem marketplace)', () => {
    expect(buildNfePayload(baseFiscalContext()).indicador_intermediario).toBe(0)
  })
})

describe('buildNfePayload — código IBGE do destinatário (Fase 2B, seção 5 do pedido: nunca emitir sem resolver)', () => {
  it('municipioIbge ausente → lança FiscalBuildError, nunca monta payload sem o código', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, municipioIbge: null } })
    expect(() => buildNfePayload(ctx)).toThrow(FiscalBuildError)
    expect(() => buildNfePayload(ctx)).toThrow(/municipioIbge/)
  })

  it('municipioIbge presente → codigo_municipio_destinatario no payload', () => {
    expect(buildNfePayload(baseFiscalContext()).codigo_municipio_destinatario).toBe('3550308')
  })
})

describe('buildNfePayload — indicador_inscricao_estadual_destinatario (arquitetura pronta pra PJ, seção 14 do pedido)', () => {
  it('destinatário PF (cenário atual, único suportado) → 9 (não contribuinte)', () => {
    expect(buildNfePayload(baseFiscalContext()).indicador_inscricao_estadual_destinatario).toBe(9)
  })

  it('hipotético CNPJ + IE preenchidos → 1 (contribuinte) — builder não trava em PF', () => {
    const ctx = baseFiscalContext({
      destinatario: { ...baseFiscalContext().destinatario, cpf: null, cnpj: '11222333000181', inscricaoEstadual: '123456789' },
    })
    expect(buildNfePayload(ctx).indicador_inscricao_estadual_destinatario).toBe(1)
    expect(buildNfePayload(ctx).cnpj_destinatario).toBe('11222333000181')
    expect(buildNfePayload(ctx).inscricao_estadual_destinatario).toBe('123456789')
  })

  it('hipotético CNPJ sem IE → 2 (isento)', () => {
    const ctx = baseFiscalContext({
      destinatario: { ...baseFiscalContext().destinatario, cpf: null, cnpj: '11222333000181', inscricaoEstadual: null },
    })
    expect(buildNfePayload(ctx).indicador_inscricao_estadual_destinatario).toBe(2)
  })
})

describe('buildNfePayload — IBS/CBS valores calculados sempre explícitos (nunca omitidos)', () => {
  it('ibs_uf_valor/ibs_mun_valor/ibs_valor_total/cbs_valor sempre presentes e iguais a 0 no ano-teste', () => {
    const item = buildNfePayload(baseFiscalContext()).items[0]
    expect(item.ibs_uf_valor).toBe(0)
    expect(item.ibs_mun_valor).toBe(0)
    expect(item.ibs_valor_total).toBe(0)
    expect(item.cbs_valor).toBe(0)
  })
})

describe('buildNfePayload — determinismo (puro, sem I/O)', () => {
  it('mesma entrada produz payload idêntico (serializado)', () => {
    const ctx = baseFiscalContext()
    expect(JSON.stringify(buildNfePayload(ctx))).toBe(JSON.stringify(buildNfePayload(ctx)))
  })
})
