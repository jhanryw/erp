// Conferência cega (auditoria + correção 2026-09-10): rpc_close_cash_session
// agora decide, dentro do banco, se fecha ou não. Este teste cobre a
// tradução dessa decisão pro discriminated union CloseSessionOutcome —
// não prova a comparação financeira em si (isso é SQL puro, verificado por
// leitura de código + supabase/tests/*.test.sql), só que o service repassa
// 'mismatch' e 'closed' corretamente e nunca inventa dados.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { closeCashSession } from './caixa.service'
import * as adminModule from '@/lib/supabase/admin'

function mockRpc(data: unknown, error: { code: string; message: string } | null = null) {
  const rpcSpy = vi.fn().mockResolvedValue({ data, error })
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({ rpc: rpcSpy } as any)
  return rpcSpy
}

describe('closeCashSession', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('propaga status="mismatch" sem nenhum campo numérico quando a RPC recusa fechar', async () => {
    const rpcSpy = mockRpc({ status: 'mismatch', id: 42 })

    const result = await closeCashSession(42, 'user-1', 100)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data).toEqual({ status: 'mismatch' })
    // Nada de expected_cash/cash_difference vazando pro chamador mesmo que
    // a RPC (hipoteticamente, por bug futuro) devolvesse campos extras.
    expect(JSON.stringify(result.data)).not.toMatch(/expected_cash|cash_difference/)
    expect(rpcSpy).toHaveBeenCalledWith('rpc_close_cash_session', {
      p_session_id: 42, p_user_id: 'user-1', p_counted_cash: 100, p_notes: null,
    })
  })

  it('propaga status="closed" com os dados contábeis completos quando a RPC fecha', async () => {
    const rpcPayload = {
      status: 'closed', id: 7, closed_at: '2026-09-10T12:00:00Z',
      total_sales: 500, total_cash: 200, total_pix: 300, total_credit_card: 0,
      total_debit_card: 0, total_card_fees: 0, total_cash_change: 0, total_pix_change: 0,
      total_sangria: 0, total_suprimento: 0, total_expenses: 0,
      expected_cash: 200, counted_cash: 200, cash_difference: 0,
    }
    mockRpc(rpcPayload)

    const result = await closeCashSession(7, 'user-1', 200, 'observação')

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.status).toBe('closed')
    if (result.data.status !== 'closed') throw new Error('unreachable')
    expect(result.data.result.expected_cash).toBe(200)
    expect(result.data.result.cash_difference).toBe(0)
  })

  it('propaga erro da RPC como falha (ex.: sessão já fechada) sem tentar interpretar como mismatch', async () => {
    mockRpc(null, { code: 'P0001', message: 'Caixa já fechado.' })

    const result = await closeCashSession(7, 'user-1', 200)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(400)
    expect(result.error).toBe('Caixa já fechado.')
  })
})
