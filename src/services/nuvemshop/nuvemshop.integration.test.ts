import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  baseTables,
  createFakeNuvemshopApi,
  createNuvemshopFakeDb,
  ctxCompany1,
  ctxCompany2,
  type FakeNuvemshopApi,
  type NsFakeTables,
} from './nuvemshop.testutil'

const h = vi.hoisted(() => ({ api: null as unknown as FakeNuvemshopApi, ctxByCompany: new Map<number, any>() }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/integrations/nuvemshop', () => ({
  createNuvemshopProductFull: (...a: any[]) => (h.api.createNuvemshopProductFull as any)(...a),
  getNuvemshopProduct:        (...a: any[]) => (h.api.getNuvemshopProduct as any)(...a),
  getNuvemshopProductBySku:   (...a: any[]) => (h.api.getNuvemshopProductBySku as any)(...a),
  listAllNuvemshopProducts:   (...a: any[]) => (h.api.listAllNuvemshopProducts as any)(...a),
  updateVariantStock:         (...a: any[]) => (h.api.updateVariantStock as any)(...a),
  isNuvemshopNotFound:        (e: unknown) => h.api.isNuvemshopNotFound(e),
}))
vi.mock('@/services/nuvemshop/context.service', () => ({
  resolveNuvemshopContextForCompany: async (companyId: number) => {
    const ctx = h.ctxByCompany.get(companyId)
    return ctx ? { ok: true, data: ctx } : { ok: false, error: 'Nuvemshop não configurada para esta empresa.', status: 404 }
  },
}))
vi.mock('@/services/inventory/availability.service', () => ({
  getSellableQuantity: async () => ({ ok: true, data: 42 }),
  getAffectedSellableVariationIds: async (_c: number, ids: number[]) => ({ ok: true, data: ids }),
}))

import { publishProductToNuvemshop } from './publish.service'
import { processNuvemshopProductDeleted } from './productWebhook.service'
import { reconcileNuvemshopProducts } from './reconcile.service'
import { getNuvemshopPublicationOverview } from './publicationStatus.service'
import { selectPendingStockBatch } from './stockBatch'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

let tables: NsFakeTables

const mapRows = (productId?: number) =>
  tables.produto_map.filter((r) => r.source === 'nuvemshop' && (productId == null || r.produto_id === productId))
const variantRow = (variationId: number) => tables.produto_map.find((r) => r.product_variation_id === variationId)
const productRow = (productId: number) => tables.produto_map.find((r) => r.produto_id === productId && r.product_variation_id == null)

beforeEach(() => {
  tables = baseTables()
  h.api = createFakeNuvemshopApi()
  h.ctxByCompany = new Map([[1, ctxCompany1], [2, ctxCompany2]])
  ;(createAdminClient as any).mockImplementation(() => createNuvemshopFakeDb(tables))
})

