// Regressão — auditoria de acesso fiscal: operação fiscal de uma venda
// (emitir/consultar/DANFE/XML) nunca foi pra ser admin-only. Esta rota
// passa a aceitar qualquer usuário autenticado da empresa
// (requireRole('usuario')), mantendo isolamento multi-tenant real:
// company_id sempre vem da sessão (user.company_id), nunca do corpo da
// requisição, e a venda só é encontrada se pertencer à MESMA empresa.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as submitModule from '@/services/fiscal/submitNfceHomologacao'
import * as resolveTypeModule from '@/lib/fiscal/resolveFiscalDocumentType'

function mockSession(role: 'admin' | 'gerente' | 'usuario', companyId: number | null = 1) {
  vi.spyOn(sessionModule, 'requireRole').mockImplementation(async (minRole: any) => {
    const hierarchy: Record<string, number> = { admin: 3, gerente: 2, usuario: 1 }
    if (hierarchy[role] < hierarchy[minRole]) {
      return { user: null as any, response: new Response(JSON.stringify({ error: 'Acesso negado. Permissão insuficiente.' }), { status: 403 }) as any }
    }
    return { user: { id: 'user-uuid', role, company_id: companyId } as any, response: null }
  })
}

function mockSaleLookup(saleRow: Record<string, unknown> | null) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: table === 'sales' ? saleRow : null, error: null }) }),
          maybeSingle: async () => ({ data: table === 'shipments' ? null : saleRow, error: null }),
        }),
      }),
    }),
  } as any)
}

function buildRequest(body: unknown): Request {
  return new Request('http://localhost/api/fiscal/nfce/emitir-homologacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/fiscal/nfce/emitir-homologacao — acesso liberado pra qualquer usuário autenticado da empresa', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('role=usuario (seller) → passa pelo gate, nunca mais 403 só por role', async () => {
    mockSession('usuario', 1)
    mockSaleLookup({ id: 42, sale_origin: 'store' })
    vi.spyOn(resolveTypeModule, 'resolveFiscalDocumentType').mockReturnValue('nfce')
    const submitSpy = vi.spyOn(submitModule, 'submitNfceHomologacao').mockResolvedValue({
      ok: true, data: { status: 'authorized' } as any,
    })

    const res = await POST(buildRequest({ sale_id: 42 }))
    expect(res.status).toBe(200)
    expect(submitSpy).toHaveBeenCalledWith(42, 1)
  })

  it('role=admin → continua funcionando normalmente (sem regressão)', async () => {
    mockSession('admin', 1)
    mockSaleLookup({ id: 42, sale_origin: 'store' })
    vi.spyOn(resolveTypeModule, 'resolveFiscalDocumentType').mockReturnValue('nfce')
    vi.spyOn(submitModule, 'submitNfceHomologacao').mockResolvedValue({ ok: true, data: { status: 'authorized' } as any })

    const res = await POST(buildRequest({ sale_id: 42 }))
    expect(res.status).toBe(200)
  })

  it('venda pertence a OUTRA empresa → 404, nunca chega a chamar submitNfceHomologacao (isolamento nunca depende de role)', async () => {
    mockSession('usuario', 1) // sessão é da empresa 1
    mockSaleLookup(null) // a query já filtra por company_id=1 — venda de outra empresa nunca aparece aqui
    const submitSpy = vi.spyOn(submitModule, 'submitNfceHomologacao')

    const res = await POST(buildRequest({ sale_id: 999 })) // sale_id de uma venda que existe, só que da empresa 2
    expect(res.status).toBe(404)
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('sem sessão/role insuficiente (nenhum role autenticado) → 403, nunca chama submitNfceHomologacao', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const submitSpy = vi.spyOn(submitModule, 'submitNfceHomologacao')

    const res = await POST(buildRequest({ sale_id: 42 }))
    expect(res.status).toBe(401)
    expect(submitSpy).not.toHaveBeenCalled()
  })
})
