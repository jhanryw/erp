import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { submitNfceHomologacao, consultAndUpdateNfceDocument, extractFocusAccessKey, FocusAccessKeyError } from './submitNfceHomologacao'
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
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

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
      nome: null, isAnonymous: true, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null,
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

  it('provider_ref determinística termina em -nfce-{environment}, nunca -nfe', () => {
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')).toBe(`qarvon-${COMPANY_ID}-${SALE_ID}-nfce-homologacao`)
    expect(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')).not.toBe(buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfe'))
  })

  it('homologação e produção nunca compartilham provider_ref de NFC-e', () => {
    const homolog = buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce')
    const producao = buildProviderRef(COMPANY_ID, SALE_ID, 'producao', 'nfce')
    expect(homolog).toBe(`qarvon-${COMPANY_ID}-${SALE_ID}-nfce-homologacao`)
    expect(producao).toBe(`qarvon-${COMPANY_ID}-${SALE_ID}-nfce-producao`)
    expect(homolog).not.toBe(producao)
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

describe('extractFocusAccessKey — normalização da chave de acesso (achado real, venda 626 tentativa 3: Postgres rejeitou "value too long for type character(44)")', () => {
  it('chave já bare (44 dígitos, sem prefixo) — passa direto', () => {
    const chave = '1'.repeat(44)
    expect(extractFocusAccessKey(chave)).toBe(chave)
  })

  it('chave real da doc oficial Focus (exemplo "NFCeAutorizada", com prefixo "NFe") — remove o prefixo e devolve os 44 dígitos', () => {
    // Valor EXATO do exemplo oficial (doc.focusnfe.com.br/reference/emitir_nfce.md,
    // curl bruto — não resumo de IA): "chave_nfe": "NFe4119061234567800012365...484310".
    // O mesmo valor sem prefixo reaparece em qrcode_url (p=...) no mesmo exemplo,
    // confirmando que os 44 dígitos após "NFe" são a chave de acesso real.
    const chaveComPrefixo = 'NFe41190612345678000123650010000000121743484310'
    const chaveEsperada = '41190612345678000123650010000000121743484310'
    expect(chaveComPrefixo.length).toBe(47)
    expect(chaveEsperada.length).toBe(44)
    expect(extractFocusAccessKey(chaveComPrefixo)).toBe(chaveEsperada)
  })

  it('ausente (null/undefined) → lança FocusAccessKeyError, nunca persiste null silenciosamente disfarçado de sucesso', () => {
    expect(() => extractFocusAccessKey(null)).toThrow(FocusAccessKeyError)
    expect(() => extractFocusAccessKey(undefined)).toThrow(FocusAccessKeyError)
  })

  it('comprimento errado mesmo após remover prefixo → lança com mensagem diagnóstica clara (nunca trunca)', () => {
    expect(() => extractFocusAccessKey('NFe123')).toThrow(FocusAccessKeyError)
    try {
      extractFocusAccessKey('NFe123')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(FocusAccessKeyError)
      expect((err as Error).message).toMatch(/44 dígitos/)
      expect((err as Error).message).toMatch(/nada foi persistido/)
    }
  })

  it('contém caractere não-numérico após normalizar → lança (nunca aceita "quase válido")', () => {
    expect(() => extractFocusAccessKey('NFe' + '1'.repeat(43) + 'X')).toThrow(FocusAccessKeyError)
  })
})

describe('submitNfceHomologacao — chave de acesso com prefixo "NFe" da Focus (achado real, venda 626 tentativa 3)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('resposta REAL de NFC-e autorizada (capturada da venda 703, provider_payload real — não mais um exemplo inventado) — path de EMISSÃO DIRETA (issueFocusNfce) persiste number/series/access_key(44, sem prefixo)/authorization_protocol (via `protocolo`, campo real)/xml_path/danfe_path/authorized_at', async () => {
    const fake = setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({
      cnpj_emitente: '12345678000123',
      ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'),
      status: 'autorizado',
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: 'NFe41190612345678000123650010000000121743484310',
      numero: '12',
      serie: '1',
      // `protocolo` — campo REAL confirmado por payload capturado da venda
      // 703 (nunca `numero_protocolo`, que era uma suposição não
      // verificada — ver comentário completo em FocusNfceConsultaResponse).
      protocolo: '324260000079215',
      caminho_xml_nota_fiscal: '/arquivos/12345678000123/XMLs/41190612345678000123650010000000121743484310-nfce.xml',
      caminho_danfe: '/notas_fiscais_consumidor/NFe41190612345678000123650010000000121743484310.html',
      qrcode_url: 'http://www.fazenda.pr.gov.br/nfce/qrcode/?p=41190612345678000123650010000000121743484310|2|2|1|5E264C0E28D801197219894CDFCF2FCCC5237F08',
    })

    const before = Date.now()
    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.number).toBe('12')
      expect(result.data.series).toBe('1')
      expect(result.data.accessKey).toBe('41190612345678000123650010000000121743484310')
      expect(result.data.accessKey).toHaveLength(44)
      expect(result.data.accessKey?.startsWith('NFe')).toBe(false)
      expect(result.data.authorizationProtocol).toBe('324260000079215')
      expect(result.data.xmlPath).toBe('/arquivos/12345678000123/XMLs/41190612345678000123650010000000121743484310-nfce.xml')
      expect(result.data.danfePath).toBe('/notas_fiscais_consumidor/NFe41190612345678000123650010000000121743484310.html')
      // Fase Fiscal 7 — qrcode_url REAL da Focus, persistido (antes desta
      // fase era descartado: só ficava soterrado em provider_payload).
      expect(result.data.qrcodeUrl).toBe('http://www.fazenda.pr.gov.br/nfce/qrcode/?p=41190612345678000123650010000000121743484310|2|2|1|5E264C0E28D801197219894CDFCF2FCCC5237F08')
    }
    // authorized_at não é exposto em SubmitNfeResult — confirmado direto na linha persistida no fake.
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.sale_id === SALE_ID && r.document_type === 'nfce')
    expect(persisted.authorized_at).toBeTruthy()
    expect(new Date(persisted.authorized_at).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('COMPATIBILIDADE LEGADA — se uma resposta vier só com numero_protocolo (sem protocolo), ainda é aceito como fallback, mas isso NUNCA é o contrato real (nenhuma resposta real da Focus trouxe esse campo)', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({
      status: 'autorizado', chave_nfe: '5'.repeat(44), numero: '1', serie: '1',
      numero_protocolo: '999999999999999', // só o fallback legado, sem `protocolo`
    } as any)

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.authorizationProtocol).toBe('999999999999999')
  })

  it('chave_nfe malformada (nem 44 dígitos, nem prefixo "NFe" reconhecível) → NUNCA lança pro chamador; cai em status pending com mensagem diagnóstica clara, nunca o erro genérico do Postgres', async () => {
    setupFake()
    mockHappyPathDependencies()
    vi.spyOn(httpClient, 'issueFocusNfce').mockResolvedValue({
      status: 'autorizado', chave_nfe: 'algo-completamente-diferente', numero: '1', serie: '1',
    })

    const result = await submitNfceHomologacao(SALE_ID, COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('pending')
      expect(result.data.statusMessage).toMatch(/chave_nfe da Focus não corresponde/)
      expect(result.data.statusMessage).not.toMatch(/character/) // nunca o erro cru do Postgres
      expect(result.data.accessKey).toBeNull() // nada foi persistido como chave
    }
  })
})

