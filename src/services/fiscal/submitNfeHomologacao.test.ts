import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { submitNfeHomologacao, buildProviderRef, consultAndUpdateFiscalDocument } from './submitNfeHomologacao'
import * as resolveModule from './resolveFocusIntegration'
import * as loadModule from './loadSaleFiscalContext'
import * as validateModule from './validateFiscalReadiness'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { FocusApiError } from '@/lib/integrations/focus/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, mockCreateAdminClient } from './testFakeAdminClient'
import { baseFiscalContext } from './testFixtures'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 555

function setupFake(overrides: { fiscalSettings?: Record<string, any> | null } = {}) {
  const fake = createFakeAdmin({
    company_fiscal_settings: [
      overrides.fiscalSettings === null
        ? undefined
        : { id: 1, company_id: COMPANY_ID, nfe_environment: 'homologacao', nfe_enabled: true, ...overrides.fiscalSettings },
    ].filter(Boolean) as any[],
  })
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))
  return fake
}

function mockHappyPathDependencies() {
  vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
    ok: true,
    data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'token-jamais-deveria-vazar', environment: 'homologacao' } },
  })
  vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID }))
  vi.spyOn(validateModule, 'validateNfeReadiness').mockReturnValue([])
}

describe('submitNfeHomologacao — gate de ambiente (aberto pra produção, decisão definitiva do usuário — mesma arquitetura de NFC-e)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('nfe_environment=producao + integração resolvida também producao → PROSSEGUE (nunca mais 403 só por ser produção)', async () => {
    setupFake({ fiscalSettings: { nfe_environment: 'producao' } })
    const contextSpy = vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID }))
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'token-producao-jamais-deveria-vazar', environment: 'producao' } },
    })
    vi.spyOn(validateModule, 'validateNfeReadiness').mockReturnValue([])
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'autorizado', chave_nfe: '9'.repeat(44), numero: '1', serie: '1', protocolo_nota_fiscal: { numero_protocolo: '111111111111111', status: '100' } } as any)

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('authorized')
    expect(issueSpy).toHaveBeenCalledWith('qarvon-1-555-nfe-producao', expect.anything(), { token: 'token-producao-jamais-deveria-vazar', environment: 'producao' })
    // environment REAL propagado pro snapshot fiscal — nunca mais o literal 'homologacao' hardcoded.
    expect(contextSpy).toHaveBeenCalledWith(expect.objectContaining({ environment: 'producao' }))
  })

  it('nfe_environment=producao MAS a integração resolvida ainda aponta pra homologação (divergência) → 403, nunca chama Focus (nunca emite com ambientes cruzados)', async () => {
    setupFake({ fiscalSettings: { nfe_environment: 'producao' } })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('nfe_environment=homologacao MAS a integração resolvida aponta pra produção (divergência inversa) → 403, nunca chama Focus', async () => {
    setupFake() // default: nfe_environment='homologacao'
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'producao' } },
    })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('nfe_environment com valor fora do enum conhecido (defensivo, nunca deveria acontecer — CHECK constraint) → 403, nunca chama Focus', async () => {
    setupFake({ fiscalSettings: { nfe_environment: 'sandbox' } })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('company_fiscal_settings ausente → falha, nunca chama Focus', async () => {
    setupFake({ fiscalSettings: null })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('nfe_enabled=false → falha, nunca chama Focus', async () => {
    setupFake({ fiscalSettings: { nfe_enabled: false } })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    expect(issueSpy).not.toHaveBeenCalled()
  })
})

describe('submitNfeHomologacao — integração/token ausentes', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('integração Focus não encontrada → falha, sem tentar montar payload', async () => {
    setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'integration_not_found' } })
    const loadSpy = vi.spyOn(loadModule, 'loadSaleFiscalContext')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    expect(loadSpy).not.toHaveBeenCalled()
  })

  it('token ausente → falha', async () => {
    setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'token_missing' } })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
  })
})

