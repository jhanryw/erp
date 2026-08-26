import { describe, it, expect, vi, afterEach } from 'vitest'
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey } from './checkoutIdempotency'
import { createAdminClient } from '@/lib/supabase/admin'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

function mockClient({ insertError = null as { code?: string; message: string } | null, existingRow = null as any } = {}) {
  const updateSpy = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }))
  ;(createAdminClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      insert: async () => ({ error: insertError }),
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: existingRow, error: null }),
        }),
      }),
      update: updateSpy,
    }),
  })
  return { updateSpy }
}

describe('claimIdempotencyKey', () => {
  afterEach(() => vi.restoreAllMocks())

  it('39. primeira tentativa — INSERT sucede, decisão "claimed"', async () => {
    mockClient()
    const result = await claimIdempotencyKey('key-1', 1, 10)
    expect(result.decision).toBe('claimed')
  })

  it('39. segunda tentativa concorrente com a MESMA chave, primeira já concluída → devolve a venda existente, nunca cria outra', async () => {
    mockClient({ insertError: { code: '23505', message: 'duplicate key' }, existingRow: { status: 'completed', sale_id: 555, error_message: null } })
    const result = await claimIdempotencyKey('key-1', 1, 10)
    expect(result).toEqual({ decision: 'already_completed', saleId: 555 })
  })

  it('segunda tentativa enquanto a primeira ainda está em voo → "already_processing", nunca cria outra venda', async () => {
    mockClient({ insertError: { code: '23505', message: 'duplicate key' }, existingRow: { status: 'processing', sale_id: null, error_message: null } })
    const result = await claimIdempotencyKey('key-1', 1, 10)
    expect(result.decision).toBe('already_processing')
  })

  it('tentativa anterior falhou → "already_failed" com a mensagem, permite ao chamador decidir (ex.: gerar nova chave e tentar de novo)', async () => {
    mockClient({ insertError: { code: '23505', message: 'duplicate key' }, existingRow: { status: 'failed', sale_id: null, error_message: 'Estoque insuficiente' } })
    const result = await claimIdempotencyKey('key-1', 1, 10)
    expect(result).toEqual({ decision: 'already_failed', errorMessage: 'Estoque insuficiente' })
  })
})

describe('completeIdempotencyKey / failIdempotencyKey', () => {
  afterEach(() => vi.restoreAllMocks())

  it('grava sale_id e status completed', async () => {
    const { updateSpy } = mockClient()
    await completeIdempotencyKey('key-1', 555)
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', sale_id: 555 }))
  })

  it('grava status failed com mensagem', async () => {
    const { updateSpy } = mockClient()
    await failIdempotencyKey('key-1', 'Estoque insuficiente')
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error_message: 'Estoque insuficiente' }))
  })
})
