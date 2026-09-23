import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNuvemshopFakeDb, ctxCompany1, type NsFakeTables } from '@/services/nuvemshop/nuvemshop.testutil'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { POST } from './route'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/services/nuvemshop/routeContext', () => ({ requireNuvemshopRouteContext: vi.fn() }))
vi.mock('@/lib/services/nuvemshopSyncService', () => ({ pushVariantStockToNuvemshop: vi.fn() }))

let tables: NsFakeTables
const req = (body: unknown) => new Request('http://x/api/integrations/nuvemshop/stock/sync-batch', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  tables = {
    products: [{ id: 10, company_id: 1 }],
    produto_map: Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`, source: 'nuvemshop', produto_id: 10, product_variation_id: i + 1,
      external_id: '500', external_variant_id: String(600 + i), last_stock_synced_at: null,
    })),
  }
  ;(createAdminClient as any).mockImplementation(() => createNuvemshopFakeDb(tables))
  ;(requireNuvemshopRouteContext as any).mockResolvedValue({ ctx: ctxCompany1, response: null })
  // A rota espera 300ms entre variações (rate limit) — irrelevante aqui.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 }) as any)
})
afterEach(() => vi.restoreAllMocks())

describe('POST /api/integrations/nuvemshop/stock/sync-batch', () => {
  it('termina mesmo com falhas de cálculo de estoque; variações seguem pendentes', async () => {
    // Toda variação falha como o fail-safe faz: sem PUT, sem timestamp.
    ;(pushVariantStockToNuvemshop as any).mockResolvedValue({ success: false, skipped: false, error: 'stock_resolution_failed: stock_balances: timeout' })

    let cursor = 0
    let calls = 0
    let last: any
    for (;;) {
      last = await (await POST(req({ limit: 25, cursor }))).json()
      calls++
      if (last.done || last.processed === 0) break
      cursor = last.next_cursor
      if (calls > 5) throw new Error('não terminou')
    }

    expect(calls).toBe(2)
    expect(last).toMatchObject({ ok: true, done: true, success: 0, remaining_unsynced: 30 })
    expect(pushVariantStockToNuvemshop).toHaveBeenCalledTimes(30)
    expect(tables.produto_map.every((r) => r.last_stock_synced_at === null)).toBe(true)
  })

  it('sem contexto Nuvemshop → responde o erro do contexto', async () => {
    ;(requireNuvemshopRouteContext as any).mockResolvedValue({ ctx: null, response: NextResponse.json({ error: 'x' }, { status: 404 }) })
    expect((await POST(req({}))).status).toBe(404)
  })
})
