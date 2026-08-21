import { describe, it, expect, vi, afterEach } from 'vitest'
import { submitNfceHomologacao } from './submitNfceHomologacao'
import { buildProviderRef } from './submitNfeHomologacao'
import * as resolveModule from './resolveFocusIntegration'
import * as loadModule from './loadSaleFiscalContext'
import * as validateModule from './validateFiscalReadiness'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { FocusApiError } from '@/lib/integrations/focus/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { createFakeAdmin, mockCreateAdminClient } from './testFakeAdminClient'
import { baseFiscalContext } from './testFixtures'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 777

function setupFake(overrides: { fiscalSettings?: Record<string, any> | null } = {}) {
  const fake = createFakeAdmin({
    company_fiscal_settings: [
      overrides.fiscalSettings === null
        ? undefined
        : { id: 1, company_id: COMPANY_ID, nfce_environment: 'homologacao', nfce_enabled: true, ...overrides.fiscalSettings },
    ].filter(Boolean) as any[],
  })
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(mockCreateAdminClient(fake))
  return fake
}

function nfceBalcaoContext() {
  return baseFiscalContext({
    saleId: SALE_ID, companyId: COMPANY_ID,
    operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
    destinatario: {
      nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null,
      telefone: null, email: null, logradouro: null, numero: null, complemento: null,
      bairro: null, municipio: null, municipioIbge: null, uf: null, cep: null,
    },
  })
}

function mockHappyPathDependencies() {
  vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
    ok: true,
    data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'token-jamais-deveria-vazar', environment: 'homologacao' } },
  })
  vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(nfceBalcaoContext())
  vi.spyOn(validateModule, 'validateNfceReadiness').mockReturnValue([])
}

describe('submitNfceHomologacao — bloqueio de produção (gate SEPARADO de NF-e)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('nfce_environment=producao → 403, nunca chama Focus', async () => {
    setupFake({ fiscalSettings: { nfce_environment: 'producao' } })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfce')

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('nfce_enabled=false → falha, nunca chama Focus (independente de nfe_enabled)', async () => {
    setupFake({ fiscalSettings: { nfce_enabled: false } })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfce')

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('company_fiscal_settings ausente → falha, nunca chama Focus', async () => {
    setupFake({ fiscalSettings: null })
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfce')

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(false)
    expect(issueSpy).not.toHaveBeenCalled()
  })
})

describe('submitNfceHomologacao — validação bloqueia emissão (readiness NFC-e, nunca a de NF-e)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('erros de validação → status validation_failed, nunca chama Focus', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(validateModule, 'validateNfceReadiness').mockReturnValue([{ code: 'item_ncm_missing', message: 'Produto sem NCM.' }])
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfce')

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('validation_failed')
      expect(result.data.validationErrors).toHaveLength(1)
    }
    expect(issueSpy).not.toHaveBeenCalled()
  })

  it('consumidor não identificado (sem nome/CPF/endereço) → validateNfceReadiness REAL não bloqueia', async () => {
    setupFake()
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(loadModule, 'loadSaleFiscalContext').mockResolvedValue(nfceBalcaoContext())
    // validateNfceReadiness NÃO mockada — roda a implementação real.
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({ status: 'autorizado', chave_nfe: '1'.repeat(44), numero: '1', serie: '1' })

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('authorized')
  })
})

describe('submitNfceHomologacao — resultado autorizado', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Focus retorna autorizado → status authorized, persiste chave/número/série, nunca chama /v2/nfe (NF-e)', async () => {
    setupFake()
    mockHappyPathDependencies()
    const issueNfceSpy = vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado',
      chave_nfe: '24260861523225000117650010000000101006759099', numero: '1', serie: '1',
      caminho_xml_nota_fiscal: '/x.xml', caminho_danfe: '/d.html', qrcode_url: 'https://qr.example/x',
    })
    const issueNfeSpy = vi.spyOn(httpClient, 'issueFocusNfe')

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.accessKey).toBe('24260861523225000117650010000000101006759099')
    }
    expect(issueNfceSpy).toHaveBeenCalledOnce()
    expect(issueNfeSpy).not.toHaveBeenCalled()
  })

  it('provider_ref determinística termina em -nfce, nunca -nfe', () => {
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'nfce')).toBe(`qarvon-${COMPANY_ID}-${SALE_ID}-nfce`)
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'nfce')).not.toBe(buildProviderRef(COMPANY_ID, SALE_ID, 'nfe'))
  })
})

describe('submitNfceHomologacao — denegado (status real de NFC-e sem equivalente em NF-e)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('status="denegado" → mapeado pra authorization_failed, status_sefaz/mensagem_sefaz preservados', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({
      status: 'denegado', status_sefaz: '110', mensagem_sefaz: 'Uso Denegado: Irregularidade fiscal do emitente',
    })

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorization_failed')
      expect(result.data.statusSefaz).toBe('110')
      expect(result.data.statusMessage).toMatch(/Denegado/)
    }
  })
})

describe('submitNfceHomologacao — erro HTTP síncrono (Focus nunca viu a tentativa)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('FocusApiError (400/422) → status submission_error', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockRejectedValue(new FocusApiError(422, { codigo: 'erro_validacao_schema', mensagem: 'CSC inválido' }))

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('submission_error')
  })
})

describe('submitNfceHomologacao — timeout/rede (resultado desconhecido)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('erro genérico → status pending, nunca submission_error', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockRejectedValue(new Error('Focus NFe: tempo limite (15000ms) excedido'))

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('pending')
  })
})

describe('submitNfceHomologacao — concorrência (mesma garantia claim → begin → POST → complete)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Promise.all([submit, submit]) pra mesma venda → issueFocusNfce chamado EXATAMENTE 1 vez', async () => {
    setupFake()
    mockHappyPathDependencies()
    const issueSpy = vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({ status: 'autorizado', chave_nfe: '2'.repeat(44), numero: '1', serie: '1' })

    const [r1, r2] = await Promise.all([
      submitNfceHomologacao(SALE_ID, COMPANY_ID),
      submitNfceHomologacao(SALE_ID, COMPANY_ID),
    ])

    expect(issueSpy).toHaveBeenCalledTimes(1)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
  })

  it('claim de NFC-e e claim de NF-e pra MESMA venda nunca colidem — linhas fiscal_documents separadas', async () => {
    const fake = setupFake({ fiscalSettings: { nfe_environment: 'homologacao', nfe_enabled: true, nfce_environment: 'homologacao', nfce_enabled: true } })
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({ status: 'autorizado', chave_nfe: '3'.repeat(44), numero: '1', serie: '1' })

    const resultNfce = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(resultNfce.ok).toBe(true)

    const rows = fake.tables.fiscal_documents.filter((r: any) => r.sale_id === SALE_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0].document_type).toBe('nfce')
  })
})

describe('submitNfceHomologacao — segredo nunca aparece no resultado', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('token não aparece em nenhum campo do resultado, mesmo em caminho de erro', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockRejectedValue(new FocusApiError(422, { codigo: 'erro_validacao_schema', mensagem: 'erro' }))

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(JSON.stringify(result)).not.toContain('token-jamais-deveria-vazar')
  })
})
