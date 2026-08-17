import { describe, it, expect, vi, afterEach } from 'vitest'
import * as auth from '@/lib/auth/requireAutomationSecret'
import * as resolver from '@/lib/integrations/chatwoot/resolveCustomerChatwootContext'

afterEach(() => {
  vi.restoreAllMocks()
})

function req(body: unknown) {
  return new Request('https://example.com/api/automations/chatwoot/resolve', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/automations/chatwoot/resolve', () => {
  it('secret inválido/ausente → 401, nunca chama o resolver', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(false)
    const resolveSpy = vi.spyOn(resolver, 'resolveCustomerChatwootContext')

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(401)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('tenant não configurado → 500, nunca chama o resolver', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: false, reason: 'missing_config' })
    const resolveSpy = vi.spyOn(resolver, 'resolveCustomerChatwootContext')

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(500)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('nem customer_id nem phone → 422', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })

    const { POST } = await import('./route')
    const response = await POST(req({}))

    expect(response.status).toBe(422)
  })

  it('company_id no body é ignorado — nunca repassado ao resolver', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    const resolveSpy = vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: 'resolved', customerId: 275, contactId: 2, conversationId: 11, inboxId: 7 } } as any)

    const { POST } = await import('./route')
    await POST(req({ customer_id: 275, company_id: 999 }))

    expect(resolveSpy).toHaveBeenCalledWith(1, { customerId: 275, phone: undefined })
  })

  it('resolvido → 200 ok:true com os 4 ids', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: 'resolved', customerId: 275, contactId: 2, conversationId: 11, inboxId: 7 } } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, customer_id: 275, contact_id: 2, conversation_id: 11, inbox_id: 7 })
  })

  it.each(['customer_not_found', 'ambiguous_customer', 'anonymous_customer', 'customer_missing_phone', 'contact_ambiguous'])(
    'desfecho de negócio %s → 200 ok:false',
    async (reason) => {
      vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
      vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
      vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: reason } } as any)

      const { POST } = await import('./route')
      const response = await POST(req({ customer_id: 275 }))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({ ok: false, reason })
    },
  )

  it('chatwoot_not_configured → 200 ok:false (config ausente é esperado, não erro)', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: 'chatwoot_not_configured', message: 'sem integração' } } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false, reason: 'chatwoot_not_configured' })
  })

  it('chatwoot_unavailable retryable → 503 com Retry-After', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: 'chatwoot_unavailable', message: '429', permanent: false, retryAfterSeconds: 30 } } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('30')
    expect(await response.json()).toEqual({ ok: false, reason: 'chatwoot_unavailable' })
  })

  it('chatwoot_unavailable permanente (401/config) → 502', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: true, data: { status: 'chatwoot_unavailable', message: '401', permanent: true } } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(502)
  })

  it('erro interno do resolver → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
    vi.spyOn(resolver, 'resolveCustomerChatwootContext').mockResolvedValue({ ok: false, error: 'DB fora do ar', status: 500 } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))

    expect(response.status).toBe(500)
  })
})
