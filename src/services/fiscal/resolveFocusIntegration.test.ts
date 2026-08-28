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

  it('homologação sem emission_token_homologacao → cai pro legado api_token (compatibilidade)', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ settings: { environment: 'homologacao' } }) })
    vi.spyOn(secrets, 'getIntegrationSecret').mockImplementation(async (_id, _cid, key) => {
      if (key === 'emission_token_homologacao') return { ok: true, data: null }
      if (key === 'api_token') return { ok: true, data: 'token-legado-homolog' }
      throw new Error(`chave inesperada: ${key}`)
    })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok && result.data.available) {
      expect(result.data.integration.token).toBe('token-legado-homolog')
      expect(result.data.integration.environment).toBe('homologacao')
    } else {
      throw new Error('esperava available: true')
    }
  })

  it('homologação com emission_token_homologacao presente → usa o token específico, nunca consulta o legado', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ settings: { environment: 'homologacao' } }) })
    const getSecretSpy = vi.spyOn(secrets, 'getIntegrationSecret').mockImplementation(async (_id, _cid, key) => {
      if (key === 'emission_token_homologacao') return { ok: true, data: 'token-especifico-homolog' }
      if (key === 'api_token') return { ok: true, data: 'token-legado-nunca-deveria-ser-usado' }
      throw new Error(`chave inesperada: ${key}`)
    })

    const result = await resolveFocusIntegration(1)
    if (result.ok && result.data.available) {
      expect(result.data.integration.token).toBe('token-especifico-homolog')
    } else {
      throw new Error('esperava available: true')
    }
    expect(getSecretSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'api_token')
  })

  it('REGRA DE SEGURANÇA: produção sem emission_token_producao → NUNCA cai pro api_token legado, retorna production_token_missing', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ settings: { environment: 'producao' } }) })
    const getSecretSpy = vi.spyOn(secrets, 'getIntegrationSecret').mockImplementation(async (_id, _cid, key) => {
      if (key === 'emission_token_producao') return { ok: true, data: null }
      if (key === 'api_token') return { ok: true, data: 'token-legado-homolog-JAMAIS-usar-em-producao' }
      throw new Error(`chave inesperada: ${key}`)
    })

    const result = await resolveFocusIntegration(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ available: false, reason: 'production_token_missing' })
    // nunca consulta o secret legado em produção — nem pra checar se existe
    expect(getSecretSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'api_token')
  })

  it('produção com emission_token_producao presente → usa o token específico de produção', async () => {
    vi.spyOn(companyIntegrations, 'getCompanyIntegration').mockResolvedValue({ ok: true, data: integration({ settings: { environment: 'producao' } }) })
    vi.spyOn(secrets, 'getIntegrationSecret').mockImplementation(async (_id, _cid, key) => {
      if (key === 'emission_token_producao') return { ok: true, data: 'token-especifico-producao' }
      throw new Error(`chave inesperada: ${key}`)
    })

    const result = await resolveFocusIntegration(1)
    if (result.ok && result.data.available) {
      expect(result.data.integration.token).toBe('token-especifico-producao')
      expect(result.data.integration.environment).toBe('producao')
    } else {
      throw new Error('esperava available: true')
    }
  })
})