describe('publicação canônica', () => {
  it('1. publica normalmente: produto + todas as variações mapeadas', async () => {
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.status).toBe('published')
    expect(r.variantsMapped).toBe(2)
    expect(productRow(10)?.external_id).toBe(r.remoteProductId)
    expect(variantRow(101)?.external_id).toBe(r.remoteProductId)
    expect(h.api.stores.get('111')?.has(r.remoteProductId!)).toBe(true)
    expect(h.api.stores.get('222')).toBeUndefined()
  })

  it('2. produto já publicado (remoto existe) não duplica', async () => {
    const first = await publishProductToNuvemshop(ctxCompany1, 10)
    const second = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(second.status).toBe('already_published')
    expect(second.remoteProductId).toBe(first.remoteProductId)
    expect(h.api.calls.create).toBe(1)
    expect(mapRows(10)).toHaveLength(3)
  })

  it('não publica produto de outra empresa', async () => {
    const r = await publishProductToNuvemshop(ctxCompany1, 20)
    expect(r).toMatchObject({ status: 'failed', code: 'not_found' })
    expect(h.api.calls.create).toBe(0)
  })

  it('13. variantes pareadas por SKU mesmo com resposta em ordem diferente', async () => {
    h.api.options.reverseVariants = true
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.status).toBe('published')
    const remote = h.api.stores.get('111')!.get(r.remoteProductId!)!
    const bySku = new Map(remote.variants.map((v) => [v.sku, String(v.id)]))
    expect(variantRow(101)?.external_variant_id).toBe(bySku.get('VR-P'))
    expect(variantRow(102)?.external_variant_id).toBe(bySku.get('VR-M'))
  })

  it('14a. SKU ausente bloqueia antes de qualquer chamada remota', async () => {
    tables.product_variations.find((v) => v.id === 102)!.sku_variation = '  '
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'invalid_sku' })
    expect(r.skuIssues).toEqual([{ variationId: 102, sku: '  ', problem: 'missing' }])
    expect(h.api.calls.create).toBe(0)
    expect(mapRows()).toHaveLength(0)
  })

  it('14b. SKU duplicado no ERP bloqueia; SKU duplicado na resposta remota não gera mapping', async () => {
    tables.product_variations.find((v) => v.id === 102)!.sku_variation = 'vr-p'
    expect((await publishProductToNuvemshop(ctxCompany1, 10)).code).toBe('invalid_sku')
    expect(h.api.calls.create).toBe(0)

    tables.product_variations.find((v) => v.id === 102)!.sku_variation = 'VR-M'
    h.api.options.duplicateRemoteSku = true
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    // Resposta remota com as duas variantes no SKU 'VR-P': nenhuma vira par.
    expect(r.status).toBe('inconsistent')
    expect(r.unmatched?.map((u) => [u.variationId, u.reason])).toEqual([[101, 'duplicate_remote_sku'], [102, 'not_found_remote']])
    expect(variantRow(101)).toBeUndefined()
    expect(variantRow(102)).toBeUndefined()
  })

  it('SKU já existente na loja sem vínculo → recusa em vez de duplicar', async () => {
    h.api.addRemote('111', { id: 777, name: { pt: 'Órfão' }, variants: [{ id: 778, sku: 'VR-P' }] })
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'remote_sku_conflict', remoteProductId: '777' })
    expect(h.api.calls.create).toBe(0)
  })

  it('falha parcial (variação sem vínculo) é reparada por SKU sem duplicar', async () => {
    const first = await publishProductToNuvemshop(ctxCompany1, 10)
    tables.produto_map = tables.produto_map.filter((r) => r.product_variation_id !== 102)
    const overview = await getNuvemshopPublicationOverview(1)
    expect(overview.ok && overview.data.items.find((i) => i.id === 10)?.state).toBe('inconsistent')

    const repair = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(repair.status).toBe('relinked')
    expect(variantRow(102)?.external_id).toBe(first.remoteProductId)
    expect(h.api.calls.create).toBe(1)
  })
})

