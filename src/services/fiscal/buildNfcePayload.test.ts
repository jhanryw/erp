import { describe, it, expect } from 'vitest'
import { buildNfcePayload, NFCE_CFOP_INTERNO } from './buildNfcePayload'
import { FiscalBuildError } from './buildNfePayload'
import { baseFiscalContext } from './testFixtures'

/** Contexto de balcão — presencial, consumidor não identificado, sem endereço de destinatário. */
function nfceContext(overrides: Parameters<typeof baseFiscalContext>[0] = {}) {
  return baseFiscalContext({
    operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
    destinatario: {
      nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null,
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

describe('buildNfcePayload — determinismo (puro, sem I/O)', () => {
  it('mesma entrada → mesma saída (exceto data_emissao, que varia com o relógio)', () => {
    const ctx = nfceContext()
    const a = buildNfcePayload(ctx)
    const b = buildNfcePayload(ctx)
    expect({ ...a, data_emissao: null }).toEqual({ ...b, data_emissao: null })
  })
})
