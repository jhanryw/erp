import { describe, it, expect, afterEach } from 'vitest'
import { checkAutomationSecret, requireAutomationSecret, resolveAutomationCompanyId, QARVON_AUTOMATION_SECRET_ENV_VAR } from './requireAutomationSecret'

const ORIGINAL_ENV = { ...process.env }

function requestWithAuth(authHeader?: string): Request {
  const headers = new Headers()
  if (authHeader !== undefined) headers.set('Authorization', authHeader)
  return new Request('https://example.com/api/automations/test', { headers })
}

describe('checkAutomationSecret / requireAutomationSecret (Fase N0)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('secret correto → ok', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    const result = checkAutomationSecret(requestWithAuth('Bearer super-secreto'))
    expect(result).toEqual({ ok: true })
    expect(requireAutomationSecret(requestWithAuth('Bearer super-secreto'))).toBe(true)
  })

  it('env var ausente → missing_secret_env, nunca autoriza mesmo sem header', () => {
    delete process.env[QARVON_AUTOMATION_SECRET_ENV_VAR]
    const result = checkAutomationSecret(requestWithAuth('Bearer qualquer-coisa'))
    expect(result).toEqual({ ok: false, reason: 'missing_secret_env' })
  })

  it('header Authorization ausente → missing_header', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    const result = checkAutomationSecret(requestWithAuth())
    expect(result).toEqual({ ok: false, reason: 'missing_header' })
  })

  it('secret errado (mesmo tamanho) → mismatch', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    const result = checkAutomationSecret(requestWithAuth('Bearer super-secreta'))
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('secret errado (tamanho diferente) → mismatch, nunca lança', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    const result = checkAutomationSecret(requestWithAuth('Bearer curto'))
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('formato sem "Bearer " → mismatch (nunca aceita token cru)', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    const result = checkAutomationSecret(requestWithAuth('super-secreto'))
    expect(result).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('nome de env var alternativo (reaproveitamento futuro pra migração) — só valida a variável informada', () => {
    process.env.OUTRA_VARIAVEL_QUALQUER = 'segredo-legado'
    const result = checkAutomationSecret(requestWithAuth('Bearer segredo-legado'), 'OUTRA_VARIAVEL_QUALQUER')
    expect(result).toEqual({ ok: true })
  })

  it('nunca lança exceção mesmo com header malformado', () => {
    process.env[QARVON_AUTOMATION_SECRET_ENV_VAR] = 'super-secreto'
    expect(() => checkAutomationSecret(requestWithAuth(''))).not.toThrow()
  })
})

describe('resolveAutomationCompanyId (Fase N1) — company_id nunca vem do request', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('configurado corretamente → ok com o número', () => {
    process.env.QARVON_AUTOMATION_COMPANY_ID = '1'
    expect(resolveAutomationCompanyId()).toEqual({ ok: true, companyId: 1 })
  })

  it('ausente → missing_config', () => {
    delete process.env.QARVON_AUTOMATION_COMPANY_ID
    expect(resolveAutomationCompanyId()).toEqual({ ok: false, reason: 'missing_config' })
  })

  it('não-numérico → invalid_config', () => {
    process.env.QARVON_AUTOMATION_COMPANY_ID = 'abc'
    expect(resolveAutomationCompanyId()).toEqual({ ok: false, reason: 'invalid_config' })
  })

  it('zero ou negativo → invalid_config', () => {
    process.env.QARVON_AUTOMATION_COMPANY_ID = '0'
    expect(resolveAutomationCompanyId()).toEqual({ ok: false, reason: 'invalid_config' })
    process.env.QARVON_AUTOMATION_COMPANY_ID = '-1'
    expect(resolveAutomationCompanyId()).toEqual({ ok: false, reason: 'invalid_config' })
  })

  it('decimal → invalid_config (company_id é sempre inteiro)', () => {
    process.env.QARVON_AUTOMATION_COMPANY_ID = '1.5'
    expect(resolveAutomationCompanyId()).toEqual({ ok: false, reason: 'invalid_config' })
  })
})
