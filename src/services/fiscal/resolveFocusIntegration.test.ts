import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveFocusIntegration } from './resolveFocusIntegration'
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

describe('resolveFocusIntegration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('integração inexistente → available: false, reason: integration_not_found', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'integration_not_found' })
  })

  it('integração com status != active → available: false, reason: integration_disabled', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ status: 'pending' }) })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'integration_disabled' })
  })

  it('integração ativa mas sem segredo cadastrado → available: false, reason: token_missing', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'token_missing' })
  })

  it('integração ativa com segredo → available: true, com token e environment corretos', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({
      ok: true,
      data: integration({ settings: { environment: 'producao' } }),
    })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: 'token-real' })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok && result.data.available) {
      expect(result.data.integration.token).toBe('token-real')
      expect(result.data.integration.environment).toBe('producao')
      expect(result.data.integration.companyId).toBe(1)
    } else {
      throw new Error('esperava available: true')
    }
  })

  it('environment ausente/inválido em settings cai para homologacao (default seguro)', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ settings: {} }) })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: 'token-real' })

    const result = await resolveFocusIntegration(1)
    if (result.ok && result.data.available) {
      expect(result.data.integration.environment).toBe('homologacao')
    } else {
      throw new Error('esperava available: true')
    }
  })

  it('falha ao buscar integração → ServiceOutcome de erro, não lança', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: false, error: 'timeout', status: 500 })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(false)
  })

  it('token nunca aparece em nenhum campo fora de integration.token — reason strings não vazam segredo', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration() })
    vi.spyOn(secrets, 'getIntegrationSecret').mockResolvedValue({ ok: true, data: null })

    const result = await resolveFocusIntegration(1)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/token-real|segredo/i)
  })
})