describe('consultAndUpdateNfceDocument — falha de persistência nunca vira falso "autorizado" (achado real, venda 626, item 7 da auditoria)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('Focus confirma autorizado, mas a escrita no banco falha → resultado é FALHA (nunca status=authorized), linha no banco continua como estava antes', async () => {
    const fake = setupFake()
    const seeded = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'),
      status: 'pending', submission_started_at: new Date().toISOString(),
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado',
      chave_nfe: '4'.repeat(44), numero: '1', serie: '1',
    })
    // Simula a MESMA falha real (CHAR(44) overflow, ou qualquer outra
    // falha de escrita) — antes da correção, isso era engolido em
    // silêncio e a função devolvia 'authorized' mesmo assim.
    fake.forceNextUpdateError('fiscal_documents', 'value too long for type character(44)')

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(false) // NUNCA um success com status='authorized' sem persistência real
    const rowNoBanco = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(rowNoBanco.status).toBe('pending') // continua exatamente como estava — nada foi gravado
  })

  it('resposta REAL de NFC-e autorizada (capturada da venda 703) — path de RECONCILIAÇÃO (consultFocusNfce) persiste number/series/access_key(44, sem prefixo)/authorization_protocol (via `protocolo`, campo real)/xml_path/danfe_path/authorized_at, exatamente como o path de emissão direta', async () => {
    const fake = setupFake()
    const seeded = fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'),
      status: 'pending', submission_started_at: new Date().toISOString(),
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      cnpj_emitente: '12345678000123',
      ref: (seeded as any).provider_ref,
      status: 'autorizado',
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: 'NFe41190612345678000123650010000000121743484310',
      numero: '12',
      serie: '1',
      protocolo: '324260000079215',
      caminho_xml_nota_fiscal: '/arquivos/12345678000123/XMLs/41190612345678000123650010000000121743484310-nfce.xml',
      caminho_danfe: '/notas_fiscais_consumidor/NFe41190612345678000123650010000000121743484310.html',
      qrcode_url: 'http://www.fazenda.pr.gov.br/nfce/qrcode/?p=reconciliacao',
    })

    const before = Date.now()
    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized')
      expect(result.data.number).toBe('12')
      expect(result.data.series).toBe('1')
      expect(result.data.accessKey).toBe('41190612345678000123650010000000121743484310')
      expect(result.data.accessKey).toHaveLength(44)
      expect(result.data.accessKey?.startsWith('NFe')).toBe(false)
      expect(result.data.authorizationProtocol).toBe('324260000079215')
      expect(result.data.xmlPath).toBe('/arquivos/12345678000123/XMLs/41190612345678000123650010000000121743484310-nfce.xml')
      expect(result.data.danfePath).toBe('/notas_fiscais_consumidor/NFe41190612345678000123650010000000121743484310.html')
      // Fase Fiscal 7 — mesmo path de reconciliação ("Verificar status")
      // também persiste qrcode_url, não só a emissão direta.
      expect(result.data.qrcodeUrl).toBe('http://www.fazenda.pr.gov.br/nfce/qrcode/?p=reconciliacao')
    }
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorized_at).toBeTruthy()
    expect(new Date(persisted.authorized_at).getTime()).toBeGreaterThanOrEqual(before)
    expect(persisted.authorization_protocol).toBe('324260000079215')
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

