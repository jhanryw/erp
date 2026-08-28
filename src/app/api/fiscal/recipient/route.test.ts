// Regressão — auditoria de acesso fiscal: "Completar dados fiscais"
// (parte do fluxo de retry de emissão NF-e no DocumentoFiscalCard) nunca
// foi pra ser admin-only. Isolamento garantido dentro de
// getSaleRecipient/upsertSaleRecipient (sempre escopados por
// user.company_id, nunca aceito do corpo/query string).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GET, POST } from './route'
import * as sessionModule from '@/lib/supabase/session'
import * as recipientModule from '@/services/fiscal/upsertSaleRecipient'

function mockSession(role: 'admin' | 'gerente' | 'usuario', companyId: number | null = 1) {
  vi.spyOn(sessionModule, 'requireRole').mockImplementation(async (minRole: any) => {
    const hierarchy: Record<string, number> = { admin: 3, gerente: 2, usuario: 1 }
    if (hierarchy[role] < hierarchy[minRole]) {
      return { user: null as any, response: new Response(JSON.stringify({ error: 'Acesso negado. Permissão insuficiente.' }), { status: 403 }) as any }
    }
    return { user: { id: 'user-uuid', role, company_id: companyId } as any, response: null }
  })
}

function buildGetRequest(saleId: number): Request {
  return new Request(`http://localhost/api/fiscal/recipient?sale_id=${saleId}`)
}

function buildPostRequest(body: unknown): Request {
  return new Request('http://localhost/api/fiscal/recipient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID_RECIPIENT = {
  nome: null, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null,
  telefone: null, cep: null, logradouro: null, numero: null, complemento: null,
  bairro: null, municipio: null, municipioIbge: null, uf: null, ibgeSource: null,
}

describe('GET/PUT /api/fiscal/recipient — acesso liberado pra qualquer usuário autenticado da empresa', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('GET role=usuario (seller) → passa pelo gate, company_id sempre da sessão', async () => {
    mockSession('usuario', 1)
    const getSpy = vi.spyOn(recipientModule, 'getSaleRecipient').mockResolvedValue({ ok: true, data: null })

    const res = await GET(buildGetRequest(42))
    expect(res.status).toBe(200)
    expect(getSpy).toHaveBeenCalledWith(42, 1)
  })

  it('PUT role=usuario (seller) → passa pelo gate, company_id sempre da sessão (nunca do corpo)', async () => {
    mockSession('usuario', 1)
    const upsertSpy = vi.spyOn(recipientModule, 'upsertSaleRecipient').mockResolvedValue({ ok: true, data: { saleId: 42 } })

    const res = await POST(buildPostRequest({ sale_id: 42, recipient: VALID_RECIPIENT }))
    expect(res.status).toBe(200)
    expect(upsertSpy).toHaveBeenCalledWith(42, 1, expect.anything())
  })

  it('role=admin → continua funcionando normalmente (GET e PUT)', async () => {
    mockSession('admin', 1)
    vi.spyOn(recipientModule, 'getSaleRecipient').mockResolvedValue({ ok: true, data: null })
    vi.spyOn(recipientModule, 'upsertSaleRecipient').mockResolvedValue({ ok: true, data: { saleId: 42 } })

    expect((await GET(buildGetRequest(42))).status).toBe(200)
    expect((await POST(buildPostRequest({ sale_id: 42, recipient: VALID_RECIPIENT }))).status).toBe(200)
  })

  it('venda de outra empresa → serviço devolve erro (escopo por company_id não encontra nada), rota nunca vaza sucesso', async () => {
    mockSession('usuario', 1)
    vi.spyOn(recipientModule, 'upsertSaleRecipient').mockResolvedValue({ ok: false, error: 'Venda não encontrada para esta empresa.', status: 404 })

    const res = await POST(buildPostRequest({ sale_id: 999, recipient: VALID_RECIPIENT }))
    expect(res.status).toBe(404)
  })

  it('sem sessão/role insuficiente → 403/401, nunca chama o serviço', async () => {
    vi.spyOn(sessionModule, 'requireRole').mockResolvedValue({
      user: null as any,
      response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) as any,
    })
    const getSpy = vi.spyOn(recipientModule, 'getSaleRecipient')

    const res = await GET(buildGetRequest(42))
    expect(res.status).toBe(401)
    expect(getSpy).not.toHaveBeenCalled()
  })
})
