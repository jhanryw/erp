import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'

// Mocka só o auth.getUser() do Supabase — nunca toca rede/banco real.
// getUserMock é redefinido por teste pra simular usuário logado/deslogado.
let getUserMock: () => Promise<{ data: { user: { id: string } | null } }> = vi.fn(async () => ({ data: { user: null } }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: () => getUserMock() } })),
}))

const WHOLESALE_HOST = 'atacado.santtorini.com'
const ERP_HOST = 'santtorini.qarvon.com'

async function callMiddleware(url: string, host: string) {
  const { middleware } = await import('./middleware')
  const req = new NextRequest(url, { headers: { host } })
  return middleware(req)
}

describe('middleware — rewrite por host do site de atacado', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    getUserMock = vi.fn(async () => ({ data: { user: null } }))
  })

  it('1. host de atacado, "/" → reescreve para /atacado', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toContain('/atacado')
    expect(res.headers.get('x-middleware-rewrite')).not.toContain('/atacado/atacado')
  })

  it('2. host de atacado, "/carrinho" → reescreve para /atacado/carrinho', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/carrinho`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toContain('/atacado/carrinho')
  })

  it('3. host de atacado, "/produto/123" → reescreve para a rota correspondente, id preservado', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/produto/123`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toContain('/atacado/produto/123')
  })

  it('4. host de atacado, "/_next/static/chunk.js" → NUNCA sofre rewrite (defesa extra além do matcher)', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/_next/static/chunk.js`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('5. host de atacado, "/api/wholesale/produtos" → NUNCA sofre rewrite, continua no path real', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/api/wholesale/produtos`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('5b. host de atacado, asset público sem prefixo (/manifest.json) → NUNCA sofre rewrite', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/manifest.json`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('6. domínio ERP (host administrativo) — nenhum rewrite, comportamento atual preservado', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${ERP_HOST}/atacado/carrinho`, ERP_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('6b. domínio ERP, rota protegida sem sessão → continua redirecionando pro /login de staff', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${ERP_HOST}/dashboard`, ERP_HOST)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login')
  })

  it('6c. domínio ERP, rota protegida COM sessão → passa (sem redirect, sem rewrite)', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    getUserMock = vi.fn(async () => ({ data: { user: { id: 'staff-uuid' } } }))
    const res = await callMiddleware(`https://${ERP_HOST}/dashboard`, ERP_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.status).not.toBe(307)
  })

  it('7. rota administrativa no host de atacado → reescrita pra /atacado/dashboard, que NÃO existe como página real (bloqueio automático, sem lista de rotas administrativas pra manter)', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/dashboard`, WHOLESALE_HOST)
    const rewriteTarget = res.headers.get('x-middleware-rewrite')
    expect(rewriteTarget).toContain('/atacado/dashboard')
    // Prova estrutural: não existe nenhuma página real em src/app/atacado/dashboard
    // (nem em nenhum outro segmento administrativo) — o rewrite acima leva a um
    // 404 do Next, nunca a uma página administrativa de verdade.
    const dashboardUnderAtacado = path.join(process.cwd(), 'src/app/atacado/dashboard')
    expect(fs.existsSync(dashboardUnderAtacado)).toBe(false)
    for (const admin of ['vendas', 'produtos', 'financeiro', 'estoque', 'clientes', 'configuracoes']) {
      expect(fs.existsSync(path.join(process.cwd(), 'src/app/atacado', admin))).toBe(false)
    }
  })

  it('7b. mesma rota administrativa também não sofre rewrite indevido no host ERP (continua existindo só ali)', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    getUserMock = vi.fn(async () => ({ data: { user: { id: 'staff-uuid' } } }))
    const res = await callMiddleware(`https://${ERP_HOST}/dashboard`, ERP_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('8. localhost sem WHOLESALE_SITE_HOST configurada → nenhum rewrite, dev continua funcionando', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', '')
    const res = await callMiddleware('http://localhost:3000/atacado/carrinho', 'localhost:3000')
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })

  it('8b. localhost configurado explicitamente como host de atacado (dev) → rewrite funciona igual produção', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', 'localhost:3000')
    const res = await callMiddleware('http://localhost:3000/carrinho', 'localhost:3000')
    expect(res.headers.get('x-middleware-rewrite')).toContain('/atacado/carrinho')
  })

  it('9. querystrings são preservadas no rewrite', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/?q=body&page=2`, WHOLESALE_HOST)
    const rewriteTarget = res.headers.get('x-middleware-rewrite')
    expect(rewriteTarget).toContain('/atacado')
    expect(rewriteTarget).toContain('q=body')
    expect(rewriteTarget).toContain('page=2')
  })

  it('rewrite não duplica prefixo se o path já vier com /atacado no host de atacado', async () => {
    vi.stubEnv('WHOLESALE_SITE_HOST', WHOLESALE_HOST)
    const res = await callMiddleware(`https://${WHOLESALE_HOST}/atacado/carrinho`, WHOLESALE_HOST)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })
})
