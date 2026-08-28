// Regressão — remoção da autorização de gerente na troca (pedido do
// usuário 2026-08-28, corrigindo o commit 7b47e43 que criava uma exceção
// por UUID): NENHUM usuário autenticado da própria empresa precisa mais de
// authorization_token_id pra concluir uma troca. Company isolation,
// company_id/p_user_id vindos da sessão e validações de negócio do RPC
// continuam intactas.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as adminModule from '@/lib/supabase/admin'
import * as authTokenModule from '@/lib/auth/validateAuthorizationToken'

vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const COMPANY_ID = 1
const SALE_ID = 642

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

describe('POST /api/vendas/[id]/troca — nenhum perfil autenticado da empresa precisa de autorização de gerente', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('seller/usuario conclui a troca sem enviar authorization_token_id, sem chamar validateAuthorizationToken', async () => {
    mockSession('usuario', 'seller-uuid')
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('gerente conclui a troca sem token', async () => {
    mockSession('gerente', 'gerente-uuid')
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(200)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('admin conclui a troca sem token', async () => {
    mockSession('admin', 'admin-uuid')
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(200)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('enviar authorization_token_id no corpo não tem mais efeito nenhum — schema não reconhece o campo, endpoint ignora', async () => {
    mockSession('usuario', 'seller-uuid')
    mockAdminClient({})
    const tokenSpy = vi.spyOn(authTokenModule, 'validateAuthorizationToken')

    const res = await POST(
      buildRequest({ ...VALID_BODY, authorization_token_id: '11111111-1111-1111-1111-111111111111' }),
      { params: { id: String(SALE_ID) } },
    )
    expect(res.status).toBe(200)
    expect(tokenSpy).not.toHaveBeenCalled()
  })

  it('sem sessão/role insuficiente → gate de requireRole(\'usuario\') continua bloqueando', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    expect(res.status).toBe(401)
  })

  it('company isolation: RPC é chamado com company_id/user_id da SESSÃO, nunca de valor injetado no corpo', async () => {
    mockSession('usuario', 'seller-uuid', COMPANY_ID)
    const { rpcSpy } = mockAdminClient({})

    await POST(
      buildRequest({ ...VALID_BODY, company_id: 999 }),
      { params: { id: String(SALE_ID) } },
    )

    expect(rpcSpy).toHaveBeenCalledWith('rpc_process_exchange', expect.objectContaining({
      p_company_id: COMPANY_ID,
      p_sale_id:    SALE_ID,
      p_user_id:    'seller-uuid',
    }))
  })

  it('venda de outra empresa (lookup escopado por company_id não encontra nada) → 404', async () => {
    mockSession('usuario', 'seller-uuid', COMPANY_ID)
    mockAdminClient({ originalSale: null })

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/Venda não encontrada/)
  })

  it('validação de negócio do RPC continua bloqueando (ex.: quantidade > disponível)', async () => {
    mockSession('usuario', 'seller-uuid')
    mockAdminClient({ rpcError: { code: 'P0001', message: 'Quantidade a devolver maior que a vendida.' } })

    const res = await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })
    const json = await res.json()

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/Quantidade a devolver/)
  })

  it('auditoria: p_user_id continua vindo do usuário autenticado da sessão', async () => {
    mockSession('usuario', 'seller-uuid')
    const { rpcSpy } = mockAdminClient({})

    await POST(buildRequest(VALID_BODY), { params: { id: String(SALE_ID) } })

    expect(rpcSpy).toHaveBeenCalledWith('rpc_process_exchange', expect.objectContaining({
      p_user_id: 'seller-uuid',
    }))
  })
})
