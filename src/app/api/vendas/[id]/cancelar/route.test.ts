import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as vendasService from '@/services/vendas.service'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/services/nuvemshopSyncService', () => ({ pushMultipleVariantStocksToNuvemshop: vi.fn().mockResolvedValue(undefined) }))

const COMPANY_ID = 1
const SALE_ID = 642

function mockAdminAsAdmin() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'user-uuid', role: 'admin', company_id: COMPANY_ID } as any,
    response: null,
  })
}

/** Fiscal_documents com exatamente as linhas informadas; sale_items sempre vazio (não é o foco deste teste). */
function mockAdminWithFiscalDocuments(rows: Array<Record<string, unknown>>) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: (table: string) => {
      if (table === 'fiscal_documents') {
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
      }
      // sale_items — usado depois do gate fiscal, sempre vazio aqui.
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      }
      return chain
    },
  } as any)
}

function buildRequest(body: unknown = {}): Request {
  return new Request('http://localhost/api/vendas/642/cancelar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/vendas/[id]/cancelar — fundação homologação↔produção (item 8/9 da auditoria)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('9) só NFC-e AUTORIZADA EM HOMOLOGAÇÃO → não bloqueia (segue pro cancelamento normal)', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([
      { id: 1, document_type: 'nfce', number: '12', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'homologacao', status: 'authorized' },
    ])
    vi.spyOn(vendasService, 'cancelSale').mockResolvedValue({ ok: true, data: undefined as any })

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(vendasService.cancelSale).toHaveBeenCalledOnce()
  })

  it('10) NFC-e AUTORIZADA EM PRODUÇÃO → bloqueia com 409, nunca chega a chamar cancelSale', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([
      { id: 2, document_type: 'nfce', number: '34', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'producao', status: 'authorized' },
    ])
    const cancelSpy = vi.spyOn(vendasService, 'cancelSale')

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json.error).toMatch(/NFC-e autorizada/)
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('homologação E produção autorizadas simultaneamente → bloqueia (a de produção é a que importa)', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([
      { id: 1, document_type: 'nfce', number: '12', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'homologacao', status: 'authorized' },
      { id: 2, document_type: 'nfce', number: '34', series: '1', sale_id: SALE_ID, company_id: COMPANY_ID, environment: 'producao', status: 'authorized' },
    ])
    const cancelSpy = vi.spyOn(vendasService, 'cancelSale')

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(409)
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('nenhum documento fiscal → não bloqueia', async () => {
    mockAdminAsAdmin()
    mockAdminWithFiscalDocuments([])
    vi.spyOn(vendasService, 'cancelSale').mockResolvedValue({ ok: true, data: undefined as any })

    const res = await POST(buildRequest(), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(200)
  })
})
