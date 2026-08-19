import { describe, it, expect } from 'vitest'
import { validateFiscalReadiness } from './validateFiscalReadiness'
import { baseFiscalContext } from './testFixtures'

describe('validateFiscalReadiness — cenário completo', () => {
  it('contexto totalmente preenchido (incl. IBGE do destinatário já resolvido) → nenhum erro', () => {
    expect(validateFiscalReadiness(baseFiscalContext())).toEqual([])
  })
})

describe('validateFiscalReadiness — integração Focus', () => {
  it('integração ausente → focus_integration_missing', () => {
    const ctx = baseFiscalContext({ focusIntegration: { available: false, reason: 'integration_not_found' } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('focus_integration_missing')
  })

  it('token ausente → focus_token_missing', () => {
    const ctx = baseFiscalContext({ focusIntegration: { available: false, reason: 'token_missing' } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('focus_token_missing')
  })
})

describe('validateFiscalReadiness — cadastro fiscal incompleto (emitente)', () => {
  it('empresa sem IE → emitente_ie_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, inscricaoEstadual: null } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('emitente_ie_missing')
  })

  it('empresa sem CNPJ → emitente_cnpj_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, cnpj: null } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('emitente_cnpj_missing')
  })
})

describe('validateFiscalReadiness — destinatário', () => {
  it('sem CPF/CNPJ → destinatario_documento_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cpf: null, cnpj: null } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('destinatario_documento_missing')
  })

  it('endereço incompleto (sem bairro) → destinatario_endereco_incompleto', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, bairro: null } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('destinatario_endereco_incompleto')
  })

  it('CEP com formato inválido → destinatario_cep_invalido', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cep: '123' } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('destinatario_cep_invalido')
  })

  it('UF com formato inválido → destinatario_uf_invalida', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, uf: 'XYZ' } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('destinatario_uf_invalida')
  })

  it('resolução de IBGE falhou (rede indisponível ou sem correspondência) → destinatario_municipio_ibge_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, municipioIbge: null } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('destinatario_municipio_ibge_missing')
  })
})

describe('validateFiscalReadiness — itens', () => {
  it('produto sem NCM → item_ncm_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: null }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_ncm_missing')
  })

  it('produto sem origem → item_origem_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], origem: null }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_origem_missing')
  })

  it('produto sem unidade → item_unidade_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], unit: null }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_unidade_missing')
  })

  it('venda sem itens → items_empty', () => {
    const ctx = baseFiscalContext({ items: [] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('items_empty')
  })

  it('nunca lança — mesmo com contexto totalmente vazio, devolve lista de erros', () => {
    const ctx = baseFiscalContext({
      emitente: { cnpj: null, razaoSocial: null, inscricaoEstadual: null, crt: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      destinatario: { nome: null, isAnonymous: false, cpf: null, cnpj: null, inscricaoEstadual: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      items: [],
      focusIntegration: { available: false, reason: 'integration_not_found' },
    })
    expect(() => validateFiscalReadiness(ctx)).not.toThrow()
    expect(validateFiscalReadiness(ctx).length).toBeGreaterThan(5)
  })
})
