import { describe, it, expect, vi, afterEach } from 'vitest'
import * as auth from '@/lib/auth/requireAutomationSecret'
import * as resolver from '@/lib/integrations/chatwoot/resolveCustomerChatwootContext'
import * as logService from '@/services/automations/automation-message-log.service'

afterEach(() => {
  vi.restoreAllMocks()
})

function req(body: unknown) {
  return new Request('https://example.com/api/automations/chatwoot/send', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function mockAuthOk() {
  vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
  vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: true, companyId: 1 })
}

describe('POST /api/automations/chatwoot/send', () => {
  it('secret inválido/ausente → 401, nunca resolve nem envia', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(false)
    const resolveSpy = vi.spyOn(resolver, 'resolveCustomerIdForAutomation')

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi' }))

    expect(response.status).toBe(401)
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it('tenant não configurado → 500', async () => {
    vi.spyOn(auth, 'requireAutomationSecret').mockReturnValue(true)
    vi.spyOn(auth, 'resolveAutomationCompanyId').mockReturnValue({ ok: false, reason: 'missing_config' })

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi' }))

    expect(response.status).toBe(500)
  })

  it('nem customer_id nem phone → 422', async () => {
    mockAuthOk()
    const { POST } = await import('./route')
    const response = await POST(req({ content: 'oi' }))
    expect(response.status).toBe(422)
  })

  it('content vazio → 422 (seção 12 do pedido — nunca envia conteúdo vazio)', async () => {
    mockAuthOk()
    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: '   ' }))
    expect(response.status).toBe(422)
  })

  it('content ausente → 422', async () => {
    mockAuthOk()
    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275 }))
    expect(response.status).toBe(422)
  })

  it('content excede o limite → 422', async () => {
    mockAuthOk()
    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'a'.repeat(4001) }))
    expect(response.status).toBe(422)
  })

  it('cross-tenant: customer_id de outra empresa → customer_not_found (nunca envia), sem tocar Chatwoot', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { outcome: { status: 'customer_not_found' } } } as any)
    const sendSpy = vi.spyOn(resolver, 'sendChatwootMessageToCustomer')
    const claimSpy = vi.spyOn(logService, 'claimAutomationMessage')

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 999999, content: 'oi' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: false, reason: 'customer_not_found' })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(claimSpy).not.toHaveBeenCalled()
  })

  it('idempotency_key duplicada → 200 ok:true idempotent:true, NUNCA chama sendChatwootMessageToCustomer (não reenvia)', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({
      ok: true,
      data: { status: 'duplicate', log: { id: 1, conversation_id: '11', external_message_id: '555' } },
    } as any)
    const sendSpy = vi.spyOn(resolver, 'sendChatwootMessageToCustomer')

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi', idempotency_key: 'post-sale:123:thank-you' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, customer_id: 275, conversation_id: 11, message_id: '555', idempotent: true })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('idempotency_key em processamento concorrente → 409', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'in_progress' } } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi', idempotency_key: 'k' }))

    expect(response.status).toBe(409)
  })

  it('claim ok + envio bem-sucedido → 200 ok:true idempotent:false, marca sent', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'claimed', logId: 10 } } as any)
    vi.spyOn(resolver, 'sendChatwootMessageToCustomer').mockResolvedValue({ ok: true, data: { status: 'sent', customerId: 275, conversationId: 11, messageId: 555 } } as any)
    const markSentSpy = vi.spyOn(logService, 'markAutomationMessageSent').mockResolvedValue({ ok: true, data: undefined } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: true, customer_id: 275, conversation_id: 11, message_id: 555, idempotent: false })
    expect(markSentSpy).toHaveBeenCalledWith({ logId: 10, companyId: 1, conversationId: 11, externalMessageId: '555' })
  })

  it('claim ok + Chatwoot indisponível (503) → marca failed, devolve 503', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'claimed', logId: 10 } } as any)
    vi.spyOn(resolver, 'sendChatwootMessageToCustomer').mockResolvedValue({ ok: true, data: { status: 'chatwoot_unavailable', message: '500', permanent: false } } as any)
    const markFailedSpy = vi.spyOn(logService, 'markAutomationMessageFailed').mockResolvedValue({ ok: true, data: undefined } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi' }))

    expect(response.status).toBe(503)
    expect(markFailedSpy).toHaveBeenCalledWith(expect.objectContaining({ logId: 10, companyId: 1 }))
  })

  it('claim ok + outro desfecho de negócio (ex.: contact_ambiguous) → marca failed, 200 ok:false', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'claimed', logId: 10 } } as any)
    vi.spyOn(resolver, 'sendChatwootMessageToCustomer').mockResolvedValue({ ok: true, data: { status: 'contact_ambiguous' } } as any)
    const markFailedSpy = vi.spyOn(logService, 'markAutomationMessageFailed').mockResolvedValue({ ok: true, data: undefined } as any)

    const { POST } = await import('./route')
    const response = await POST(req({ customer_id: 275, content: 'oi' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ ok: false, reason: 'contact_ambiguous' })
    expect(markFailedSpy).toHaveBeenCalled()
  })

  it('automation_name derivado do prefixo de idempotency_key quando ausente', async () => {
    mockAuthOk()
    vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    const claimSpy = vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'claimed', logId: 10 } } as any)
    vi.spyOn(resolver, 'sendChatwootMessageToCustomer').mockResolvedValue({ ok: true, data: { status: 'sent', customerId: 275, conversationId: 11, messageId: 555 } } as any)
    vi.spyOn(logService, 'markAutomationMessageSent').mockResolvedValue({ ok: true, data: undefined } as any)

    const { POST } = await import('./route')
    await POST(req({ customer_id: 275, content: 'oi', idempotency_key: 'post-sale:123:thank-you' }))

    expect(claimSpy).toHaveBeenCalledWith(expect.objectContaining({ automationName: 'post-sale' }))
  })

  it('company_id/conversation_id/inbox_id no body são ignorados — nunca repassados', async () => {
    mockAuthOk()
    const resolveSpy = vi.spyOn(resolver, 'resolveCustomerIdForAutomation').mockResolvedValue({ ok: true, data: { customerId: 275 } } as any)
    vi.spyOn(logService, 'claimAutomationMessage').mockResolvedValue({ ok: true, data: { status: 'claimed', logId: 10 } } as any)
    vi.spyOn(resolver, 'sendChatwootMessageToCustomer').mockResolvedValue({ ok: true, data: { status: 'sent', customerId: 275, conversationId: 11, messageId: 555 } } as any)
    vi.spyOn(logService, 'markAutomationMessageSent').mockResolvedValue({ ok: true, data: undefined } as any)

    const { POST } = await import('./route')
    await POST(req({ customer_id: 275, content: 'oi', company_id: 999, conversation_id: 42, inbox_id: 42 }))

    expect(resolveSpy).toHaveBeenCalledWith(1, { customerId: 275, phone: undefined })
  })
})
