import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleRecommendations } from '@/services/wholesale/catalog'
import { GET } from './route'

vi.mock('@/lib/wholesale/publicContext', () => ({ resolveWholesalePublicContext: vi.fn(), publicRouteError: vi.fn(() => new Response('{}', { status: 500 })) }))
vi.mock('@/services/wholesale/catalog', () => ({ getWholesaleRecommendations: vi.fn() }))

const call = (qs = '') => GET(new Request(`http://x/api/wholesale/recomendacoes${qs}`))

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 7, settings: {} })
  ;(getWholesaleRecommendations as any).mockResolvedValue([])
})

describe('GET /api/wholesale/recomendacoes', () => {
  it('usa SEMPRE o tenant do servidor, ignorando company_id enviado na URL', async () => {
    await call('?exclude=1,2&seed=abc&company_id=99')
    expect(getWholesaleRecommendations).toHaveBeenCalledWith(7, { excludeProductIds: [1, 2], seed: 'abc', limit: 6 })
  })

  it('catálogo desativado/sem tenant → 503 sem consultar nada', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: false, status: 503, error: 'off' })
    expect((await call()).status).toBe(503)
    expect(getWholesaleRecommendations).not.toHaveBeenCalled()
  })

  it('valida exclude e seed', async () => {
    expect((await call('?exclude=abc')).status).toBe(400)
    expect((await call('?seed=../../etc')).status).toBe(400)
    expect((await call('?exclude=1,2,3')).status).toBe(200)
  })

  it('gera seed quando não enviada e limita a quantidade de exclusões', async () => {
    const many = Array.from({ length: 500 }, (_, i) => i + 1).join(',')
    await call(`?exclude=${many}`)
    const args = (getWholesaleRecommendations as any).mock.calls[0][1]
    expect(args.excludeProductIds).toHaveLength(200)
    expect(args.seed).toMatch(/^[a-z0-9]+$/)
  })
})
