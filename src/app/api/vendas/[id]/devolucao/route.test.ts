import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as vendasService from '@/services/vendas.service'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 642

function mockAdminAsAdmin() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'user-uuid', role: 'admin', company_id: COMPANY_ID } as any,
    response: null,
  })
}

function mockAdminWithFiscalDocuments(rows: Array<Record<string, unknown>>) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => {
      const filters: Record<string, unknown> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain },
        maybeSingle: async () => {
          const match = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
          return { data: match ?? null, error: null }
        },
      }
      return chain
    },
  } as any)
}

function buildRequest(body: unknown = {}): Request {
  return new Request('http://localhost/api/vendas/642/devolucao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/vendas/[id]/devolucao — fundação homologação↔produção (item 8/9 da auditoria, matriz igual ao /cancelar)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('só NFC-e AUTORIZADA EM HOMOLOGAÇÃO → não bloqueia a devolução', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([
      { id: 1, document_type: 'nfce', number: '12', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'homologacao', status: 'authorized' },
    ])
    vi.spyOn(vendasService, 'returnSale').mockResolvedValue({ ok: true, data: undefined as any })

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(vendasService.returnSale).toHaveBeenCalledOnce()
  })

  it('NFC-e AUTORIZADA EM PRODUÇÃO → bloqueia com 409, nunca chega a chamar returnSale', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([
      { id: 2, document_type: 'nfce', number: '34', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'producao', status: 'authorized' },
    ])
    const returnSpy = vi.spyOn(vendasService, 'returnSale')

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/NFC-e autorizada/)
    expect(returnSpy).not.toHaveBeenCalled()
  })

  it('nenhum documento fiscal → não bloqueia', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([])
    vi.spyOn(vendasService, 'returnSale').mockResolvedValue({ ok: true, data: undefined as any })

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(200)
  })
})
