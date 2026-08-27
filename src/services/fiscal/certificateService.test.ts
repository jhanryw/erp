import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'
import * as secrets from '@/services/integrations/secrets.service'
import * as pkcs12 from '@/lib/fiscal/certificate/parsePkcs12'
import { uploadCertificate, validateStoredCertificate, saveCsc, getCscMasked } from './certificateService'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/integrations/company-integrations.service')
vi.mock('@/services/integrations/secrets.service')
vi.mock('@/lib/fiscal/certificate/parsePkcs12', async (importOriginal) => {
  const actual = await importOriginal<typeof pkcs12>()
  return { ...actual, parsePkcs12: vi.fn() }
})

const COMPANY_ID = 1
const USER_ID = 'user-uuid'
const INTEGRATION_ID = 501

const VALID_METADATA = {
  subject: 'CN=EMPRESA TESTE:11222333000181',
  issuer: 'CN=EMPRESA TESTE:11222333000181',
  serialNumber: 'abc123',
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z',
  fingerprint: 'AA:BB:CC',
  cnpj: '11222333000181',
  hasPrivateKey: true,
}

function buildFakeAdmin(fiscalSettingsRow: any) {
  return {
    from: (table: string) => {
      if (table !== 'company_fiscal_settings') throw new Error(`tabela inesperada: ${table}`)
      const chain: any = {
        update: () => chain,
        select: () => chain,
        eq: () => chain,
        async maybeSingle() {
          return { data: fiscalSettingsRow, error: null }
        },
      }
      return chain
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('uploadCertificate', () => {
  it('caminho feliz: cifra PFX+senha, persiste metadata, devolve status=valid', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue(VALID_METADATA)
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: {} })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: '11222333000181' }))

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('fake-pfx'), password: 'senha123' })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('valid')
      expect(result.data.cnpjMismatch).toBe(false)
      expect(result.data.fingerprint).toBe('AA:BB:CC')
    }
    expect(secrets.setIntegrationSecret).toHaveBeenCalledWith(INTEGRATION_ID, COMPANY_ID, 'certificate_pfx_b64', expect.any(String))
    expect(secrets.setIntegrationSecret).toHaveBeenCalledWith(INTEGRATION_ID, COMPANY_ID, 'certificate_password', 'senha123')
  })

  it('cria a integração quando ainda não existe (primeiro upload)', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue(VALID_METADATA)
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: null })
    ;(companyIntegrations.createCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: {} })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: null }))

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('fake-pfx'), password: 'senha123' })
    expect(result.ok).toBe(true)
    expect(companyIntegrations.createCompanyIntegration).toHaveBeenCalledWith({ companyId: COMPANY_ID, provider: 'fiscal_certificate', settings: {}, createdBy: USER_ID })
  })

  it('rejeita PFX sem chave privada, nunca persiste nada', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue({ ...VALID_METADATA, hasPrivateKey: false })

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('x'), password: 'y' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/chave privada/)
    expect(companyIntegrations.getCompanyIntegration).not.toHaveBeenCalled()
    expect(secrets.setIntegrationSecret).not.toHaveBeenCalled()
  })

  it('senha incorreta (Pkcs12ParseError) → falha 422, nunca persiste nada', async () => {
    ;(pkcs12.parsePkcs12 as any).mockImplementation(() => {
      throw new pkcs12.Pkcs12ParseError('Senha incorreta ou arquivo corrompido.')
    })

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('x'), password: 'errada' })
    expect(result.ok).toBe(false)
    if (!result.ok) { expect(result.status).toBe(422); expect(result.error).toMatch(/[Ss]enha/) }
    expect(secrets.setIntegrationSecret).not.toHaveBeenCalled()
  })

  it('CNPJ do certificado diverge do CNPJ da empresa → cnpjMismatch=true, mas ainda salva', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue(VALID_METADATA) // cnpj 11222333000181
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: {} })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: '99888777000166' })) // CNPJ diferente

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('x'), password: 'y' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.cnpjMismatch).toBe(true)
  })

  it('certificado vencido → status=expired, não bloqueia o upload', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue({ ...VALID_METADATA, validUntil: '2020-01-01T00:00:00.000Z' })
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: {} })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: null }))

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('x'), password: 'y' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('expired')
  })

  it('nenhuma linha em company_fiscal_settings → falha explícita, nunca silenciosa', async () => {
    ;(pkcs12.parsePkcs12 as any).mockReturnValue(VALID_METADATA)
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(companyIntegrations.updateCompanyIntegration as any).mockResolvedValue({ ok: true, data: {} })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin(null)) // .maybeSingle() devolve null = 0 linhas afetadas

    const result = await uploadCertificate({ companyId: COMPANY_ID, userId: USER_ID, pfxBuffer: Buffer.from('x'), password: 'y' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/company_fiscal_settings|dados fiscais/)
  })
})

describe('validateStoredCertificate', () => {
  it('nenhum certificado configurado → 404', async () => {
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: null })
    const result = await validateStoredCertificate(COMPANY_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('reabre o PFX armazenado (decifrado) e revalida, sem exigir novo upload', async () => {
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.getIntegrationSecret as any).mockImplementation((_id: number, _cid: number, key: string) =>
      Promise.resolve({ ok: true, data: key === 'certificate_pfx_b64' ? Buffer.from('fake').toString('base64') : 'senha123' }),
    )
    ;(pkcs12.parsePkcs12 as any).mockReturnValue(VALID_METADATA)
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: null }))

    const result = await validateStoredCertificate(COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.status).toBe('valid')
  })

  it('PFX armazenado não abre mais (corrompido) → marca invalid, falha explícita', async () => {
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.getIntegrationSecret as any).mockResolvedValue({ ok: true, data: 'algo' })
    ;(pkcs12.parsePkcs12 as any).mockImplementation(() => { throw new pkcs12.Pkcs12ParseError('corrompido') })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: null }))

    const result = await validateStoredCertificate(COMPANY_ID)
    expect(result.ok).toBe(false)
  })
})

describe('saveCsc / getCscMasked', () => {
  it('saveCsc cifra o token e grava o ID em texto', async () => {
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.setIntegrationSecret as any).mockResolvedValue({ ok: true, data: undefined })
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ cnpj: null }))

    const result = await saveCsc({ companyId: COMPANY_ID, userId: USER_ID, cscId: '000001', cscToken: 'meu-token-secreto' })
    expect(result.ok).toBe(true)
    expect(secrets.setIntegrationSecret).toHaveBeenCalledWith(INTEGRATION_ID, COMPANY_ID, 'csc_token', 'meu-token-secreto')
  })

  it('getCscMasked nunca devolve o token completo — só os últimos 4 caracteres', async () => {
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ csc_id: '000001' }))
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: { id: INTEGRATION_ID } })
    ;(secrets.getIntegrationSecret as any).mockResolvedValue({ ok: true, data: 'meu-token-secreto-AB12' })

    const result = await getCscMasked(COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.cscTokenMasked).toMatch(/^•+AB12$/)
      expect(result.data.cscTokenMasked).not.toContain('meu-token-secreto')
    }
  })

  it('getCscMasked sem integração ainda configurada → cscTokenMasked null, nunca lança', async () => {
    ;(createAdminClient as any).mockReturnValue(buildFakeAdmin({ csc_id: null }))
    ;(companyIntegrations.getCompanyIntegration as any).mockResolvedValue({ ok: true, data: null })

    const result = await getCscMasked(COMPANY_ID)
    expect(result.ok).toBe(true)
    if (result.ok) { expect(result.data.cscTokenMasked).toBeNull(); expect(result.data.cscId).toBeNull() }
  })
})