describe('submitNfeHomologacao — validação bloqueia emissão', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('erros de validação → status validation_failed, nunca chama Focus', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(validateModule, 'validateNfeReadiness').mockReturnValue([{ code: 'item_ncm_missing', message: 'Produto sem NCM.' }])
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('validation_failed')
      expect(result.data.validationErrors).toHaveLength(1)
    }
    expect(issueSpy).not.toHaveBeenCalled()
  })
})

describe('submitNfeHomologacao — blockers de readiness fechados (NCM/CRT) bloqueiam ANTES de rpc_begin_fiscal_transmission e de POST /v2/nfe', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('NCM malformado (validateFiscalReadiness REAL, não mockada) → validation_failed, ZERO POST, submission_started_at NUNCA gravado', async () => {
    const fake = setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(
      baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID, items: [{ ...baseFiscalContext().items[0], ncm: '6108220A' }] }),
    )
    // validateFiscalReadiness NÃO mockada aqui — roda a implementação real.
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('validation_failed')
      expect(result.data.validationErrors.map((e) => e.code)).toContain('item_ncm_invalido')
    }
    expect(issueSpy).not.toHaveBeenCalled()

    const row = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
    expect(row?.submission_started_at).toBeFalsy() // rpc_begin_fiscal_transmission nunca foi alcançada
  })

  it('CRT não suportado (validateFiscalReadiness REAL) → validation_failed, ZERO POST, submission_started_at NUNCA gravado', async () => {
    const fake = setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(
      baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID, emitente: { ...baseFiscalContext().emitente, crt: 2 } }),
    )
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('validation_failed')
      expect(result.data.validationErrors.map((e) => e.code)).toContain('emitente_crt_nao_suportado')
    }
    expect(issueSpy).not.toHaveBeenCalled()

    const row = fake.tables.fiscal_documents.find((r) => r.sale_id === SALE_ID)
    expect(row?.submission_started_at).toBeFalsy()
  })
})

describe('submitNfeHomologacao — FiscalRuleNotImplementedError não é engolido (Problema Alto #4 da auditoria, Fase Fiscal 3)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('método de pagamento sem regra fiscal (defensivo, mesmo que validateFiscalReadiness não tenha pego) → mensagem real preservada, não o fallback genérico', async () => {
    setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(
      baseFiscalContext({ saleId: SALE_ID, companyId: COMPANY_ID, payments: [{ method: 'card', netAmount: 79.8, cardBrand: null }] }),
    )
    // Simula validação não ter pego (defensivo) — força o caminho de build lançar.
    vi.spyOn(validateModule, 'validateNfeReadiness').mockReturnValue([])
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('validation_failed')
      expect(result.data.validationErrors[0]?.message).toMatch(/método de pagamento/i)
      expect(result.data.validationErrors[0]?.message).not.toBe('Falha inesperada ao montar o payload.')
    }
    expect(issueSpy).not.toHaveBeenCalled()
  })
})

describe('submitNfeHomologacao — resultado autorizado', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Focus retorna autorizado → status authorized, persiste chave/número/série/protocolo', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({
      status: 'autorizado',
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NF-e',
      numero: '4',
      serie: '1',
      chave_nfe: '24260861523225000117550010000000041006759001',
      caminho_xml_nota_fiscal: '/arquivos/xml.xml',
      caminho_danfe: '/arquivos/danfe.pdf',
      protocolo_nota_fiscal: { versao: '4.00', ambiente: '1', chave_nfe: '...', data_recebimento: '...', numero_protocolo: '224260025615528', status: '100', motivo: 'Autorizado o uso da NF-e' },
    })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('24260861523225000117550010000000041006759001')
      expect(result.data.number).toBe('4')
      expect(result.data.authorizationProtocol).toBe('224260025615528')
    }
  })
})

describe('submitNfeHomologacao — processando (assíncrono)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Focus retorna processando_autorizacao → status pending', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })
})

describe('submitNfeHomologacao — erro_autorizacao (nunca tratado sozinho como suficiente)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('status_sefaz/mensagem_sefaz sempre persistidos junto do status authorization_failed', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({
      status: 'erro_autorizacao',
      status_sefaz: '598',
      mensagem_sefaz: 'Rejeição: Total da NF difere do somatório dos itens',
    })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorization_failed')
      expect(result.data.statusSefaz).toBe('598')
      expect(result.data.statusMessage).toContain('Rejeição')
    }
  })
})

