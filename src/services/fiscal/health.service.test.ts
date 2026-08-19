import { describe, it, expect, vi, afterEach } from 'vitest'
import { getFiscalHealth, testFocusConnection } from './health.service'
import * as resolveModule from './resolveFocusIntegration'
import * as httpClient from '@/lib/integrations/focus/httpClient'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function mockFiscalSettingsRow(row: Record<string, unknown> | null) {
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  })
}

const COMPLETE_SETTINGS = {
  nfe_enabled: true,
  nfe_environment: 'homologacao',
  cnpj: '12345678000199',
  razao_social: 'Santtorini LTDA',
  inscricao_estadual: '123456789',
  crt: 1,
  logradouro: 'Rua X',
  numero_endereco: '100',
  bairro: 'Centro',
  municipio: 'São Paulo',
  municipio_ibge: '3550308',
  uf: 'SP',
  cep: '01000000',
}

describe('getFiscalHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sem registro em company_fiscal_settings → fiscalSettingsConfigured false, todos os campos faltando', async () => {
    mockFiscalSettingsRow(null)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'integration_not_found' } })

    const result = await getFiscalHealth(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fiscalSettingsConfigured).toBe(false)
      expect(result.data.emitente.complete).toBe(false)
      expect(result.data.emitente.missingFields.length).toBeGreaterThan(0)
      expect(result.data.readyForHomologacao).toBe(false)
    }
  })

  it('cadastro completo + integração conectada + ambiente homologação → readyForHomologacao true', async () => {
    mockFiscalSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'tok', environment: 'homologacao' } },
    })

    const result = await getFiscalHealth(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.emitente.complete).toBe(true)
      expect(result.data.emitente.missingFields).toEqual([])
      expect(result.data.focusIntegration.connected).toBe(true)
      expect(result.data.readyForHomologacao).toBe(true)
    }
  })

  it('cadastro completo mas ambiente = producao → readyForHomologacao false (esta fase só permite homologação)', async () => {
    mockFiscalSettingsRow({ ...COMPLETE_SETTINGS, nfe_environment: 'producao' })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'tok', environment: 'producao' } },
    })

    const result = await getFiscalHealth(1)
    if (result.ok) expect(result.data.readyForHomologacao).toBe(false)
  })

  it('um campo do emitente faltando → complete false e listado em missingFields', async () => {
    mockFiscalSettingsRow({ ...COMPLETE_SETTINGS, cnpj: null })
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'token_missing' } })

    const result = await getFiscalHealth(1)
    if (result.ok) {
      expect(result.data.emitente.complete).toBe(false)
      expect(result.data.emitente.missingFields).toContain('CNPJ')
    }
  })

  it('resposta nunca inclui o token, em nenhum campo', async () => {
    mockFiscalSettingsRow(COMPLETE_SETTINGS)
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'token-jamais-deveria-vazar', environment: 'homologacao' } },
    })

    const result = await getFiscalHealth(1)
    expect(JSON.stringify(result)).not.toContain('token-jamais-deveria-vazar')
  })
})

describe('testFocusConnection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('integração não disponível → connected: false, sem chamar a Focus', async () => {
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({ ok: true, data: { available: false, reason: 'integration_not_found' } })
    const listSpy = vi.spyOn(httpClient, 'listFocusEmpresas')

    const result = await testFocusConnection(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.connected).toBe(false)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('integração disponível e chamada bem-sucedida → connected: true com contagem de empresas', async () => {
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'listFocusEmpresas').mockResolvedValue([{ id: 1, cnpj: '123', nome: 'Empresa' }])

    const result = await testFocusConnection(1)
    if (result.ok) {
      expect(result.data.connected).toBe(true)
      expect(result.data.empresasCount).toBe(1)
    }
  })

  it('chamada à Focus falha (rede) → connected: false com mensagem, não lança', async () => {
    vi.spyOn(resolveModule, 'resolveFocusIntegration').mockResolvedValue({
      ok: true,
      data: { available: true, integration: { integrationId: 1, companyId: 1, token: 'tok', environment: 'homologacao' } },
    })
    vi.spyOn(httpClient, 'listFocusEmpresas').mockRejectedValue(new Error('falha de rede'))

    const result = await testFocusConnection(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.connected).toBe(false)
  })
})
