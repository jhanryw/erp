import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { revalidateWholesaleCart } from '@/services/wholesale/cartValidation'
import { POST } from './route'

vi.mock('@/lib/wholesale/publicContext', async (orig) => ({ ...(await orig<any>()), resolveWholesalePublicContext: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))
vi.mock('@/services/wholesale/cartValidation', () => ({ revalidateWholesaleCart: vi.fn() }))

const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.resetAllMocks()
  ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 7, settings: { catalogActive: true } })
  ;(revalidateWholesaleCart as any).mockResolvedValue({ valid: true, items: [], summary: {} })
})

describe('POST /api/wholesale/cart/validate', () => {
  it('catálogo desativado (controle mestre) → 503 e nada é consultado', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: false, status: 503, error: 'Catálogo temporariamente indisponível.' })
    const res = await POST(req({ items: [{ variationId: 1, quantity: 1 }] }))
    expect(res.status).toBe(503)
    expect(revalidateWholesaleCart).not.toHaveBeenCalled()
  })

  it('usa a empresa do tenant, nunca uma enviada pelo navegador', async () => {
    await POST(req({ items: [{ variationId: 1, quantity: 2 }], companyId: 99 }))
    expect(revalidateWholesaleCart).toHaveBeenCalledWith(7, [{ variationId: 1, quantity: 2 }])
  })

  it('limita o tamanho do carrinho e rejeita quantidades inválidas', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ variationId: i + 1, quantity: 1 }))
    expect((await POST(req({ items: many }))).status).toBe(422)
    expect((await POST(req({ items: [{ variationId: 1, quantity: 0 }] }))).status).toBe(422)
    expect((await POST(req({ items: [] }))).status).toBe(422)
  })
})