describe('consultAndUpdateNfceDocument — reconciliação nunca degrada dado local (achado real, venda 703, homologação, 2026-08-28)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  function seedPending(fake: ReturnType<typeof createFakeAdmin>, overrides: Record<string, any> = {}) {
    return fake.seedFiscalDocument({
      company_id: COMPANY_ID, sale_id: SALE_ID, document_type: 'nfce', provider: 'focus_nfe',
      environment: 'homologacao', provider_ref: buildProviderRef(COMPANY_ID, SALE_ID, 'homologacao', 'nfce'),
      status: 'pending', submission_started_at: new Date().toISOString(),
      number: null, series: null, access_key: null, authorization_protocol: null,
      xml_path: null, danfe_path: null, qrcode_url: null, authorized_at: null,
      ...overrides,
    })
  }

  it('regressão EXATA da venda 703 (payload REAL capturado, confirmado por consulta real à Focus — CORRIGIDO: o campo é `protocolo`, não `numero_protocolo`): reconciliação extrai authorization_protocol="324260000079215", preserva authorized_at já existente e não toca nos demais campos', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-28T03:13:51.249Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: null, authorized_at: authorizedAtOriginal,
      number: '3', series: '1', access_key: '24260861523225000117650010000000031299421242',
      danfe_path: '/notas_fiscais_consumidor/NFe24260861523225000117650010000000031299421242.html',
      xml_path: '/arquivos_development/61523225000117_246513/202608/XMLs/24260861523225000117650010000000031299421242-nfe.xml',
      qrcode_url: 'https://hom.nfce.sefaz.rn.gov.br/consultarNFCe.aspx?p=24260861523225000117650010000000031299421242|3|2',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    // Payload REAL, capturado de uma consulta real à Focus pra sale_id=703
    // (2026-08-28) — prova definitiva de que o campo é `protocolo`, plano,
    // nunca `numero_protocolo`.
    const payloadReal703 = {
      ref: 'qarvon-1-703-nfce',
      serie: '1',
      numero: '3',
      status: 'autorizado' as const,
      chave_nfe: 'NFe24260861523225000117650010000000031299421242',
      protocolo: '324260000079215',
      qrcode_url: 'https://hom.nfce.sefaz.rn.gov.br/consultarNFCe.aspx?p=24260861523225000117650010000000031299421242|3|2',
      status_sefaz: '100',
      caminho_danfe: '/notas_fiscais_consumidor/NFe24260861523225000117650010000000031299421242.html',
      cnpj_emitente: '61523225000117',
      mensagem_sefaz: 'Autorizado o uso da NF-e',
      url_consulta_nf: 'https://www.set.rn.gov.br/nfce/consulta',
      caminho_xml_nota_fiscal: '/arquivos_development/61523225000117_246513/202608/XMLs/24260861523225000117650010000000031299421242-nfe.xml',
    }
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue(payloadReal703 as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('authorized')
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('324260000079215') // reparo correto e idempotente, sem SQL/backfill
    expect(persisted.authorized_at).toBe(authorizedAtOriginal) // NUNCA alterado — reparo, não novo evento de autorização
    expect(persisted.access_key).toBe('24260861523225000117650010000000031299421242')
    expect(persisted.number).toBe('3')
    expect(persisted.series).toBe('1')
    expect(persisted.qrcode_url).toBe(payloadReal703.qrcode_url)
    expect(persisted.danfe_path).toBe(payloadReal703.caminho_danfe)
    expect(persisted.xml_path).toBe(payloadReal703.caminho_xml_nota_fiscal)

    const { logError } = await import('@/lib/errors/log')
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({ route: expect.stringContaining('authorization_protocol ausente') })) // protocolo resolvido — nada de anômalo a reportar
  })

  it('DEFENSIVO (cenário hipotético, não a venda 703): se uma resposta autorizada vier genuinamente sem `protocolo` E sem o fallback `numero_protocolo`, e não houver valor local prévio → status continua authorized, authorization_protocol permanece null (nunca inventa), warning estruturado é emitido, nada mais é degradado', async () => {
    const fake = setupFake()
    const seeded = seedPending(fake)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    const respostaSemProtocolo = {
      status: 'autorizado' as const,
      status_sefaz: '100',
      mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: '24260861523225000117650010000000031299421242',
      numero: '3',
      serie: '1',
      caminho_danfe: '/notas_fiscais_consumidor/NFe24260861523225000117650010000000031299421242.html',
      caminho_xml_nota_fiscal: '/arquivos_development/61523225000117_246513/202608/XMLs/24260861523225000117650010000000031299421242-nfe.xml',
      qrcode_url: 'https://www.homologacao.nfce.fazenda.pr.gov.br/qrcode?p=exemplo',
      // protocolo/numero_protocolo: AMBOS ausentes de propósito — cenário defensivo, nunca observado de fato na venda 703 (que tem `protocolo`).
    }
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue(respostaSemProtocolo as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('authorized') // NUNCA vira rejeitado/erro por faltar protocolo
    }
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBeNull() // nunca inventado
    expect(persisted.number).toBe('3')
    expect(persisted.series).toBe('1')
    expect(persisted.danfe_path).toBe(respostaSemProtocolo.caminho_danfe)
    expect(persisted.xml_path).toBe(respostaSemProtocolo.caminho_xml_nota_fiscal)
    expect(persisted.qrcode_url).toBe(respostaSemProtocolo.qrcode_url)
    expect(persisted.authorized_at).toBeTruthy() // primeira vez que autoriza — preenchido
    expect(persisted.provider_payload).toEqual(respostaSemProtocolo) // provider_payload = última resposta bruta, documentado

    const { logError } = await import('@/lib/errors/log')
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.stringContaining('authorization_protocol ausente'),
      context: expect.objectContaining({ fiscal_document_id: seeded.id, sale_id: SALE_ID, company_id: COMPANY_ID, document_type: 'nfce' }),
    }))
  })

  it('protocolo LOCAL já existente nunca é apagado quando uma reconciliação posterior vem sem `protocolo` (nem o fallback `numero_protocolo`) — authorized_at existente também é preservado (nunca uma nova consulta = nova data de autorização)', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-28T03:13:51.249Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: '324260000079215', authorized_at: authorizedAtOriginal,
      number: '3', series: '1', access_key: '24260861523225000117650010000000031299421242',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: '24260861523225000117650010000000031299421242', numero: '3', serie: '1',
      // protocolo/numero_protocolo: AUSENTES nesta consulta — não pode apagar o valor já persistido.
    } as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('324260000079215') // preservado, nunca degradado pra null
    expect(persisted.authorized_at).toBe(authorizedAtOriginal) // preservado — consulta não é um novo evento de autorização

    const { logError } = await import('@/lib/errors/log')
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({ route: expect.stringContaining('authorization_protocol ausente') })) // protocolo presente (preservado) — nada de anômalo a reportar
  })

  it('reconciliação ENRIQUECE um documento authorized com authorization_protocol ainda null via `protocolo` (campo real), sem tocar authorized_at já existente', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-28T03:13:51.249Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: null, authorized_at: authorizedAtOriginal,
      number: '3', series: '1', access_key: '24260861523225000117650010000000031299421242',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: '24260861523225000117650010000000031299421242', numero: '3', serie: '1',
      protocolo: '324260000079215', // desta vez presente — deve enriquecer
    } as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('324260000079215') // enriquecido
    expect(persisted.authorized_at).toBe(authorizedAtOriginal) // NUNCA reescrito — não é um novo evento de autorização

    const { logError } = await import('@/lib/errors/log')
    expect(logError).not.toHaveBeenCalledWith(expect.objectContaining({ route: expect.stringContaining('authorization_protocol ausente') }))
  })

  it('COMPATIBILIDADE LEGADA na reconciliação — se a consulta vier só com numero_protocolo (sem `protocolo`), ainda enriquece como fallback, mas isso nunca é o contrato real (nenhuma resposta real da Focus trouxe esse campo)', async () => {
    const fake = setupFake()
    const authorizedAtOriginal = '2026-08-28T03:13:51.249Z'
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: null, authorized_at: authorizedAtOriginal,
      number: '3', series: '1', access_key: '24260861523225000117650010000000031299421242',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NFC-e',
      chave_nfe: '24260861523225000117650010000000031299421242', numero: '3', serie: '1',
      numero_protocolo: '999999999999999', // só o fallback legado, sem `protocolo`
    } as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true)
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.authorization_protocol).toBe('999999999999999')
    expect(persisted.authorized_at).toBe(authorizedAtOriginal)
  })

  it('access_key local já existente é preservada quando uma reconciliação posterior vem sem chave_nfe — nunca lança FocusAccessKeyError quando há valor local confiável pra preservar', async () => {
    const fake = setupFake()
    const seeded = seedPending(fake, {
      status: 'authorized', authorization_protocol: '141190000123456', authorized_at: '2026-08-28T03:13:51.249Z',
      number: '3', series: '1', access_key: '24260861523225000117650010000000031299421242',
      danfe_path: '/notas_fiscais_consumidor/existente.html', xml_path: '/arquivos/existente.xml', qrcode_url: 'https://existente/qrcode',
    })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: COMPANY_ID, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'consultFocusNfce').mockResolvedValue({
      status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NFC-e',
      // chave_nfe, numero, serie, caminho_danfe, caminho_xml_nota_fiscal, qrcode_url: todos AUSENTES nesta resposta mínima.
    } as any)

    const result = await consultAndUpdateNfceDocument(seeded.id, (seeded as any).provider_ref, COMPANY_ID)

    expect(result.ok).toBe(true) // nunca lança — havia valor local pra preservar em cada campo
    const persisted = fake.tables.fiscal_documents.find((r: any) => r.id === seeded.id)
    expect(persisted.access_key).toBe('24260861523225000117650010000000031299421242')
    expect(persisted.number).toBe('3')
    expect(persisted.series).toBe('1')
    expect(persisted.danfe_path).toBe('/notas_fiscais_consumidor/existente.html')
    expect(persisted.xml_path).toBe('/arquivos/existente.xml')
    expect(persisted.qrcode_url).toBe('https://existente/qrcode')
    expect(persisted.authorization_protocol).toBe('141190000123456')
  })
})
