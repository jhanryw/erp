import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hasMinRole, type AppRole } from '@/types/roles'
import { ShopeeError } from '@/lib/integrations/shopee/errors'

const session = vi.hoisted(() => ({ current: null as null | { id: string; role: string; company_id: number | null } }))
const listings = vi.hoisted(() => ({ publishListings: vi.fn(), getChannelProductOverview: vi.fn() }))
const shopee = vi.hoisted(() => ({
  listShopeeCategories: vi.fn(), getShopeeCategoryAttributes: vi.fn(), getShopeeBrands: vi.fn(),
  getShopeeLogistics: vi.fn(), getShopeePublishRequirements: vi.fn(), resolveShopeeChannel: vi.fn(),
}))
const ml = vi.hoisted(() => ({ requiredAttributeIdsFor: vi.fn() }))

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
vi.mock('@/services/channels/listings.service', async (orig) => ({ ...(await orig<typeof import('@/services/channels/listings.service')>()), ...listings }))
vi.mock('@/services/channels/shopeeChannel', () => shopee)
vi.mock('@/services/channels/mercadolivreChannel', () => ml)
vi.mock('@/services/integrations/mercadolivre.service', () => ({ getMercadoLivreConnection: vi.fn() }))
vi.mock('@/lib/audit/log', () => ({ auditLog: vi.fn() }))

import { POST as publish } from '@/app/api/channels/listings/route'
import { GET as categories } from './categories/route'
import { GET as attributes } from './attributes/route'
import { GET as brands } from './brands/route'
import { GET as logistics } from './logistics/route'
import { GET as requirements } from './requirements/route'

const base = 'https://erp.example.com'
const get = (path: string) => new NextRequest(`${base}${path}`)
const post = (b: unknown) => new Request(`${base}/api/channels/listings`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const shopeeBody = {
  provider: 'shopee', integration_id: 7, product_id: 1, category_id: '102', description: 'desc', condition: 'NEW', weight_kg: 0.3,
  brand: { no_brand: true }, attributes: [{ attribute_id: 1001, values: [{ value_id: 12 }] }], variations: [{ product_variation_id: 11 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  session.current = { id: 'user-a', role: 'gerente', company_id: 1 }
})

describe('POST /api/channels/listings (provider=shopee) — mesma rota genérica', () => {
  it('publica pelo núcleo genérico com a integração EXATA; empresa da sessão; nada de rota paralela', async () => {
    listings.publishListings.mockResolvedValue({ channel: { integrationId: 7, shopId: '700001', sellerId: '700001' }, results: [{ status: 'published' }] })
    const res = await publish(post({ ...shopeeBody, company_id: 999 }))
    expect(res.status).toBe(201)
    const [sess, input] = listings.publishListings.mock.calls[0]
    expect(sess).toEqual({ companyId: 1, userId: 'user-a' })
    expect(input).toMatchObject({
      target: { provider: 'shopee', integrationId: 7 }, productId: 1, categoryId: '102', requiredAttributeIds: [],
      channelOptions: { shopee: { condition: 'NEW', weight_kg: 0.3, brand: { no_brand: true } } },
    })
    expect(ml.requiredAttributeIdsFor).not.toHaveBeenCalled()
  })

  it('peso/condition ausentes NÃO são barrados pelo schema (a validação do canal devolve missing_weight estruturado)', async () => {
    listings.publishListings.mockResolvedValue({ channel: { integrationId: 7 }, results: [{ status: 'failed', reason: 'validation_failed', message: 'missing_weight: ...' }] })
    const { weight_kg: _w, condition: _c, ...rest } = shopeeBody
    const res = await publish(post(rest))
    expect(res.status).toBe(200)
    expect(listings.publishListings.mock.calls[0][1].channelOptions.shopee).toMatchObject({ weight_kg: null, condition: null })
  })

  it('sem integration_id, categoria não numérica ou mais de 1 variação → 422', async () => {
    const { integration_id: _i, ...noIntegration } = shopeeBody
    expect((await publish(post(noIntegration))).status).toBe(422)
    expect((await publish(post({ ...shopeeBody, category_id: 'MLB1' }))).status).toBe(422)
    expect((await publish(post({ ...shopeeBody, variations: [{ product_variation_id: 1 }, { product_variation_id: 2 }] }))).status).toBe(422)
    expect(listings.publishListings).not.toHaveBeenCalled()
  })
})

describe('rotas de catálogo Shopee', () => {
  it('auth: sem sessão 401; papel abaixo de gerente 403', async () => {
    session.current = null
    expect((await categories(get('/x?integration_id=7'))).status).toBe(401)
    session.current = { id: 'u', role: 'usuario', company_id: 1 }
    expect((await requirements(get('/x?integration_id=7&category_id=102'))).status).toBe(403)
    expect(shopee.listShopeeCategories).not.toHaveBeenCalled()
  })

  it('parâmetros obrigatórios', async () => {
    expect((await categories(get('/x'))).status).toBe(400)
    expect((await attributes(get('/x?integration_id=7'))).status).toBe(400)
    expect((await brands(get('/x?category_id=1'))).status).toBe(400)
    expect((await logistics(get('/x'))).status).toBe(400)
    expect((await categories(get('/x?integration_id=7&parent_id=abc'))).status).toBe(400)
  })

  it('usa a empresa da sessão + integration_id; filtros de categoria repassados', async () => {
    shopee.listShopeeCategories.mockResolvedValue([])
    shopee.getShopeePublishRequirements.mockResolvedValue({ ok: 1 })
    shopee.getShopeeLogistics.mockResolvedValue([{ logistics_channel_id: 1, enabled: true, fee_type: 'SIZE_INPUT' }])
    expect((await categories(get('/x?integration_id=7&parent_id=root&q=suti'))).status).toBe(200)
    expect(shopee.listShopeeCategories).toHaveBeenCalledWith(1, 7, { parentId: null, q: 'suti' })
    expect(await (await requirements(get('/x?integration_id=7&category_id=102'))).json()).toEqual({ ok: 1 })
    expect(shopee.getShopeePublishRequirements).toHaveBeenCalledWith(1, 7, 102)
    expect(await (await logistics(get('/x?integration_id=7'))).json()).toMatchObject({ default_channel_id: 1 })
  })

  it('erros tipados da Shopee viram status HTTP sem vazar segredo', async () => {
    shopee.getShopeeBrands.mockRejectedValue(new ShopeeError('rate_limited', 'Shopee 429 access_token=abc'))
    const res = await brands(get('/x?integration_id=7&category_id=102'))
    expect(res.status).toBe(429)
    expect(JSON.stringify(await res.json())).not.toContain('abc')
    shopee.getShopeeCategoryAttributes.mockRejectedValue(new ShopeeError('not_found', 'Categoria Shopee 5 não existe'))
    expect((await attributes(get('/x?integration_id=7&category_id=5'))).status).toBe(404)
  })
})
