import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleCatalogPage, getWholesaleProductDetail } from '@/services/wholesale/catalog'
import { GET } from './route'
import { GET as GET_DETAIL } from './[id]/route'

vi.mock('@/lib/wholesale/publicContext', async (orig) => ({ ...(await orig<any>()), resolveWholesalePublicContext: vi.fn() }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))
vi.mock('@/services/wholesale/catalog', () => ({ getWholesaleCatalogPage: vi.fn(), getWholesaleProductDetail: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('APIs públicas do catálogo — catalog_active é o controle mestre', () => {
  it('catálogo desativado → 503 na listagem e no detalhe, sem consultar produtos', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: false, status: 503, error: 'Catálogo temporariamente indisponível.' })
    expect((await GET(new Request('http://x/api/wholesale/produtos'))).status).toBe(503)
    expect((await GET_DETAIL(new Request('http://x'), { params: { id: '1' } })).status).toBe(503)
    expect(getWholesaleCatalogPage).not.toHaveBeenCalled()
    expect(getWholesaleProductDetail).not.toHaveBeenCalled()
  })

  it('detalhe de produto fora do atacado → 404', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 1, settings: {} })
    ;(getWholesaleProductDetail as any).mockResolvedValue(null)
    expect((await GET_DETAIL(new Request('http://x'), { params: { id: '5' } })).status).toBe(404)
  })

  it('catálogo ativo → lista com a empresa do tenant', async () => {
    ;(resolveWholesalePublicContext as any).mockResolvedValue({ ok: true, companyId: 3, settings: {} })
    ;(getWholesaleCatalogPage as any).mockResolvedValue({ products: [], total: 0, page: 1, pageSize: 24 })
    expect((await GET(new Request('http://x/api/wholesale/produtos?q=a'))).status).toBe(200)
    expect(getWholesaleCatalogPage).toHaveBeenCalledWith(3, expect.objectContaining({ search: 'a' }))
  })
})
