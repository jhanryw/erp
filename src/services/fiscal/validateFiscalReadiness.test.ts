import { describe, it, expect } from 'vitest'
import { validateFiscalReadiness } from './validateFiscalReadiness'
import { baseFiscalContext } from './testFixtures'

describe('validateFiscalReadiness — cenário completo', () => {
  it('contexto totalmente preenchido (incl. IBGE do destinatário já resolvido) → nenhum erro', () => {
    expect(validateFiscalReadiness(baseFiscalContext())).toEqual([])
  })
})

describe('validateFiscalReadiness — estado da venda (Fase Fiscal 3A)', () => {
  it('venda cancelled → sale_status_not_emittable', () => {
    const ctx = baseFiscalContext({ saleStatus: 'cancelled' })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('sale_status_not_emittable')
  })

  it('venda returned → sale_status_not_emittable', () => {
    const ctx = baseFiscalContext({ saleStatus: 'returned' })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('sale_status_not_emittable')
  })

  it('venda paid → sem erro de status', () => {
    const ctx = baseFiscalContext({ saleStatus: 'paid' })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('sale_status_not_emittable')
  })
})

describe('validateFiscalReadiness — pagamentos (Fase Fiscal 3A)', () => {
  it('sem nenhum pagamento → payments_missing', () => {
    const ctx = baseFiscalContext({ payments: [] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('payments_missing')
  })

  it('soma dos pagamentos diferente do total da venda → payments_total_mismatch', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'pix', netAmount: 50, cardBrand: null }] }) // saleTotal do fixture é 79.8
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('payments_total_mismatch')
  })

  it('soma dos pagamentos bate com o total (dentro da tolerância de centavo) → sem erro', () => {
    const ctx = baseFiscalContext({ payments: [
      { method: 'pix', netAmount: 40, cardBrand: null },
      { method: 'cash', netAmount: 39.8, cardBrand: null },
    ] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('payments_total_mismatch')
  })

  it('método de pagamento não suportado ("card" legado) → payment_method_unsupported', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'card', netAmount: 79.8, cardBrand: null }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('payment_method_unsupported')
  })

  it('payments_missing e payments_total_mismatch nunca aparecem juntos (sem pagamento não faz sentido comparar soma)', () => {
    const ctx = baseFiscalContext({ payments: [] })
    const codes = validateFiscalReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('payments_missing')
    expect(codes).not.toContain('payments_total_mismatch')
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

  it('CRT=2 (Lucro Presumido, sem regra implementada) → emitente_crt_nao_suportado, nunca emitente_crt_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 2 } })
    const codes = validateFiscalReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('emitente_crt_nao_suportado')
    expect(codes).not.toContain('emitente_crt_missing')
  })

  it('CRT=3 (Lucro Real, sem regra implementada) → emitente_crt_nao_suportado', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 3 } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('emitente_crt_nao_suportado')
  })

  it('CRT=1 (Simples Nacional, suportado) → sem erro de CRT', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 1 } })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('emitente_crt_nao_suportado')
  })

  it('CRT=4 (MEI, suportado — fixture padrão) → sem erro de CRT', () => {
    const ctx = baseFiscalContext()
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('emitente_crt_nao_suportado')
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
  it('produto sem NCM (null) → item_ncm_missing, nunca item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: null }] })
    const codes = validateFiscalReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('item_ncm_missing')
    expect(codes).not.toContain('item_ncm_invalido')
  })

  it('produto com NCM vazio ("") → item_ncm_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_ncm_missing')
  })

  it('produto com NCM de 7 dígitos → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM de 9 dígitos → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '610822001' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM contendo letras → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220A' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM com pontuação normalizável ("6108.22.00") → SEM erro, pontuação é removida antes de contar os dígitos', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108.22.00' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_invalido')
  })

  it('produto com NCM válido de 8 dígitos (sem pontuação) → sem erro', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '61082200' }] })
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_invalido')
    expect(validateFiscalReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_missing')
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