describe('submitNfeHomologacao — erro HTTP síncrono da Focus (SEFAZ nunca viu a tentativa)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('FocusApiError (400/422) → status submission_error, nunca authorization_failed', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockRejectedValue(new FocusApiError(422, { codigo: 'erro_validacao_schema', mensagem: 'CNPJ inválido' }))

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('submission_error')
      expect(result.data.submissionErrorCode).toBe('erro_validacao_schema')
    }
  })
})

describe('submitNfeHomologacao — timeout/falha de rede (resultado desconhecido)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('erro genérico (não FocusApiError) → status pending, NUNCA submission_error (resultado desconhecido, não uma rejeição confirmada)', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockRejectedValue(new Error('Focus NFe: tempo limite (15000ms) excedido'))

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('pending')
      expect(result.data.statusMessage).toContain('desconhecido')
    }
  })
})

describe('submitNfeHomologacao — idempotência: retry com a mesma ref', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('provider_ref é determinístico — sempre o mesmo pra (company, sale, environment), nunca um UUID novo', () => {
    expect(buildProviderRef(1, 555, 'homologacao')).toBe('qarvon-1-555-nfe-homologacao')
    expect(buildProviderRef(1, 555, 'homologacao')).toBe(buildProviderRef(1, 555, 'homologacao'))
  })

  it('homologação e produção NUNCA compartilham provider_ref — fundação da coexistência entre ambientes', () => {
    expect(buildProviderRef(1, 555, 'homologacao')).toBe('qarvon-1-555-nfe-homologacao')
    expect(buildProviderRef(1, 555, 'producao')).toBe('qarvon-1-555-nfe-producao')
    expect(buildProviderRef(1, 555, 'homologacao')).not.toBe(buildProviderRef(1, 555, 'producao'))
  })

  it('issueFocusNfe é chamado com a MESMA ref em duas tentativas sequenciais após submission_error', async () => {
    setupFake()
    mockHappyPathDependencies()
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe').mockRejectedValue(new FocusApiError(422, { codigo: 'erro_validacao_schema', mensagem: 'erro' }))

    await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).toHaveBeenCalledTimes(2)
    const [ref1] = issueSpy.mock.calls[0]
    const [ref2] = issueSpy.mock.calls[1]
    expect(ref1).toBe(ref2)
    expect(ref1).toBe(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao'))
  })

  it('linha pending (resultado desconhecido) → segunda chamada CONSULTA em vez de reemitir — issueFocusNfe não é chamado de novo', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()

    // Simula uma tentativa anterior que ficou pending (timeout) — o POST já
    // tinha sido despachado (submission_started_at setado) quando o
    // resultado ficou desconhecido, senão não haveria evidência de
    // transmissão anterior e reclamar direto seria seguro (risco residual
    // #2).
    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao'), status: 'pending',
      submission_started_at: new Date(Date.now() - 2000).toISOString(),
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })
})

describe('submitNfeHomologacao — duplo clique / venda já autorizada', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('linha já authorized → devolve o resultado existente, NUNCA chama Focus de novo', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()

    fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao'), status: 'authorized',
      access_key: '24260861523225000117550010000000041006759001', number: '4', series: '1',
    })

    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfe')
    const consultSpy = vi.spyOn(httpClient, 'consultFocusNfe')

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    expect(issueSpy).not.toHaveBeenCalled()
    expect(consultSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('24260861523225000117550010000000041006759001')
    }
  })

  it('duas chamadas sequenciais rápidas (duplo clique simulado) nunca criam duas linhas em fiscal_documents pra mesma venda', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })
    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({ status: 'processando_autorizacao' })

    await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    await submitNfeHomologacao(SALE_ID, COMPANY_ID)

    const rows = fake.tables.fiscal_documents.filter((r) => r.sale_id === SALE_ID)
    expect(rows).toHaveLength(1)
  })
})

