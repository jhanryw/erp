// Regressão — auditoria de acesso fiscal: "Verificar status"/reconciliação
// de venda nunca foi pra ser admin-only. Isolamento garantido dentro de
// consultNfeStatus (sempre escopado por user.company_id).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as consultModule from '@/services/fiscal/consultNfeStatus'

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
  return new Request('http://localhost/api/fiscal/nfe/consultar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/fiscal/nfe/consultar — acesso liberado pra qualquer usuário autenticado da empresa', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('role=usuario (seller) → passa pelo gate, company_id sempre da sessão', async () => {
    mockSession('usuario', 1)
    const consultSpy = vi.spyOn(consultModule, 'consultNfeStatus').mockResolvedValue({ ok: true, data: { status: 'authorized' } as any })

    const res = await POST(buildRequest({ sale_id: 42, company_id: 999 }))
    expect(res.status).toBe(200)
    expect(consultSpy).toHaveBeenCalledWith(42, 1)
  })

  it('role=admin → continua funcionando normalmente', async () => {
    mockSession('admin', 1)
    vi.spyOn(consultModule, 'consultNfeStatus').mockResolvedValue({ ok: true, data: { status: 'authorized' } as any })

    const res = await POST(buildRequest({ sale_id: 42 }))
    expect(res.status).toBe(200)
  })

  it('venda de outra empresa → consultNfeStatus devolve erro, rota nunca vaza sucesso', async () => {
    mockSession('usuario', 1)
    vi.spyOn(consultModule, 'consultNfeStatus').mockResolvedValue({ ok: false, error: 'Nenhuma tentativa de emissão de NF-e encontrada pra esta venda.', status: 404 })

    const res = await POST(buildRequest({ sale_id: 999 }))
    expect(res.status).toBe(404)
  })

  it('sem sessão/role insuficiente → 403, nunca chama consultNfeStatus', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const consultSpy = vi.spyOn(consultModule, 'consultNfeStatus')

    const res = await POST(buildRequest({ sale_id: 42 }))
    expect(res.status).toBe(401)
    expect(consultSpy).not.toHaveBeenCalled()
  })
})
