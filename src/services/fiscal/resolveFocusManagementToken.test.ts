import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveFocusManagementToken } from './resolveFocusManagementToken'
import * as companyIntegrations from '@/services/integrations/company-integrations.service'
import * as secrets from '@/services/integrations/secrets.service'

function integration(overrides: Partial<companyIntegrations.CompanyIntegration> = {}): companyIntegrations.CompanyIntegration {
  return {
    id: 1,
    company_id: 1,
    provider: 'focus_nfe',
    external_account_id: null,
    status: 'active',
    settings: {},
    last_error: null,
    created_at: '',
    updated_at: '',
    created_by: null,
    ...overrides,
  }
}

describe('resolveFocusManagementToken', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('integração inexistente → available: false, reason: integration_not_found', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusManagementToken(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'integration_not_found' })
  })

  it('integração com status != active → available: false, reason: integration_disabled', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ status: 'pending' }) })

    const result = await resolveFocusManagementToken(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'integration_disabled' })
  })

  it('integração ativa mas sem master_token cadastrado → available: false, reason: master_token_missing', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    const getSecretSpy = vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusManagementToken(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'master_token_missing' })
    expect(getSecretSpy).toHaveBeenCalledWith(1, 1, 'master_token')
  })

  it('integração ativa com master_token cadastrado → available: true, com o token', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: 'master-token-real' })

    const result = await resolveFocusManagementToken(1)
    expect(result.ok).toBe(true)
    if (result.ok && result.data.available) {
      expect(result.data.integration.token).toBe('master-token-real')
      expect(result.data.integration.companyId).toBe(1)
    } else {
      throw new Error('esperava available: true')
    }
  })

  it('nunca lê a chave de emissão (emission_token_*) — só master_token', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    const getSecretSpy = vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: 'master-token-real' })

    await resolveFocusManagementToken(1)
    for (const call of getSecretSpy.mock.calls) {
      expect(call[2]).not.toMatch(/^emission_token_|^api_token$/)
    }
  })

  it('falha ao buscar integração → ServiceOutcome de erro, não lança', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: false, error: 'timeout', status: 500 })

    const result = await resolveFocusManagementToken(1)
    expect(result.ok).toBe(false)
  })

  it('token nunca aparece em nenhum campo fora de integration.token', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusManagementToken(1)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/master-token-real/i)
  })
})
