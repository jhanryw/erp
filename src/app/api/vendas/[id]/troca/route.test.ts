// Regressão — liberação pontual de autorização de gerente pra troca (pedido
// do usuário 2026-08-28): o seller UUID f9065bc1-7f6d-49bb-b192-f044d31541ca
// deixa de precisar de authorization_token_id (email/senha de gerente) pra
// concluir uma troca. Todo o resto (company isolation, validações de
// negócio via rpc_process_exchange, exigência de token pra outros sellers,
// admin sempre livre) precisa continuar exatamente igual.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as authTokenModule from '@/lib/auth/validateAuthorizationToken'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 642
const EXEMPT_SELLER_UUID = 'f9065bc1-7f6d-49bb-b192-f044d31541ca'
const REGULAR_SELLER_UUID = 'regular-seller-uuid'

function mockSession(role: 'admin' | 'gerente' | 'usuario', userId: string, companyId: number | null = COMPANY_ID) {
  vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
    user: { id: userId, role, company_id: companyId } as any,
    response: null,
  })
}

function mockAdminClient(opts: {
  originalSale?: Record<string, unknown> | null
  rpcData?: { exchange_id: number; credit_amount: number } | null
  rpcError?: { code: string; message: string } | null
}) {
  const originalSale = opts.originalSale === undefined
    ? { responsible_seller_id: null, company_id: COMPANY_ID, sale_type: 'retail', sales_channel: null }
    : opts.originalSale
  const rpcSpy = vi.fn().mockResolvedValue({
    data:  opts.rpcData ?? { exchange_id: 99, credit_amount: 50 },
    error: opts.rpcError ?? null,
  })

  vi.spyOn(adminModule, 'createAdminClient').mockReturnValue({
    from: () => {
      const chain: any = {
        select: () => chain,
        eq:     () => chain,
        maybeSingle: async () => ({ data: originalSale, error: null }),
      }
      return chain
    },
    rpc: rpcSpy,
  } as any)

  return { rpcSpy }
}

function buildRequest(body: unknown): Request {
  return new Request(`http://localhost/api/vendas/${SALE_ID}/troca`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const VALID_BODY = { customer_id: 5, items: [{ sale_item_id: 1, quantity_returned: 1 }] }

describe('POST /api/vendas/[id]/troca — liberação pontual de autorização pra seller UUID específico', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('seller UUID liberado conclui a troca SEM authorization_token_id — nunca chama validateAuthorizationToken', async () => {
    mockSession('usuario', EXEMPT_SELLER_UUID)
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('seller regular (não liberado) SEM authorization_token_id → 403, nunca chega no RPC', async () => {
    mockSession('usuario', REGULAR_SELLER_UUID)
    const { rpcSpy } = mockAdminClient({})

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(403)
    expect(json.error).toMatch(/Autorização de gerente necessária/)
    expect(rpcSpy).not.toHaveBeenCalled()
  })

  it('seller regular COM authorization_token_id válido continua funcionando (comportamento preexistente intacto)', async () => {
    mockSession('usuario', REGULAR_SELLER_UUID)
    mockAdminClient({})
    vi.spyOn(authTokenModule, 'validateAuthorizationToken').mockResolvedValue({
      ok: true, authorizedBy: 'gerente@empresa.com', reason: 'ok',
    })

    const res = await POST(
      buildRequest({ ...VALID_BODY, authorization_token_id: '11111111-1111-1111-1111-111111111111' }),
      { params: { id: String(SALE_ID) } },
    )
    expect(res.status).toBe(200)
  })

  it('admin continua concluindo troca sem qualquer token (nunca precisou)', async () => {
    mockSession('admin', 'admin-uuid')
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(200)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('company isolation: RPC é chamado com company_id da SESSÃO, nunca de um valor injetado no corpo', async () => {
    mockSession('usuario', EXEMPT_SELLER_UUID, COMPANY_ID)
    const { rpcSpy } = mockAdminClient({})

    await POST(
      buildRequest({ ...VALID_BODY, company_id: 999 }),
      { params: { id: String(SALE_ID) } },
    )

    expect(rpcSpy).toHaveBeenCalledWith('rpc_process_exchange', expect.objectContaining({
      p_company_id: COMPANY_ID,
      p_sale_id:    SALE_ID,
      p_user_id:    EXEMPT_SELLER_UUID,
    }))
  })

  it('venda de outra empresa (lookup escopado por company_id não encontra nada) → 404, mesmo pro seller liberado', async () => {
    mockSession('usuario', EXEMPT_SELLER_UUID, COMPANY_ID)
    mockAdminClient({ originalSale: null })

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/Venda não encontrada/)
  })

  it('validação de negócio do RPC continua bloqueando (ex.: quantidade > disponível) mesmo pro seller liberado', async () => {
    mockSession('usuario', EXEMPT_SELLER_UUID)
    mockAdminClient({ rpcError: { code: 'P0001', message: 'Quantidade a devolver maior que a vendida.' } })

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/Quantidade a devolver/)
  })

  it('auditoria: quem realizou a troca continua sendo o usuário autenticado (p_user_id), mesmo sem autorização de gerente', async () => {
    mockSession('usuario', EXEMPT_SELLER_UUID)
    const { rpcSpy } = mockAdminClient({})

    await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })

    expect(rpcSpy).toHaveBeenCalledWith('rpc_process_exchange', expect.objectContaining({
      p_user_id: EXEMPT_SELLER_UUID,
    }))
  })
})
