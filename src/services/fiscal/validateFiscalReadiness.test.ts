import { describe, it, expect } from 'vitest'
import { validateNfeReadiness, validateNfceReadiness } from './validateFiscalReadiness'
import { baseFiscalContext } from './testFixtures'

describe('validateNfeReadiness — cenário completo', () => {
  it('contexto totalmente preenchido (incl. IBGE do destinatário já resolvido) → nenhum erro', () => {
    expect(validateNfeReadiness(baseFiscalContext())).toEqual([])
  })
})

describe('validateNfeReadiness — estado da venda (Fase Fiscal 3A)', () => {
  it('venda cancelled → sale_status_not_emittable', () => {
    const ctx = baseFiscalContext({ saleStatus: 'cancelled' })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('sale_status_not_emittable')
  })

  it('venda returned → sale_status_not_emittable', () => {
    const ctx = baseFiscalContext({ saleStatus: 'returned' })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('sale_status_not_emittable')
  })

  it('venda paid → sem erro de status', () => {
    const ctx = baseFiscalContext({ saleStatus: 'paid' })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('sale_status_not_emittable')
  })
})

describe('validateNfeReadiness — pagamentos (Fase Fiscal 3A)', () => {
  it('sem nenhum pagamento → payments_missing', () => {
    const ctx = baseFiscalContext({ payments: [] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('payments_missing')
  })

  it('soma dos pagamentos diferente do total da venda → payments_total_mismatch', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'pix', netAmount: 50, cardBrand: null }] }) // saleTotal do fixture é 79.8
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('payments_total_mismatch')
  })

  it('soma dos pagamentos bate com o total (dentro da tolerância de centavo) → sem erro', () => {
    const ctx = baseFiscalContext({ payments: [
      { method: 'pix', netAmount: 40, cardBrand: null },
      { method: 'cash', netAmount: 39.8, cardBrand: null },
    ] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('payments_total_mismatch')
  })

  it('método de pagamento não suportado ("card" legado) → payment_method_unsupported', () => {
    const ctx = baseFiscalContext({ payments: [{ method: 'card', netAmount: 79.8, cardBrand: null }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('payment_method_unsupported')
  })

  it('payments_missing e payments_total_mismatch nunca aparecem juntos (sem pagamento não faz sentido comparar soma)', () => {
    const ctx = baseFiscalContext({ payments: [] })
    const codes = validateNfeReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('payments_missing')
    expect(codes).not.toContain('payments_total_mismatch')
  })
})

describe('validateNfeReadiness — integração Focus', () => {
  it('integração ausente → focus_integration_missing', () => {
    const ctx = baseFiscalContext({ focusIntegration: { available: false, reason: 'integration_not_found' } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('focus_integration_missing')
  })

  it('token ausente → focus_token_missing', () => {
    const ctx = baseFiscalContext({ focusIntegration: { available: false, reason: 'token_missing' } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('focus_token_missing')
  })
})

describe('validateNfeReadiness — cadastro fiscal incompleto (emitente)', () => {
  it('empresa sem IE → emitente_ie_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, inscricaoEstadual: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('emitente_ie_missing')
  })

  it('empresa sem CNPJ → emitente_cnpj_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, cnpj: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('emitente_cnpj_missing')
  })

  it('CRT=2 (Lucro Presumido, sem regra implementada) → emitente_crt_nao_suportado, nunca emitente_crt_missing', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 2 } })
    const codes = validateNfeReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('emitente_crt_nao_suportado')
    expect(codes).not.toContain('emitente_crt_missing')
  })

  it('CRT=3 (Lucro Real, sem regra implementada) → emitente_crt_nao_suportado', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 3 } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('emitente_crt_nao_suportado')
  })

  it('CRT=1 (Simples Nacional, suportado) → sem erro de CRT', () => {
    const ctx = baseFiscalContext({ emitente: { ...baseFiscalContext().emitente, crt: 1 } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('emitente_crt_nao_suportado')
  })

  it('CRT=4 (MEI, suportado — fixture padrão) → sem erro de CRT', () => {
    const ctx = baseFiscalContext()
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('emitente_crt_nao_suportado')
  })
})

describe('validateNfeReadiness — destinatário', () => {
  it('sem CPF/CNPJ → destinatario_documento_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cpf: null, cnpj: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_documento_missing')
  })

  it('endereço incompleto (sem bairro) → destinatario_bairro_missing, campo específico (Fase Fiscal 5C)', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, bairro: null } })
    const codes = validateNfeReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('destinatario_bairro_missing')
    expect(codes).not.toContain('destinatario_logradouro_missing')
    expect(codes).not.toContain('destinatario_numero_missing')
  })

  it('sem CEP → destinatario_cep_missing (distinto de CEP presente mas com formato inválido)', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cep: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_cep_missing')
  })

  it('sem logradouro → destinatario_logradouro_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, logradouro: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_logradouro_missing')
  })

  it('sem número → destinatario_numero_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, numero: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_numero_missing')
  })

  it('sem município → destinatario_municipio_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, municipio: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_municipio_missing')
  })

  it('sem UF → destinatario_uf_missing (distinto de UF presente mas com formato inválido)', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, uf: null } })
    const codes = validateNfeReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('destinatario_uf_missing')
    expect(codes).not.toContain('destinatario_uf_invalida')
  })

  it('CEP com formato inválido → destinatario_cep_invalido', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, cep: '123' } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_cep_invalido')
  })

  it('UF com formato inválido → destinatario_uf_invalida', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, uf: 'XYZ' } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_uf_invalida')
  })

  it('resolução de IBGE falhou (rede indisponível ou sem correspondência) → destinatario_municipio_ibge_missing', () => {
    const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, municipioIbge: null } })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('destinatario_municipio_ibge_missing')
  })
})

