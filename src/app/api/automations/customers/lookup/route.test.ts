import { describe, it, expect, vi, afterEach } from 'vitest'
import { classifyLookupMatches } from './classifyLookupMatches'
import * as auth from '@/lib/auth/requireAutomationSecret'
import * as adminModule from '@/lib/supabase/admin'

// ─── classifyLookupMatches — pura, cobre a essência da seção 5-8 do pedido ────

describe('classifyLookupMatches', () => {
  it('nenhum match → not_found', () => {
    expect(classifyLookupMatches([])).toEqual({ found: false, reason: 'not_found' })
  })

  it('exatamente 1 match → found com customer_id/name/phone_e164', () => {
    expect(classifyLookupMatches([{ id: 275, name: 'Fulana', phone_e164: '5584999999999' }])).toEqual({
      found: true,
      customer_id: 275,
      name: 'Fulana',
      phone_e164: '5584999999999',
    })
  })

  it('2+ matches → ambiguous, NUNCA escolhe um nem devolve a lista (seção 7 do pedido)', () => {
    const result = classifyLookupMatches([
      { id: 1, name: 'A', phone_e164: '5584999999999' },
      { id: 2, name: 'B', phone_e164: '5584999999999' },
    ])
    expect(result).toEqual({ found: false, reason: 'ambiguous' })
    expect(JSON.stringify(result)).not.toContain('"id"') // nunca vaza os customer_ids em disputa
  })
})

// ─── Rota — auth/tenant short-circuit, sem tocar banco ────────────────────────

function makeQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

function mockAdminReturning(data: unknown, error: unknown = null) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => makeQueryBuilder({ data, error }),
  } as any)
}

describe('GET /api/automations/customers/lookup — auth e tenant (seções 2-3, obrigatório na seção 16)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('secret inválido/ausente → 401, nunca chega a consultar o banco', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(false)
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=84999999999'))

    expect(response.status).toBe(401)
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('tenant não configurado → 500, nunca consulta o banco (nunca finge sucesso)', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: false, reason: 'missing_config' })
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=84999999999'))

    expect(response.status).toBe(500)
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('phone ausente → 422', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup'))

    expect(response.status).toBe(422)
  })

  it('telefone com máscara/espaços/DDI → normaliza (reaproveita normalizeE164BR da Fase 1) e consulta phone_e164', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminReturning([{ id: 275, name: 'Fulana', phone_e164: '5584999999999' }])

    const { GET } = await import('./route')
    for (const raw of ['(84) 99999-9999', '+5584999999999', '5584999999999', '84999999999']) {
      const response = await GET(new Request(`https://example.com/api/automations/customers/lookup?phone=${encodeURIComponent(raw)}`))
      const body = await response.json()
      expect(body).toEqual({ found: true, customer_id: 275, name: 'Fulana', phone_e164: '5584999999999' })
    }
  })

  it('telefone não-normalizável → 200 found:false reason:invalid_phone, nunca consulta o banco', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    const adminSpy = vi.spyOn(adminModule, 'createAdminClient')

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=123'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ found: false, reason: 'invalid_phone' })
    expect(adminSpy).not.toHaveBeenCalled()
  })

  it('telefone inexistente na base → 200 found:false reason:not_found', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminReturning([])

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=84999999999'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ found: false, reason: 'not_found' })
  })

  it('telefone ambíguo (2+ customers) → 200 found:false reason:ambiguous, nunca vaza IDs', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminReturning([
      { id: 1, name: 'A', phone_e164: '5584999999999' },
      { id: 2, name: 'B', phone_e164: '5584999999999' },
    ])

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=84999999999'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ found: false, reason: 'ambiguous' })
  })

  it('erro de consulta no banco → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    mockAdminReturning(null, { message: 'conexão perdida' })

    const { GET } = await import('./route')
    const response = await GET(new Request('https://example.com/api/automations/customers/lookup?phone=84999999999'))

    expect(response.status).toBe(500)
  })
})
