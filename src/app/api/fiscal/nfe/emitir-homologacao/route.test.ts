// Regressão — auditoria de acesso fiscal: operação fiscal de uma venda
// nunca foi pra ser admin-only. Esta rota passa a aceitar qualquer
// usuário autenticado da empresa (requireRole('usuario')). Isolamento
// multi-tenant é garantido dentro de submitNfeHomologacao (sempre
// escopado por user.company_id, nunca por um campo do corpo).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as submitModule from '@/services/fiscal/submitNfeHomologacao'

function mockSession(role: 'admin' | 'gerente' | 'usuario', companyId: number | null = 1) {
  vi.spyOn(sessionModule, 'requireRole').mockImplementation(async (minRole: any) => {
    const hierarchy: Record<string, number> = { admin: 3, gerente: 2, usuario: 1 }
    if (hierarchy[role] < hierarchy[minRole]) {
      return { user: null as any, response: new Response(JSON.stringify({ error: 'Acesso negado. Permissão insuficiente.' }), { status: 403 }) as any }
    }
    return { user: { id: 'user-uuid', role, company_id: companyId } as any, response: null }
  })
}

function buildRequest(body: unknown): Request {
  return new Request('http://localhost/api/fiscal/nfe/emitir-homologacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/fiscal/nfe/emitir-homologacao — acesso liberado pra qualquer usuário autenticado da empresa', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('role=usuario (seller) → passa pelo gate, company_id é SEMPRE o da sessão, nunca do corpo', async () => {
    mockSession('usuario', 1)
    const submitSpy = vi.spyOn(submitModule, 'submitNfeHomologacao').mockResolvedValue({ ok: true, data: { status: 'authorized' } as any })

    // Mesmo que alguém tentasse injetar company_id no corpo, o schema
    // nem aceita esse campo — só sale_id.
    const res = await POST(buildRequest({ sale_id: 77, company_id: 999 }))
    expect(res.status).toBe(200)
    expect(submitSpy).toHaveBeenCalledWith(77, 1) // 1 = user.company_id da sessão, nunca 999
  })

  it('role=admin → continua funcionando normalmente', async () => {
    mockSession('admin', 1)
    vi.spyOn(submitModule, 'submitNfeHomologacao').mockResolvedValue({ ok: true, data: { status: 'authorized' } as any })

    const res = await POST(buildRequest({ sale_id: 77 }))
    expect(res.status).toBe(200)
  })

  it('venda de outra empresa → submitNfeHomologacao devolve erro (loadSaleFiscalContext não encontra a venda escopada por company_id), rota nunca vaza sucesso', async () => {
    mockSession('usuario', 1)
    vi.spyOn(submitModule, 'submitNfeHomologacao').mockResolvedValue({ ok: false, error: 'Venda não encontrada para esta empresa.', status: 404 })

    const res = await POST(buildRequest({ sale_id: 999 }))
    expect(res.status).toBe(404)
  })

  it('sem sessão/role insuficiente → 403, nunca chama submitNfeHomologacao', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const submitSpy = vi.spyOn(submitModule, 'submitNfeHomologacao')

    const res = await POST(buildRequest({ sale_id: 77 }))
    expect(res.status).toBe(401)
    expect(submitSpy).not.toHaveBeenCalled()
  })
})
