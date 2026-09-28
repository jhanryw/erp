import { describe, it, expect, vi, beforeEach } from 'vitest'

const session = vi.hoisted(() => ({ current: null as null | { id: string; role: string; company_id: number | null } }))
const service = vi.hoisted(() => ({
  startShopeeOAuth: vi.fn(),
  completeShopeeOAuth: vi.fn(),
  getShopeeConnections: vi.fn(),
  forceRefreshShopeeToken: vi.fn(),
  disconnectShopee: vi.fn(),
}))

vi.mock('@/lib/supabase/session', () => ({
  requireSession: async () => session.current
    ? { user: session.current, response: null }
    : { user: null, response: new Response(JSON.stringify({ error: 'Não autorizado.' }), { status: 401 }) },
}))
vi.mock('@/services/integrations/shopee.service', () => service)
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

import { GET as connect } from './connect/route'
import { GET as callback } from './callback/route'
import { GET as status } from './status/route'
import { POST as refresh } from './refresh/route'
import { POST as disconnect } from './disconnect/route'
import { ShopeeError } from '@/lib/integrations/shopee/errors'

const base = 'https://erp.example.com'
const post = (path: string, body: unknown) =>
  new Request(`${base}/api/integrations/shopee/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('APP_URL', base)
  session.current = { id: 'user-a', role: 'admin', company_id: 1 }
})

describe('autorização', () => {
  it('sem sessão → 401 em todas as rotas JSON', async () => {
    session.current = null
    expect((await status()).status).toBe(401)
    expect((await refresh(post('refresh', { integration_id: 1 }))).status).toBe(401)
    expect((await disconnect(post('disconnect', { integration_id: 1 }))).status).toBe(401)
  })

  it('gerente não conecta nem desconecta (403)', async () => {
    session.current = { id: 'user-g', role: 'gerente', company_id: 1 }
    expect((await connect(new Request(`${base}/api/integrations/shopee/connect`))).status).toBe(403)
    expect((await disconnect(post('disconnect', { integration_id: 1 }))).status).toBe(403)
    expect(service.startShopeeOAuth).not.toHaveBeenCalled()
    expect(service.disconnectShopee).not.toHaveBeenCalled()
  })

  it('connect: empresa/usuário vêm da sessão, nunca da query', async () => {
    service.startShopeeOAuth.mockResolvedValue({ authorizationUrl: 'https://open.shopee.com.br/auth?x=1' })
    const res = await connect(new Request(`${base}/api/integrations/shopee/connect?company_id=999`))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://open.shopee.com.br/auth?x=1')
    expect(service.startShopeeOAuth).toHaveBeenCalledWith({ userId: 'user-a', companyId: 1 })
  })

  it('connect com erro de configuração → volta para a tela com reason=config', async () => {
    service.startShopeeOAuth.mockRejectedValue(new ShopeeError('config', 'faltou env'))
    const res = await connect(new Request(`${base}/api/integrations/shopee/connect`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=error&reason=config`)
  })
})

