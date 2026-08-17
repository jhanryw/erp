import { describe, it, expect, vi, afterEach } from 'vitest'
import * as adminModule from '@/lib/supabase/admin'
import { claimAutomationMessage, markAutomationMessageSent, markAutomationMessageFailed } from './automation-message-log.service'

const COMPANY_ID = 1

interface MockState {
  insertError?: { code?: string; message: string } | null
  insertedRow?: any
  existingRow?: any
  updateResult?: any
}

function mockAdmin(state: MockState) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => (state.insertError ? { data: null, error: state.insertError } : { data: state.insertedRow, error: null }),
        }),
      }),
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.existingRow ?? null, error: null }),
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              single: async () => ({ data: { ...state.existingRow, ...patch }, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as any)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('claimAutomationMessage', () => {
  it('sem idempotency_key → sempre insere uma nova linha (claimed)', async () => {
    mockAdmin({ insertedRow: { id: 1 } })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275 })
    expect(result).toEqual({ ok: true, data: { status: 'claimed', logId: 1 } })
  })

  it('idempotency_key nova → insere e reivindica (claimed)', async () => {
    mockAdmin({ insertedRow: { id: 2 } })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275, idempotencyKey: 'post-sale:123:thank-you' })
    expect(result).toEqual({ ok: true, data: { status: 'claimed', logId: 2 } })
  })

  it('idempotency_key já usada com result=sent → duplicate, NUNCA permite reenvio', async () => {
    mockAdmin({
      insertError: { code: '23505', message: 'duplicate key' },
      existingRow: { id: 3, company_id: COMPANY_ID, idempotency_key: 'post-sale:123:thank-you', result: 'sent', conversation_id: '11', external_message_id: '555' },
    })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275, idempotencyKey: 'post-sale:123:thank-you' })
    expect(result.ok && result.data.status).toBe('duplicate')
    expect(result.ok && result.data.status === 'duplicate' && result.data.log.external_message_id).toBe('555')
  })

  it('idempotency_key com result=pending (concorrente) → in_progress', async () => {
    mockAdmin({
      insertError: { code: '23505', message: 'duplicate key' },
      existingRow: { id: 4, company_id: COMPANY_ID, idempotency_key: 'k', result: 'pending' },
    })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275, idempotencyKey: 'k' })
    expect(result).toEqual({ ok: true, data: { status: 'in_progress' } })
  })

  it('idempotency_key com result=failed → permite retry reaproveitando a mesma linha (claimed)', async () => {
    mockAdmin({
      insertError: { code: '23505', message: 'duplicate key' },
      existingRow: { id: 5, company_id: COMPANY_ID, idempotency_key: 'k', result: 'failed' },
    })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275, idempotencyKey: 'k' })
    expect(result).toEqual({ ok: true, data: { status: 'claimed', logId: 5 } })
  })

  it('erro de infra (não 23505) → falha, nunca confunde com corrida de idempotência', async () => {
    mockAdmin({ insertError: { message: 'conexão perdida' } })
    const result = await claimAutomationMessage({ companyId: COMPANY_ID, automationName: 'post-sale', customerId: 275, idempotencyKey: 'k' })
    expect(result.ok).toBe(false)
  })
})

describe('markAutomationMessageSent / markAutomationMessageFailed', () => {
  it('markAutomationMessageSent grava conversation_id/external_message_id', async () => {
    mockAdmin({ existingRow: { id: 1 } })
    const result = await markAutomationMessageSent({ logId: 1, companyId: COMPANY_ID, conversationId: 11, externalMessageId: '555' })
    expect(result).toEqual({ ok: true, data: undefined })
  })

  it('markAutomationMessageFailed grava error_message', async () => {
    mockAdmin({ existingRow: { id: 1 } })
    const result = await markAutomationMessageFailed({ logId: 1, companyId: COMPANY_ID, errorMessage: 'Chatwoot indisponível' })
    expect(result).toEqual({ ok: true, data: undefined })
  })
})