describe('submitNfeHomologacao — segredo nunca aparece no resultado', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('token não aparece em nenhum campo do resultado, mesmo em caminho de erro', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfe').mockRejectedValue(new FocusApiError(422, { codigo: 'erro_validacao_schema', mensagem: 'erro' }))

    const result = await submitNfeHomologacao(SALE_ID, COMPANY_ID)
    expect(JSON.stringify(result)).not.toContain('token-jamais-deveria-vazar')
  })
})

describe('consultAndUpdateFiscalDocument — reconciliação nunca degrada dado local (mesmo hardening aplicado em NFC-e, venda 703)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  function seedPending(fake: ReturnType<typeof createFakeAdmin>, overrides: Record<string, any> = {}) {
    return fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfe', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfe'),
      status: 'pending', submission_started_at: new Date().toISOString(),
      number: null, series: null, access_key: null, authorization_protocol: null,
      xml_path: null, danfe_path: null, authorized_at: null,
      ...overrides,
    })
  }

  it('resposta autorizada sem protocolo (protocolo_nota_fiscal ausente) → status continua authorized, authorization_protocol permanece null, warning estruturado é emitido', async () => {
    const fake = setupFake()
    const seeded = seedPending(fake)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e',
      chave_nfe: '35260861523225000117550010000000041006759001', numero: '4', serie: '1',
      // protocolo_nota_fiscal: AUSENTE de propósito.
    } as any)

    const result = await consultAndUpdateFiscalDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('authorized')
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBeNull()
    expect(persisted.authorized_at).toBeTruthy()

    const { logError } = await import('@/lib/errors/log')
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.stringContaining('authorization_protocol ausente'),
      context: expect.objectContaining({ fiscal_document_id: seeded.id, sale_id: SALE_ID, document_type: 'nfe' }),
    }))
  })

  it('authorization_protocol e authorized_at já existentes nunca são degradados por uma reconciliação posterior sem protocolo', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-20T10:00:00.000Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: '151260029467289', authorized_at: authorizedAtOriginal,
      number: '4', series: '1', access_key: '35260861523225000117550010000000041006759001',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e',
      chave_nfe: '35260861523225000117550010000000041006759001', numero: '4', serie: '1',
    } as any)

    const result = await consultAndUpdateFiscalDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('151260029467289')
    expect(persisted.authorized_at).toBe(authorizedAtOriginal)

    const { logError } = await import('@/lib/errors/log')
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({ route: expect.stringContaining('authorization_protocol ausente') }))
  })

  it('reconciliação enriquece authorization_protocol ausente sem tocar authorized_at já existente', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-20T10:00:00.000Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: null, authorized_at: authorizedAtOriginal,
      number: '4', series: '1', access_key: '35260861523225000117550010000000041006759001',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e',
      chave_nfe: '35260861523225000117550010000000041006759001', numero: '4', serie: '1',
      protocolo_nota_fiscal: { numero_protocolo: '151260029467289', status: '100' },
    } as any)

    const result = await consultAndUpdateFiscalDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('151260029467289')
    expect(persisted.authorized_at).toBe(authorizedAtOriginal)
  })

  it('Focus confirma autorizado, mas a escrita no banco falha → resultado é FALHA (nunca status=authorized), linha no banco continua como estava antes (mesmo padrão já coberto em NFC-e, item 7 da auditoria)', async () => {
    const fake = setupFake()
    const seeded = seedPending(fake)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfe').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e',
      chave_nfe: '4'.repeat(44), numero: '1', serie: '1',
    } as any)
    // Simula a MESMA falha real (CHAR(44) overflow, ou qualquer outra
    // falha de escrita) — antes da correção, isso era engolido em
    // silêncio e a função devolvia 'authorized' mesmo assim.
    fake.forceNextUpdateError('fiscal_documents', 'value too long for type character(44)')

    const result = await consultAndUpdateFiscalDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(false) // NUNCA um success com status='authorized' sem persistência real
    if (!result.ok) expect(result.error).toContain('value too long for type character(44)')
    const rowNoBanco = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(rowNoBanco.status).toBe('pending') // continua exatamente como estava — nada foi gravado
  })
})
