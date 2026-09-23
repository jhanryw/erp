import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { resolveNuvemshopContextForStore } from '@/services/nuvemshop/context.service'
import { processNuvemshopProductDeleted } from '@/services/nuvemshop/productWebhook.service'
import { POST } from './route'

vi.mock('@/services/nuvemshop/context.service', () => ({ resolveNuvemshopContextForStore: vi.fn() }))
vi.mock('@/services/nuvemshop/productWebhook.service', async (orig) => ({
  ...(await orig<typeof import('@/services/nuvemshop/productWebhook.service')>()),
  processNuvemshopProductDeleted: vi.fn(),
}))

const SECRET = 'app-secret'
const ctx = { companyId: 1, storeId: '111', integrationId: 1, source: 'company_integration', credentials: { storeId: '111', accessToken: 't' } }

function req(body: unknown, sign = true, secret = SECRET) {
  const raw = JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sign) headers['x-linkedstore-hmac-sha256'] = createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  return new Request('http://x/api/webhooks/nuvemshop/product', { method: 'POST', headers, body: raw })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NUVEMSHOP_CLIENT_SECRET', SECRET)
  vi.stubEnv('NUVEMSHOP_SKIP_WEBHOOK_HMAC', '')
  ;(resolveNuvemshopContextForStore as any).mockResolvedValue({ ok: true, data: ctx })
  ;(processNuvemshopProductDeleted as any).mockResolvedValue({ ok: true, data: { invalidated_products: [10], removed_rows: 3 } })
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/webhooks/nuvemshop/product', () => {
  it('sem HMAC ou HMAC inválido → 401 e nada é processado', async () => {
    expect((await POST(req({ store_id: 111, event: 'product/deleted', id: 5 }, false))).status).toBe(401)
    expect((await POST(req({ store_id: 111, event: 'product/deleted', id: 5 }, true, 'outro'))).status).toBe(401)
    expect(processNuvemshopProductDeleted).not.toHaveBeenCalled()
    expect(resolveNuvemshopContextForStore).not.toHaveBeenCalled()
  })

  it('product/deleted válido → resolve a loja do payload e invalida no contexto dela', async () => {
    const res = await POST(req({ store_id: 111, event: 'product/deleted', id: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, invalidated_products: [10] })
    expect(resolveNuvemshopContextForStore).toHaveBeenCalledWith('111')
    expect(processNuvemshopProductDeleted).toHaveBeenCalledWith(ctx, '5')
  })

  it('loja desconhecida → 200 ignorado, nenhuma invalidação', async () => {
    ;(resolveNuvemshopContextForStore as any).mockResolvedValue({ ok: true, data: null })
    const res = await POST(req({ store_id: 999, event: 'product/deleted', id: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'unknown_store' })
    expect(processNuvemshopProductDeleted).not.toHaveBeenCalled()
  })

  it('evento não tratado → 200 skipped', async () => {
    const res = await POST(req({ store_id: 111, event: 'product/updated', id: 5 }))
    expect(await res.json()).toMatchObject({ skipped: true, reason: 'event_not_handled' })
    expect(processNuvemshopProductDeleted).not.toHaveBeenCalled()
  })

  it('erro de banco → 500 (Nuvemshop reenvia)', async () => {
    ;(processNuvemshopProductDeleted as any).mockResolvedValue({ ok: false, error: 'db down', status: 500 })
    expect((await POST(req({ store_id: 111, event: 'product/deleted', id: 5 }))).status).toBe(500)
  })

  it('payload sem id/store_id → 400', async () => {
    expect((await POST(req({ event: 'product/deleted', id: 5 }))).status).toBe(400)
    expect((await POST(req({ store_id: 111, event: 'product/deleted' }))).status).toBe(400)
  })
})
