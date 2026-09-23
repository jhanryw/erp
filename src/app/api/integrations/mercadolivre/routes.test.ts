import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = vi.hoisted(() => ({ current: null as null | { id: string; role: string; company_id: number | null } }))
const service = vi.hoisted(() => ({
  startMercadoLivreOAuth: vi.fn(),
  completeMercadoLivreOAuth: vi.fn(),
  getMercadoLivreConnection: vi.fn(),
  disconnectMercadoLivre: vi.fn(),
}))

vi.mock('@/lib/supabase/session', () => ({
  requireSession: async () => session.current
    ? { user: session.current, response: null }
    : { user: null, response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) },
}))
vi.mock('@/services/integrations/mercadolivre.service', () => service)
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

import { GET as connect } from './connect/route'
import { GET as callback } from './callback/route'
import { GET as status } from './status/route'
import { MercadoLivreError } from '@/lib/integrations/mercadolivre/errors'

const base = 'https://erp.example.com'

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { id: 'user-a', role: 'admin', company_id: 1 }
})

describe('autorização (17)', () => {
  it('gerente não conecta (403) — mesmo nível das demais integrações: admin', async () => {
    session.current = { id: 'user-g', role: 'gerente', company_id: 1 }
    const res = await connect(new Request(`${base}/api/integrations/mercadolivre/connect`))
    expect(res.status).toBe(403)
    expect(service.startMercadoLivreOAuth).not.toHaveBeenCalled()
  })

  it('sem sessão → 401', async () => {
    session.current = null
    expect((await status()).status).toBe(401)
  })

  it('admin inicia: empresa/usuário vêm da sessão, nunca da query', async () => {
    service.startMercadoLivreOAuth.mockResolvedValue({ authorizationUrl: 'https://auth.mercadolivre.com.br/authorization?x=1' })
    const res = await connect(new Request(`${base}/api/integrations/mercadolivre/connect?company_id=999`))
    expect(res.status).toBe(303)
    expect(service.startMercadoLivreOAuth).toHaveBeenCalledWith({ userId: 'user-a', companyId: 1 })
  })
})

describe('callback (8)', () => {
  it('sucesso: redireciona para a tela sem code/state/token na URL e com Referrer-Policy no-referrer', async () => {
    service.completeMercadoLivreOAuth.mockResolvedValue({ integrationId: 7, sellerId: '555', reconnected: false, account: {} })
    const res = await callback(new Request(`${base}/api/integrations/mercadolivre/callback?code=TG-secret-code&state=abc`))
    const location = res.headers.get('location')!
    expect(location).toBe(`${base}/configuracoes/mercadolivre?ml=connected`)
    expect(location).not.toContain('TG-secret-code')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(service.completeMercadoLivreOAuth).toHaveBeenCalledWith(
      { userId: 'user-a', companyId: 1 },
      { code: 'TG-secret-code', state: 'abc', error: null },
    )
    const body = await res.text()
    expect(body).not.toContain('APP_USR')
  })

  it('erro: só o tipo do erro vai para a URL, nunca detalhes', async () => {
    service.completeMercadoLivreOAuth.mockRejectedValue(new MercadoLivreError('invalid_state', 'State OAuth expired. code=TG-x'))
    const res = await callback(new Request(`${base}/api/integrations/mercadolivre/callback?code=TG-x&state=abc`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/mercadolivre?ml=error&reason=invalid_state`)
  })

  it('sessão expirada no retorno → redireciona com reason=session, sem chamar o serviço', async () => {
    session.current = null
    const res = await callback(new Request(`${base}/api/integrations/mercadolivre/callback?code=TG-x&state=abc`))
    expect(res.headers.get('location')).toContain('reason=session')
    expect(service.completeMercadoLivreOAuth).not.toHaveBeenCalled()
  })
})

describe('status', () => {
  it('devolve a view da empresa da sessão', async () => {
    service.getMercadoLivreConnection.mockResolvedValue({ state: 'connected', seller_id: '555' })
    const res = await status()
    expect(await res.json()).toEqual({ connection: { state: 'connected', seller_id: '555' } })
    expect(service.getMercadoLivreConnection).toHaveBeenCalledWith(1)
  })
})