describe('product/deleted', () => {
  it('3. invalida o vínculo e o produto volta a NÃO PUBLICADO', async () => {
    const pub = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.deleteRemote('111', pub.remoteProductId!)
    const r = await processNuvemshopProductDeleted(ctxCompany1, pub.remoteProductId!)
    expect(r.ok && r.data).toEqual({ invalidated_products: [10], removed_rows: 3 })
    expect(mapRows(10)).toHaveLength(0)
    // ERP intacto
    expect(tables.products.find((p) => p.id === 10)).toBeDefined()
    expect(tables.product_variations.filter((v) => v.product_id === 10)).toHaveLength(2)
    expect(tables.stock_balances).toHaveLength(3)
    const overview = await getNuvemshopPublicationOverview(1)
    expect(overview.ok && overview.data.items.find((i) => i.id === 10)?.state).toBe('not_published')
  })

  it('4. evento repetido é idempotente', async () => {
    const pub = await publishProductToNuvemshop(ctxCompany1, 10)
    await processNuvemshopProductDeleted(ctxCompany1, pub.remoteProductId!)
    const again = await processNuvemshopProductDeleted(ctxCompany1, pub.remoteProductId!)
    expect(again.ok && again.data).toEqual({ invalidated_products: [], removed_rows: 0 })
  })

  it('5. exclusão numa loja não afeta outra empresa com o mesmo ID remoto', async () => {
    tables.produto_map.push(
      { id: 'a1', source: 'nuvemshop', produto_id: 10, product_variation_id: null, external_id: '999', external_variant_id: null },
      { id: 'a2', source: 'nuvemshop', produto_id: 10, product_variation_id: 101, external_id: '999', external_variant_id: '9991' },
      { id: 'b1', source: 'nuvemshop', produto_id: 20, product_variation_id: null, external_id: '999', external_variant_id: null },
      { id: 'b2', source: 'nuvemshop', produto_id: 20, product_variation_id: 201, external_id: '999', external_variant_id: '9992' },
    )
    const r = await processNuvemshopProductDeleted(ctxCompany2, '999')
    expect(r.ok && r.data.invalidated_products).toEqual([20])
    expect(tables.produto_map.map((x) => x.id).sort()).toEqual(['a1', 'a2'])
  })

  it('evento atrasado do produto remoto ANTIGO não apaga o vínculo novo', async () => {
    const first = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.deleteRemote('111', first.remoteProductId!)
    const second = await publishProductToNuvemshop(ctxCompany1, 10)
    const late = await processNuvemshopProductDeleted(ctxCompany1, first.remoteProductId!)
    expect(late.ok && late.data.removed_rows).toBe(0)
    expect(productRow(10)?.external_id).toBe(second.remoteProductId)
  })
})

describe('republicação', () => {
  it('11/12. republica após exclusão com novos IDs e o estoque usa os IDs novos', async () => {
    const first = await publishProductToNuvemshop(ctxCompany1, 10)
    const oldVariant = variantRow(101)!.external_variant_id
    h.api.deleteRemote('111', first.remoteProductId!)

    const second = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(second.status).toBe('published')
    expect(second.previousRemoteProductId).toBe(first.remoteProductId)
    expect(second.remoteProductId).not.toBe(first.remoteProductId)
    expect(productRow(10)?.external_id).toBe(second.remoteProductId)
    expect(variantRow(101)?.external_id).toBe(second.remoteProductId)
    expect(variantRow(101)?.external_variant_id).not.toBe(oldVariant)
    expect(mapRows(10)).toHaveLength(3)

    const push = await pushVariantStockToNuvemshop(101)
    expect(push).toMatchObject({ success: true, skipped: false, newQty: 42 })
    expect(h.api.calls.stockPuts.at(-1)).toMatchObject({ storeId: '111', productId: second.remoteProductId, variantId: variantRow(101)!.external_variant_id })
  })
})