describe('validateNfeReadiness — itens', () => {
  it('produto sem NCM (null) → item_ncm_missing, nunca item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: null }] })
    const codes = validateNfeReadiness(ctx).map((e) => e.code)
    expect(codes).toContain('item_ncm_missing')
    expect(codes).not.toContain('item_ncm_invalido')
  })

  it('produto com NCM vazio ("") → item_ncm_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_ncm_missing')
  })

  it('produto com NCM de 7 dígitos → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM de 9 dígitos → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '610822001' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM contendo letras → item_ncm_invalido', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108220A' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_ncm_invalido')
  })

  it('produto com NCM com pontuação normalizável ("6108.22.00") → SEM erro, pontuação é removida antes de contar os dígitos', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '6108.22.00' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_invalido')
  })

  it('produto com NCM válido de 8 dígitos (sem pontuação) → sem erro', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], ncm: '61082200' }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_invalido')
    expect(validateNfeReadiness(ctx).map((e) => e.code)).not.toContain('item_ncm_missing')
  })

  it('produto sem origem → item_origem_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], origem: null }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_origem_missing')
  })

  it('produto sem unidade → item_unidade_missing', () => {
    const ctx = baseFiscalContext({ items: [{ ...baseFiscalContext().items[0], unit: null }] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('item_unidade_missing')
  })

  it('venda sem itens → items_empty', () => {
    const ctx = baseFiscalContext({ items: [] })
    expect(validateNfeReadiness(ctx).map((e) => e.code)).toContain('items_empty')
  })

  it('nunca lança — mesmo com contexto totalmente vazio, devolve lista de erros', () => {
    const ctx = baseFiscalContext({
      emitente: { cnpj: null, razaoSocial: null, inscricaoEstadual: null, crt: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      destinatario: { nome: null, isAnonymous: false, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      items: [],
      focusIntegration: { available: false, reason: 'integration_not_found' },
    })
    expect(() => validateNfeReadiness(ctx)).not.toThrow()
    expect(validateNfeReadiness(ctx).length).toBeGreaterThan(5)
  })
})

describe('validateNfceReadiness — destinatário nunca exige nome/endereço/IBGE (Fase Fiscal 4)', () => {
  it('consumidor totalmente não identificado (sem nome, sem CPF, sem endereço) → nenhum erro de destinatário', () => {
    const ctx = baseFiscalContext({
      destinatario: { nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
    })
    const codes = validateNfceReadiness(ctx).map((e) => e.code)
    expect(codes).not.toContain('destinatario_nome_missing')
    expect(codes).not.toContain('destinatario_documento_missing')
    expect(codes).not.toContain('destinatario_cep_missing')
    expect(codes).not.toContain('destinatario_logradouro_missing')
    expect(codes).not.toContain('destinatario_municipio_ibge_missing')
    expect(codes).not.toContain('destinatario_cpf_invalido')
  })

  it('CPF válido informado (cliente pediu nota com CPF) → nenhum erro', () => {
    const ctx = baseFiscalContext({
      destinatario: { ...baseFiscalContext().destinatario, cpf: '11144477735', logradouro: null, numero: null, bairro: null, municipio: null, municipioIbge: null },
    })
    expect(validateNfceReadiness(ctx).map((e) => e.code)).not.toContain('destinatario_cpf_invalido')
  })

  it('CPF com formato/dígito verificador inválido → destinatario_cpf_invalido', () => {
    const ctx = baseFiscalContext({
      destinatario: { ...baseFiscalContext().destinatario, cpf: '11111111111' },
    })
    expect(validateNfceReadiness(ctx).map((e) => e.code)).toContain('destinatario_cpf_invalido')
  })

  it('mesmo contexto: validateNfeReadiness bloqueia por endereço/IBGE ausente, validateNfceReadiness não', () => {
    const ctx = baseFiscalContext({
      destinatario: { nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
    })
    expect(validateNfeReadiness(ctx).length).toBeGreaterThan(0)
    expect(validateNfceReadiness(ctx)).toEqual([])
  })

  it('regras comuns (NCM/origem/unidade/pagamento/emitente) continuam bloqueando igual à NF-e', () => {
    const ctx = baseFiscalContext({
      items: [{ ...baseFiscalContext().items[0], ncm: null }],
      destinatario: { nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
    })
    expect(validateNfceReadiness(ctx).map((e) => e.code)).toContain('item_ncm_missing')
  })

  it('nunca lança, mesmo com contexto totalmente vazio', () => {
    const ctx = baseFiscalContext({
      emitente: { cnpj: null, razaoSocial: null, inscricaoEstadual: null, crt: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      destinatario: { nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null, email: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null },
      items: [],
      focusIntegration: { available: false, reason: 'integration_not_found' },
    })
    expect(() => validateNfceReadiness(ctx)).not.toThrow()
  })
})

describe('compatibilidade com a UI (card fiscal) — múltiplas pendências, mensagens legíveis', () => {
  // O card fiscal (src/app/(dashboard)/vendas/[id]/_components/documento-
  // fiscal-card.tsx:169) renderiza `{e.message}` para cada erro — o `code`
  // só é usado como `key` do React, NUNCA mostrado na tela. Este bloco
  // prova, no nível de dado (sem precisar de infraestrutura de teste de
  // componente React, inexistente neste repo), que TODO erro devolvido por
  // validateNfeReadiness tem uma mensagem humana e legível — nunca o
  // código bruto reaparecendo como texto, e a resposta HTTP real de
  // POST /api/fiscal/nfe/preview repassa esse array sem alterar
  // (src/app/api/fiscal/nfe/preview/route.ts:101, `validationErrors,`).
  it('venda com MÚLTIPLAS pendências simultâneas (destinatário incompleto de vários campos) → cada erro tem mensagem legível, nunca igual ao código', () => {
    const ctx = baseFiscalContext({
      destinatario: {
        nome: null, isAnonymous: false, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null,
        telefone: null, email: null,
        logradouro: null, numero: null, complemento: null, bairro: null,
        municipio: null, municipioIbge: null, uf: null, cep: null,
      },
    })
    const errors = validateNfeReadiness(ctx)

    // Múltiplas pendências de verdade — não um caso degenerado de 1 erro só.
    expect(errors.length).toBeGreaterThanOrEqual(8)

    const codes = errors.map((e) => e.code)
    expect(codes).toEqual(expect.arrayContaining([
      'destinatario_nome_missing',
      'destinatario_documento_missing',
      'destinatario_cep_missing',
      'destinatario_logradouro_missing',
      'destinatario_numero_missing',
      'destinatario_bairro_missing',
      'destinatario_municipio_missing',
      'destinatario_uf_missing',
      'destinatario_municipio_ibge_missing',
    ]))

    for (const e of errors) {
      // Nunca vazio.
      expect(e.message.trim().length).toBeGreaterThan(0)
      // Nunca o código bruto reaparecendo como mensagem (ex.: um bug que
      // esquecesse de escrever a mensagem e usasse err(code, code)).
      expect(e.message).not.toBe(e.code)
      // Nunca snake_case puro disfarçado de mensagem (heurística: uma
      // mensagem humana em PT-BR sempre tem pelo menos um espaço).
      expect(e.message).toMatch(/\s/)
      // Sempre termina com pontuação de frase — sinal de frase completa,
      // não de um identificador técnico colado.
      expect(e.message.trim()).toMatch(/[.!?]$/)
    }
  })

  it('cada código granular novo (Fase Fiscal 5C) aponta pro campo certo e descreve o campo certo na mensagem', () => {
    const cases: { field: 'cep' | 'logradouro' | 'numero' | 'bairro' | 'municipio' | 'uf', code: string, mustMention: string }[] = [
      { field: 'cep', code: 'destinatario_cep_missing', mustMention: 'CEP' },
      { field: 'logradouro', code: 'destinatario_logradouro_missing', mustMention: 'Logradouro' },
      { field: 'numero', code: 'destinatario_numero_missing', mustMention: 'Número' },
      { field: 'bairro', code: 'destinatario_bairro_missing', mustMention: 'Bairro' },
      { field: 'municipio', code: 'destinatario_municipio_missing', mustMention: 'Município' },
      { field: 'uf', code: 'destinatario_uf_missing', mustMention: 'UF' },
    ]

    for (const { field, code, mustMention } of cases) {
      const ctx = baseFiscalContext({ destinatario: { ...baseFiscalContext().destinatario, [field]: null } })
      const found = validateNfeReadiness(ctx).find((e) => e.code === code)
      expect(found, `esperava o código ${code} quando ${field} está ausente`).toBeDefined()
      expect(found!.message).toContain(mustMention)
      expect(found!.field).toBe(`destinatario.${field}`)
    }
  })
})
