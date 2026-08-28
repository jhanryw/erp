import { describe, it, expect, vi, afterEach } from 'vitest'
import { PUT } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as auditModule from '@/lib/audit/log'

function mockAdminUpdateSuccess(returnedRow: Record<string, unknown>) {
  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => {
      const chain: any = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: returnedRow, error: null }),
      }
      return chain
    },
  } as any)
}

function mockAdminAsAuthorized() {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: 'user-uuid', role: 'admin', company_id: 1 } as any,
    response: null,
  })
  vi.spyOn(auditModule, 'auditLog').mockImplementation(() => {})
}

function buildRequest(body: unknown): Request {
  return new Request('http://localhost/api/configuracoes/fiscal/policies', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_BASE = {
  operation_type: 'wholesale',
  fiscal_enabled: true,
  document_mode: 'nfe',
  auto_issue: false,
  auto_print: false,
  manual_issue_allowed: true,
}

describe('PUT /api/configuracoes/fiscal/policies — regra definitiva de impressão/QR Code', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('REGRA CENTRAL: auto_issue=true + print_non_fiscal_receipt=true → 422, nunca persiste', async () => {
    mockAdminAsAuthorized()
    const updateSpy = vi.spyOn(adminModule, 'createAdminClient')

    const res = await PUT(buildRequest({ ...VALID_BASE, operation_type: 'retail_pickup', auto_issue: true, print_non_fiscal_receipt: true }))
    const json = await res.json()

    expect(res.status).toBe(422)
    expect(JSON.stringify(json.error)).toMatch(/print_non_fiscal_receipt/)
    // Validação falha ANTES de qualquer acesso ao banco.
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('auto_issue=true + print_non_fiscal_receipt=false → válido, prossegue pro banco', async () => {
    mockAdminAsAuthorized()
    mockAdminUpdateSuccess({ operation_type: 'retail_pickup', fiscal_enabled: true, document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false, manual_issue_allowed: true, updated_at: '2026-01-01T00:00:00.000Z' })

    const res = await PUT(buildRequest({ ...VALID_BASE, operation_type: 'retail_pickup', document_mode: 'nfce', auto_issue: true, auto_print: true, print_non_fiscal_receipt: false }))
    expect(res.status).toBe(200)
  })

  it('auto_issue=false + print_non_fiscal_receipt=true → válido (caso wholesale: emissão manual, comprovante interno permitido até lá)', async () => {
    mockAdminAsAuthorized()
    mockAdminUpdateSuccess({ ...VALID_BASE, print_non_fiscal_receipt: true, updated_at: '2026-01-01T00:00:00.000Z' })

    const res = await PUT(buildRequest({ ...VALID_BASE, print_non_fiscal_receipt: true }))
    expect(res.status).toBe(200)
  })

  it('auto_issue=false + print_non_fiscal_receipt=false → válido (nenhum comprovante automático, sem conflito)', async () => {
    mockAdminAsAuthorized()
    mockAdminUpdateSuccess({ ...VALID_BASE, print_non_fiscal_receipt: false, updated_at: '2026-01-01T00:00:00.000Z' })

    const res = await PUT(buildRequest({ ...VALID_BASE, print_non_fiscal_receipt: false }))
    expect(res.status).toBe(200)
  })
})