describe('reconciliação', () => {
  it('6/7. detecta produto excluído e mantém mapping válido', async () => {
    const a = await publishProductToNuvemshop(ctxCompany1, 10)
    tables.product_variations.find((v) => v.id === 111)!.sku_variation = 'SS-U'
    const b = await publishProductToNuvemshop(ctxCompany1, 11)
    h.api.deleteRemote('111', a.remoteProductId!)

    const r = await reconcileNuvemshopProducts(ctxCompany1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({ checked: 2, valid: 1, remote_deleted: 1, inconsistent_variants: 0, remote_unlinked: 0, errors: 0 })
    expect(mapRows(10)).toHaveLength(0)
    expect(productRow(11)?.external_id).toBe(b.remoteProductId)
    expect(variantRow(111)).toBeDefined()
  })

  it('8. variante ausente é invalidada e reportada; nada é criado', async () => {
    const a = await publishProductToNuvemshop(ctxCompany1, 10)
    const deadVariant = variantRow(102)!.external_variant_id
    h.api.deleteRemoteVariant('111', a.remoteProductId!, deadVariant)

    const r = await reconcileNuvemshopProducts(ctxCompany1)
    expect(r.ok && r.data.inconsistent_variants).toBe(1)
    expect(r.ok && r.data.details.inconsistent_variants[0]).toMatchObject({ product_id: 10, product_variation_id: 102, remote_variant_id: deadVariant })
    expect(variantRow(102)).toBeUndefined()
    expect(variantRow(101)).toBeDefined()
    expect(h.api.calls.create).toBe(1)
  })

  it('9. produto remoto sem vínculo é só reportado (não importado)', async () => {
    h.api.addRemote('111', { id: 888, name: { pt: 'Criado no painel' }, variants: [{ id: 889, sku: 'X-1' }] })
    const before = tables.produto_map.length
    const r = await reconcileNuvemshopProducts(ctxCompany1)
    expect(r.ok && r.data.remote_unlinked).toBe(1)
    expect(r.ok && r.data.details.remote_unlinked[0]).toEqual({ remote_product_id: '888', name: 'Criado no painel', skus: ['X-1'] })
    expect(tables.produto_map.length).toBe(before)
    expect(tables.products).toHaveLength(3)
  })

  it('dryRun reporta sem alterar', async () => {
    const a = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.deleteRemote('111', a.remoteProductId!)
    const r = await reconcileNuvemshopProducts(ctxCompany1, { dryRun: true })
    expect(r.ok && r.data.remote_deleted).toBe(1)
    expect(mapRows(10)).toHaveLength(3)
  })

  it('falha ao listar a loja aborta sem alterar nada', async () => {
    await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.listAllNuvemshopProducts = async () => { throw new Error('HTTP 500') }
    const r = await reconcileNuvemshopProducts(ctxCompany1)
    expect(r.ok).toBe(false)
    expect(mapRows(10)).toHaveLength(3)
  })

  it('reconciliação da empresa 2 não enxerga nem altera mappings da empresa 1', async () => {
    await publishProductToNuvemshop(ctxCompany1, 10)
    const r = await reconcileNuvemshopProducts(ctxCompany2)
    expect(r.ok && r.data).toMatchObject({ checked: 0, remote_deleted: 0 })
    expect(mapRows(10)).toHaveLength(3)
  })
})

describe('404 no push de estoque', () => {
  it('10a. produto excluído → invalida o vínculo inteiro e não repete o push', async () => {
    const a = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.deleteRemote('111', a.remoteProductId!)
    const r = await pushVariantStockToNuvemshop(101)
    expect(r).toMatchObject({ success: false, invalidated: 'product' })
    expect(mapRows(10)).toHaveLength(0)
    const again = await pushVariantStockToNuvemshop(101)
    expect(again).toEqual({ success: true, skipped: true })
  })

  it('10b. só a variante excluída → invalida só ela', async () => {
    const a = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.deleteRemoteVariant('111', a.remoteProductId!, variantRow(102)!.external_variant_id)
    const r = await pushVariantStockToNuvemshop(102)
    expect(r).toMatchObject({ success: false, invalidated: 'variant' })
    expect(variantRow(102)).toBeUndefined()
    expect(productRow(10)).toBeDefined()
    expect(variantRow(101)).toBeDefined()
  })
})

describe('lista de produtos', () => {
  it('15. produto sem estoque aparece como NÃO PUBLICADO', async () => {
    const r = await getNuvemshopPublicationOverview(1)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const semEstoque = r.data.items.find((i) => i.id === 11)
    expect(semEstoque).toMatchObject({ state: 'not_published', stock_total: 0 })
    expect(r.data.items.map((i) => i.id)).not.toContain(20)
    expect(r.data.counts).toMatchObject({ not_published: 2, published: 0, inconsistent: 0, without_stock: 1 })
  })
})

describe('sync-batch', () => {
  it('16. termina mesmo com variações que sempre falham', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: i, produto_id: 1, product_variation_id: i + 1, external_id: '1', external_variant_id: String(i), last_stock_synced_at: null,
    }))
    // Simula todas falhando: nenhuma recebe last_stock_synced_at.
    let cursor = 0
    let iterations = 0
    const visited: number[] = []
    for (;;) {
      const b = selectPendingStockBatch(rows, cursor, 25)
      visited.push(...b.variationIds)
      iterations++
      if (b.done || b.variationIds.length === 0) break
      cursor = b.nextCursor
      if (iterations > 10) throw new Error('não terminou')
    }
    expect(iterations).toBe(3)
    expect(new Set(visited).size).toBe(60)
  })
})
