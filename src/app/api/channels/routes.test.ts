import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hasMinRole, type AppRole } from '@/types/roles'

const session = vi.hoisted(() => ({ current: null as null | { id: string; role: string; company_id: number | null } }))
const listings = vi.hoisted(() => ({
  publishListings: vi.fn(),
  getChannelProductOverview: vi.fn(),
  syncListing: vi.fn(),
  pauseListing: vi.fn(),
  activateListing: vi.fn(),
  reconcileListing: vi.fn(),
}))
const ml = vi.hoisted(() => ({ requiredAttributeIdsFor: vi.fn(), getMercadoLivrePublishForm: vi.fn(), getConnectedMercadoLivreIntegration: vi.fn() }))

vi.mock('@/lib/supabase/session', async () => {
  const { NextResponse } = await import('next/server')
  return {
    requireRole: async (min: AppRole) => {
      if (!session.current) return { user: null, response: NextResponse.json({ error: 'Não autorizado.' }, { status: 401 }) }
      if (!hasMinRole(session.current.role as AppRole, min)) return { user: null, response: NextResponse.json({ error: 'Acesso negado.' }, { status: 403 }) }
      return { user: session.current, response: null }
    },
  }
})
vi.mock('@/services/channels/listings.service', async (orig) => {
  const real = await orig<typeof import('@/services/channels/listings.service')>()
  return { ...real, ...listings }
})
vi.mock('@/services/channels/mercadolivreChannel', () => ml)
vi.mock('@/services/integrations/mercadolivre.service', () => ({
  getMercadoLivreConnection: vi.fn(async () => ({ state: 'connected', nickname: 'TESTUSER', site_id: 'MLB', is_test_user: true })),
}))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

import { GET as getListings, POST as publish } from './listings/route'
import { POST as sync } from './listings/[id]/sync/route'
import { POST as pause } from './listings/[id]/pause/route'
import { GET as categoryForm } from '../integrations/mercadolivre/categories/[categoryId]/route'
import { ListingError } from '@/services/channels/listings.service'

const base = 'https://erp.example.com'
const body = {
  provider: 'mercadolivre', product_id: 1, category_id: 'MLB1234',
  common_attributes: [{ id: 'BRAND', value_name: 'X' }],
  variations: [{ product_variation_id: 11, attributes: [] }],
}
const post = (b: unknown) => new Request(`${base}/api/channels/listings`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { id: 'user-a', role: 'gerente', company_id: 1 }
  ml.requiredAttributeIdsFor.mockResolvedValue(['BRAND'])
})

describe('rotas de canais', () => {
  it('sem sessão → 401; papel abaixo de gerente → 403 (nada é chamado)', async () => {
    session.current = null
    expect((await publish(post(body))).status).toBe(401)
    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await publish(post(body))).status).toBe(403)
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(403)
    expect(listings.publishListings).not.toHaveBeenCalled()
    expect(listings.syncListing).not.toHaveBeenCalled()
  })

  it('empresa vem SEMPRE da sessão (company_id no corpo é ignorado)', async () => {
    listings.publishListings.mockResolvedValue({ channel: { model: 'user_products', accountLabel: 'T', sellerId: '1', isTestAccount: true }, results: [{ status: 'published' }] })
    const res = await publish(post({ ...body, company_id: 999 }))
    expect(res.status).toBe(201)
    expect(listings.publishListings.mock.calls[0][0]).toEqual({ companyId: 1, userId: 'user-a' })
    expect(ml.requiredAttributeIdsFor.mock.calls[0][0]).toBe(1)
    expect(listings.publishListings.mock.calls[0][1]).toMatchObject({ requiredAttributeIds: ['BRAND'], categoryId: 'MLB1234' })
  })

  it('validação: provider desconhecido, categoria inválida e sem variações → 422', async () => {
    expect((await publish(post({ ...body, provider: 'shopee' }))).status).toBe(422)
    expect((await publish(post({ ...body, category_id: '../x' }))).status).toBe(422)
    expect((await publish(post({ ...body, variations: [] }))).status).toBe(422)
    expect((await categoryForm(new NextRequest(`${base}/x`), { params: { categoryId: 'MLB1;DROP' } })).status).toBe(400)
  })

  it('erros do serviço mapeados sem vazar detalhes internos', async () => {
    listings.syncListing.mockRejectedValue(new ListingError('not_found', 'Anúncio não encontrado.'))
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(404)
    listings.pauseListing.mockRejectedValue(new ListingError('needs_reauth', 'Reautorize.'))
    expect((await pause(new Request(`${base}/x`, { method: 'POST' }), { params: { id: '5' } })).status).toBe(409)
    expect((await sync(new Request(`${base}/x`, { method: 'POST' }), { params: { id: 'abc' } })).status).toBe(400)
  })

  it('GET ?product_id= devolve conexão + overview, sem tokens', async () => {
    listings.getChannelProductOverview.mockResolvedValue({ product: { id: 1 }, variations: [] })
    const res = await getListings(new NextRequest(`${base}/api/channels/listings?product_id=1`))
    const json = await res.json()
    expect(json.channels.mercadolivre).toEqual({ state: 'connected', nickname: 'TESTUSER', site_id: 'MLB', is_test_user: true })
    expect(JSON.stringify(json)).not.toMatch(/token|secret/i)
    expect(listings.getChannelProductOverview).toHaveBeenCalledWith(1, 1)
  })
})
