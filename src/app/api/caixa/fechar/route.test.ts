// Conferência cega (auditoria + correção 2026-09-10):
//   - GET (prévia de expected_cash) passa a exigir gerente/admin — usuario/
//     seller nunca teve motivo pra continuar vendo isso, já que fecha às
//     cegas.
//   - POST não deve mais devolver expected_cash/cash_difference pro seller,
//     nem em sucesso nem em divergência — e divergência não pode fechar a
//     sessão (isso é responsabilidade do service/RPC; aqui só confirmamos
//     que a rota repassa a decisão corretamente e filtra a resposta).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GET, POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as caixaService from '@/services/caixa.service'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

function mockSession(role: 'admin' | 'gerente' | 'usuario', userId = 'user-1', companyId: number | null = 1) {
  vi.spyOn(sessionModule, 'requireRole').mockImplementation(async (minRole: any) => {
    const hierarchy: Record<string, number> = { admin: 3, gerente: 2, usuario: 1 }
    if (hierarchy[role] < hierarchy[minRole]) {
      return {
        user: null as any,
        response: new Response(JSON.stringify({ error: 'Acesso negado. Permissão insuficiente.' }), { status: 403 }) as any,
      }
    }
    return { user: { id: userId, role, company_id: companyId } as any, response: null }
  })
}

function buildPostRequest(body: unknown): Request {
  return new Request('http://localhost/api/caixa/fechar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /api/caixa/fechar — prévia restrita a gerente/admin', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('usuario/seller recebe 403 — não tem mais acesso à prévia do valor esperado', async () => {
    mockSession('usuario')
    const res = await GET(new Request('http://localhost/api/caixa/fechar?session_id=1'))
    expect(res.status).toBe(403)
  })

  it('gerente recebe o expected_cash normalmente', async () => {
    mockSession('gerente')
    vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
      from: (table: string) => {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          is: () => chain,
          not: () => chain,
          maybeSingle: async () => {
            if (table === 'cash_register_sessions') {
              return { data: { opening_amount_cash: 100, company_id: 1 }, error: null }
            }
            return { data: null, error: null }
          },
          then: (resolve: any) => resolve({ data: [], error: null }),
        }
        return chain
      },
    } as any)

    const res = await GET(new Request('http://localhost/api/caixa/fechar?session_id=1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(typeof json.expected_cash).toBe('number')
  })
})

describe('POST /api/caixa/fechar — conferência cega', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('usuario/seller consegue tentar fechar sem qualquer senha administrativa (só requireRole("usuario"))', async () => {
    mockSession('usuario')
    vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({ ok: true, data: { status: 'mismatch' } })

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 90 }))
    expect(res.status).toBe(200) // nunca 401/403 por falta de senha — não existe esse gate
  })

  it('divergência: não fecha, resposta neutra, sem expected_cash/cash_difference em lugar nenhum', async () => {
    mockSession('usuario')
    const closeSpy = vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({ ok: true, data: { status: 'mismatch' } })

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 90 }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.mismatch).toBe(true)
    expect(json.message).toBe('O valor informado não corresponde ao caixa. Faça uma nova contagem e tente novamente.')
    expect(json.summary).toBeUndefined()
    const raw = JSON.stringify(json)
    expect(raw).not.toMatch(/expected_cash|cash_difference|difference|falta|sobra/i)
    expect(closeSpy).toHaveBeenCalledWith(1, 'user-1', 90, null)
  })

  it('divergência não varia a mensagem com a magnitude do erro (mesma resposta pra R$1 ou R$1000 de diferença)', async () => {
    mockSession('usuario')
    vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({ ok: true, data: { status: 'mismatch' } })

    const res1 = await POST(buildPostRequest({ session_id: 1, counted_cash: 99 }))
    const res2 = await POST(buildPostRequest({ session_id: 1, counted_cash: 5000 }))
    const json1 = await res1.json()
    const json2 = await res2.json()

    expect(json1).toEqual(json2)
  })

  it('sucesso: usuario/seller fecha sem senha e a resposta NÃO contém expected_cash nem cash_difference', async () => {
    mockSession('usuario')
    vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({
      ok: true,
      data: {
        status: 'closed',
        result: {
          id: 1, status: 'closed', closed_at: '2026-09-10T12:00:00Z',
          total_sales: 100, total_cash: 100, total_pix: 0, total_credit_card: 0,
          total_debit_card: 0, total_card_fees: 0, total_cash_change: 0, total_pix_change: 0,
          total_sangria: 0, total_suprimento: 0, total_expenses: 0,
          expected_cash: 100, counted_cash: 100, cash_difference: 0,
        },
      },
    })

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 100 }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.summary).toBeDefined()
    expect(json.summary.counted_cash).toBe(100)
    expect(json.summary.expected_cash).toBeUndefined()
    expect(json.summary.cash_difference).toBeUndefined()
    expect(JSON.stringify(json)).not.toMatch(/expected_cash|cash_difference/)
  })

  it('sucesso: gerente/admin continuam recebendo expected_cash e cash_difference (não degradar a experiência gerencial)', async () => {
    mockSession('gerente')
    vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({
      ok: true,
      data: {
        status: 'closed',
        result: {
          id: 1, status: 'closed', closed_at: '2026-09-10T12:00:00Z',
          total_sales: 100, total_cash: 100, total_pix: 0, total_credit_card: 0,
          total_debit_card: 0, total_card_fees: 0, total_cash_change: 0, total_pix_change: 0,
          total_sangria: 0, total_suprimento: 0, total_expenses: 0,
          expected_cash: 100, counted_cash: 100, cash_difference: 0,
        },
      },
    })

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 100 }))
    const json = await res.json()

    expect(json.summary.expected_cash).toBe(100)
    expect(json.summary.cash_difference).toBe(0)
  })

  it('erro do service (ex.: sessão já fechada) é repassado como erro, não como mismatch', async () => {
    mockSession('usuario')
    vi.spyOn(caixaService, 'closeCashSession').mockResolvedValue({ ok: false, error: 'Caixa já fechado.', status: 400 })

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 100 }))
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toBe('Caixa já fechado.')
    expect(json.mismatch).toBeUndefined()
  })

  it('usuário sem empresa vinculada → 403 antes de chamar o service', async () => {
    mockSession('usuario', 'user-1', null)
    const closeSpy = vi.spyOn(caixaService, 'closeCashSession')

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 100 }))
    expect(res.status).toBe(403)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('corpo inválido → 422, sem chamar o service', async () => {
    mockSession('usuario')
    const closeSpy = vi.spyOn(caixaService, 'closeCashSession')

    const res = await POST(buildPostRequest({ session_id: -1, counted_cash: -5 }))
    expect(res.status).toBe(422)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('sem sessão → requireRole barra com 401, sem tocar no service', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const closeSpy = vi.spyOn(caixaService, 'closeCashSession')

    const res = await POST(buildPostRequest({ session_id: 1, counted_cash: 100 }))
    expect(res.status).toBe(401)
    expect(closeSpy).not.toHaveBeenCalled()
  })
})