describe('callback', () => {
  it('sucesso: repassa code/shop_id/state; empresa da sessão; URL final sem code', async () => {
    service.completeShopeeOAuth.mockResolvedValue({ integrationId: 7, shopId: '555', reconnected: false })
    const res = await callback(new Request(`${base}/api/integrations/shopee/callback?code=SECRETCODE&shop_id=555&state=abc&company_id=2`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=connected`)
    expect(res.headers.get('location')).not.toContain('SECRETCODE')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(service.completeShopeeOAuth).toHaveBeenCalledWith(
      { userId: 'user-a', companyId: 1 },
      { code: 'SECRETCODE', shopId: '555', state: 'abc', error: null },
    )
  })

  it('sem code / sem shop_id → só o tipo do erro vai para a URL', async () => {
    service.completeShopeeOAuth.mockRejectedValueOnce(new ShopeeError('invalid_callback', 'Callback sem code.'))
    let res = await callback(new Request(`${base}/api/integrations/shopee/callback?shop_id=555&state=abc`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=error&reason=invalid_callback`)
    expect(service.completeShopeeOAuth).toHaveBeenLastCalledWith(expect.anything(), { code: null, shopId: '555', state: 'abc', error: null })

    service.completeShopeeOAuth.mockRejectedValueOnce(new ShopeeError('invalid_callback', 'sem shop_id'))
    res = await callback(new Request(`${base}/api/integrations/shopee/callback?code=X&state=abc`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=error&reason=invalid_callback`)
    expect(service.completeShopeeOAuth).toHaveBeenLastCalledWith(expect.anything(), { code: 'X', shopId: null, state: 'abc', error: null })
  })

  it('state inválido/expirado/reusado → reason=invalid_state', async () => {
    service.completeShopeeOAuth.mockRejectedValue(new ShopeeError('invalid_state', 'State OAuth consumed. code=abc'))
    const res = await callback(new Request(`${base}/api/integrations/shopee/callback?code=X&shop_id=1&state=abc`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=error&reason=invalid_state`)
  })

  it('sessão expirada no retorno → reason=session, serviço não é chamado', async () => {
    session.current = null
    const res = await callback(new Request(`${base}/api/integrations/shopee/callback?code=X&shop_id=1&state=abc`))
    expect(res.headers.get('location')).toBe(`${base}/configuracoes/shopee?shopee=error&reason=session`)
    expect(service.completeShopeeOAuth).not.toHaveBeenCalled()
  })
})

describe('status / refresh / disconnect — escopo da empresa da sessão', () => {
  it('status usa só o company_id da sessão', async () => {
    service.getShopeeConnections.mockResolvedValue({ configured: true, shops: [] })
    const res = await status()
    expect(await res.json()).toEqual({ connection: { configured: true, shops: [] } })
    expect(service.getShopeeConnections).toHaveBeenCalledWith(1)
  })

  it('refresh/disconnect: integration_id do corpo, company_id SEMPRE da sessão (company_id do corpo ignorado)', async () => {
    service.forceRefreshShopeeToken.mockResolvedValue({ integration_id: 5 })
    service.disconnectShopee.mockResolvedValue({ integration_id: 5 })
    await refresh(post('refresh', { integration_id: 5, company_id: 2 }))
    await disconnect(post('disconnect', { integration_id: 5, company_id: 2 }))
    expect(service.forceRefreshShopeeToken).toHaveBeenCalledWith(1, 5)
    expect(service.disconnectShopee).toHaveBeenCalledWith(1, 5, 'user-a')
  })

  it('integração de outra empresa → 404 (not found), sem vazar existência', async () => {
    service.forceRefreshShopeeToken.mockRejectedValue(new ShopeeError('integration_not_found', 'Integração Shopee não encontrada nesta empresa.'))
    service.disconnectShopee.mockRejectedValue(new ShopeeError('integration_not_found', 'Integração Shopee não encontrada nesta empresa.'))
    const r1 = await refresh(post('refresh', { integration_id: 99 }))
    const r2 = await disconnect(post('disconnect', { integration_id: 99 }))
    expect(r1.status).toBe(404)
    expect(r2.status).toBe(404)
    expect(await r1.json()).toMatchObject({ kind: 'integration_not_found' })
  })

  it('integration_id ausente/inválido → 400 sem chamar o serviço', async () => {
    expect((await refresh(post('refresh', {}))).status).toBe(400)
    expect((await disconnect(post('disconnect', { integration_id: 'abc' }))).status).toBe(400)
    expect(service.forceRefreshShopeeToken).not.toHaveBeenCalled()
    expect(service.disconnectShopee).not.toHaveBeenCalled()
  })

  it('refresh com needs_reauth → 409', async () => {
    service.forceRefreshShopeeToken.mockRejectedValue(new ShopeeError('reauth_required', 'reautorize'))
    expect((await refresh(post('refresh', { integration_id: 5 }))).status).toBe(409)
  })
})
