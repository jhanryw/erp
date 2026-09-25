import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  baseTables,
  createFakeNuvemshopApi,
  createNuvemshopFakeDb,
  ctxCompany1,
  ctxCompany2,
  mediaRow,
  publicUrl,
  usageRow,
  type FakeNuvemshopApi,
  type NsFakeDbOptions,
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
  addNuvemshopProductImage:   (...a: any[]) => (h.api.addNuvemshopProductImage as any)(...a),
  NuvemshopTransportError:    class NuvemshopTransportError extends Error { readonly ambiguous = true },
  isNuvemshopNotFound:        (e: unknown) => h.api.isNuvemshopNotFound(e),
}))
vi.mock('@/services/nuvemshop/context.service', () => ({
  resolveNuvemshopContextForCompany: async (companyId: number) => {
    const ctx = h.ctxByCompany.get(companyId)
    return ctx ? { ok: true, data: ctx } : { ok: false, error: 'Nuvemshop não configurada para esta empresa.', status: 404 }
  },
}))
// availability.service NÃO é mockado: roda de verdade sobre o fake DB, cuja
// RPC padrão responde "função inexistente" (migration de kits ausente). O mock
// fixo anterior (getSellableQuantity → 42) escondia o envio de estoque 0.

import { publishProductToNuvemshop } from './publish.service'
import { processNuvemshopProductDeleted } from './productWebhook.service'
import { reconcileNuvemshopProducts } from './reconcile.service'
import { getNuvemshopPublicationOverview } from './publicationStatus.service'
import { selectPendingStockBatch } from './stockBatch'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

let tables: NsFakeTables
let dbOptions: NsFakeDbOptions

const mapRows = (productId?: number) =>
  tables.produto_map.filter((r) => r.source === 'nuvemshop' && (productId == null || r.produto_id === productId))
const variantRow = (variationId: number) => tables.produto_map.find((r) => r.product_variation_id === variationId)
const productRow = (productId: number) => tables.produto_map.find((r) => r.produto_id === productId && r.product_variation_id == null)

beforeEach(() => {
  tables = baseTables()
  dbOptions = {}
  h.api = createFakeNuvemshopApi()
  h.ctxByCompany = new Map([[1, ctxCompany1], [2, ctxCompany2]])
  ;(createAdminClient as any).mockImplementation(() => createNuvemshopFakeDb(tables, dbOptions))
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
    // Soma real de stock_balances da variação 101 (3), não um valor mockado.
    expect(push).toMatchObject({ success: true, skipped: false, newQty: 3 })
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

describe('estoque fail-safe (migration de kits ausente / falhas de banco)', () => {
  const syncLogs = () => tables.nuvemshop_sync_logs.filter((l) => l.event_type === 'stock_push_erp')

  async function publishAndResetPuts() {
    const pub = await publishProductToNuvemshop(ctxCompany1, 10)
    h.api.calls.stockPuts.length = 0
    return pub
  }

  it('RPC de disponibilidade inexistente + produto normal → envia a soma de stock_balances', async () => {
    await publishAndResetPuts()
    // rpc padrão do fake = PGRST202 (função não existe)
    const r = await pushVariantStockToNuvemshop(102)
    expect(r).toMatchObject({ success: true, newQty: 5 })
    expect(h.api.calls.stockPuts).toEqual([expect.objectContaining({ qty: 5 })])
  })

  it('coluna product_kind inexistente → produto tratado como normal, valor legado', async () => {
    await publishAndResetPuts()
    dbOptions.missingColumns = ['product_kind']
    const r = await pushVariantStockToNuvemshop(101)
    expect(r).toMatchObject({ success: true, newQty: 3 })
    expect(h.api.calls.stockPuts.at(-1)?.qty).toBe(3)
  })

  it('erro na query de stock_balances → nenhum PUT, success=false, timestamp preservado', async () => {
    await publishAndResetPuts()
    const before = variantRow(101)!.last_stock_synced_at
    dbOptions.failSelectTables = ['stock_balances']
    const r = await pushVariantStockToNuvemshop(101)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/^stock_resolution_failed: stock_balances/)
    expect(r.newQty).toBeUndefined()
    expect(h.api.calls.stockPuts).toHaveLength(0)
    expect(variantRow(101)!.last_stock_synced_at).toBe(before)
    expect(syncLogs().at(-1)).toMatchObject({ success: false, stock_after: null, error_message: expect.stringMatching(/stock_resolution_failed/) })
  })

  it('erro ao ler variação/tipo do produto (não é schema ausente) → nenhum PUT', async () => {
    await publishAndResetPuts()
    dbOptions.failSelectTables = ['product_variations']
    const r = await pushVariantStockToNuvemshop(101)
    expect(r.success).toBe(false)
    expect(h.api.calls.stockPuts).toHaveLength(0)
  })

  it('kit com RPC falhando → nenhum PUT (nunca 0)', async () => {
    await publishAndResetPuts()
    tables.products.find((p) => p.id === 10)!.product_kind = 'kit'
    const r = await pushVariantStockToNuvemshop(101)
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/stock_resolution_failed: disponibilidade do kit/) })
    expect(h.api.calls.stockPuts).toHaveLength(0)
    expect(variantRow(101)!.last_stock_synced_at ?? null).toBeNull()
  })

  it('kit com RPC funcionando → envia o valor derivado dos componentes', async () => {
    await publishAndResetPuts()
    tables.products.find((p) => p.id === 10)!.product_kind = 'kit'
    dbOptions.rpc = (name, args) => name === 'rpc_get_variation_availability'
      ? { data: args.p_variation_ids.map((id: number) => ({ product_variation_id: id, product_id: 10, product_kind: 'kit', manual_enabled: true, sellable_quantity: 2, inventory_available: true, is_sellable: true })), error: null }
      : { data: null, error: { message: 'rpc inesperada' } }
    const r = await pushVariantStockToNuvemshop(101)
    expect(r).toMatchObject({ success: true, newQty: 2 })
    expect(h.api.calls.stockPuts.at(-1)?.qty).toBe(2)
  })

  it('publicação aborta se o estoque não puder ser carregado (nada criado com 0)', async () => {
    dbOptions.failSelectTables = ['stock_balances']
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'db_error' })
    expect(r.message).toMatch(/publicação abortada/)
    expect(h.api.calls.create).toBe(0)
    expect(mapRows(10)).toHaveLength(0)
  })
})

describe('publicação com imagens do Media Hub (Fase 1)', () => {
  /** Troca as imagens do produto 10 por N imagens de galeria + 1 principal. */
  function setProduct10Images(total: number) {
    tables.media = tables.media.filter((m) => m.company_id !== 1 || !String(m.storage_key).startsWith('1/p10'))
    tables.media_usages = tables.media_usages.filter((u) => u.entity_id !== '10')
    for (let i = 1; i <= total; i++) {
      tables.media.push(mediaRow(100 + i, 1, `p10-${i}`, 'jpg'))
      tables.media_usages.push(usageRow(100 + i, 100 + i, 1, 'product', '10', i === 1 ? 'primary' : 'gallery', i))
    }
  }
  const payloadImages = () => h.api.calls.createPayloads.at(-1)?.images ?? []
  const lastPublishLog = () => tables.nuvemshop_sync_logs.filter((l) => l.event_type === 'product_publish').at(-1)

  it('produto simples + 1 imagem: imagem vai no POST /products com position 1', async () => {
    const r = await publishProductToNuvemshop(ctxCompany1, 11)
    expect(r.status).toBe('published')
    expect(payloadImages()).toEqual([{ src: publicUrl('1/p11-main.jpg'), position: 1 }])
    expect(r.images).toMatchObject({ found: 1, sentInitial: 1, sentAfter: 0, failed: 0 })
  })

  it('várias imagens: principal primeiro, galeria em seguida', async () => {
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.status).toBe('published')
    expect(payloadImages()).toEqual([
      { src: publicUrl('1/p10-main.jpg'), position: 1 },
      { src: publicUrl('1/p10-gal.png'), position: 2 },
    ])
  })

  it('exatamente 9 imagens: todas no payload inicial, nenhuma depois', async () => {
    setProduct10Images(9)
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(payloadImages()).toHaveLength(9)
    expect(h.api.calls.addedImages).toHaveLength(0)
    expect(r.images).toMatchObject({ found: 9, sentInitial: 9, sentAfter: 0, failed: 0 })
  })

  it('12 imagens: 9 no POST /products, 10–12 pelo endpoint de imagens', async () => {
    setProduct10Images(12)
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(payloadImages().map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(h.api.calls.addedImages.map((i) => [i.productId, i.position])).toEqual([
      [r.remoteProductId, 10], [r.remoteProductId, 11], [r.remoteProductId, 12],
    ])
    expect(r.images).toMatchObject({ found: 12, sentInitial: 9, sentAfter: 3, failed: 0 })
    expect(r.warnings).toBeUndefined()
  })

  it('falha numa imagem adicional: produto e vínculo mantidos, falha parcial registrada', async () => {
    setProduct10Images(11)
    h.api.options.failAddImagePositions = [11]
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.status).toBe('published')
    expect(r.images).toMatchObject({ sentInitial: 9, sentAfter: 1, failed: 1 })
    expect(r.warnings?.[0]).toMatch(/1 de 11 imagem/)
    expect(productRow(10)?.external_id).toBe(r.remoteProductId)
    expect(variantRow(101)).toBeDefined()
    expect(h.api.stores.get('111')?.has(r.remoteProductId!)).toBe(true)
    expect(lastPublishLog()).toMatchObject({
      success: false,
      error_message: expect.stringMatching(/imagem 11/),
      metadata: expect.objectContaining({ images_found: 11, images_sent_initial: 9, images_sent_after: 1, images_failed: 1, result: 'published_partial_images' }),
    })
  })

  it('imagens do payload inicial recusadas pela loja contam como falha parcial', async () => {
    h.api.options.acceptInitialImages = 1
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.status).toBe('published')
    expect(r.images).toMatchObject({ sentInitial: 2, failed: 1 })
  })

  it('produto sem imagem: bloqueado antes de qualquer chamada remota', async () => {
    tables.media_usages = tables.media_usages.filter((u) => u.entity_id !== '10')
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'no_images' })
    expect(r.message).toMatch(/pelo menos uma imagem pública/)
    expect(h.api.calls.create).toBe(0)
    expect(mapRows(10)).toHaveLength(0)
  })

  it('só imagem privada/inativa conta como "sem imagem"', async () => {
    tables.media.find((m) => m.id === 1)!.visibility = 'private'
    tables.media.find((m) => m.id === 2)!.active = false
    expect((await publishProductToNuvemshop(ctxCompany1, 10)).code).toBe('no_images')
  })

  it('isolamento: mídia de outra empresa não é enviada', async () => {
    tables.media_usages = tables.media_usages.filter((u) => u.entity_id !== '10')
    tables.media_usages.push(usageRow(90, 4, 1, 'product', '10', 'primary', 0)) // mídia 4 é da empresa 2
    expect((await publishProductToNuvemshop(ctxCompany1, 10)).code).toBe('no_images')
    expect(h.api.calls.create).toBe(0)
  })

  it('imagens das variações entram depois das do produto', async () => {
    tables.media.push(mediaRow(50, 1, 'v102-main', 'webp'))
    tables.media_usages.push(usageRow(50, 50, 1, 'product_variation', '102', 'primary', 0))
    await publishProductToNuvemshop(ctxCompany1, 10)
    expect(payloadImages().map((i) => i.src)).toEqual([publicUrl('1/p10-main.jpg'), publicUrl('1/p10-gal.png'), publicUrl('1/v102-main.webp')])
  })

  it('price_override prevalece; sem override usa base_price', async () => {
    tables.product_variations.find((v) => v.id === 102)!.price_override = 129.9
    await publishProductToNuvemshop(ctxCompany1, 10)
    const variants = h.api.calls.createPayloads.at(-1)!.variants
    expect(variants.find((v) => v.sku === 'VR-P')?.price).toBe(100)
    expect(variants.find((v) => v.sku === 'VR-M')?.price).toBe(129.9)
  })

  it('preço inválido (negativo) bloqueia a publicação', async () => {
    tables.product_variations.find((v) => v.id === 101)!.price_override = -1
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'invalid_price' })
    expect(h.api.calls.create).toBe(0)
  })

  it('produto já publicado: não cria de novo nem reenvia imagens', async () => {
    setProduct10Images(11)
    await publishProductToNuvemshop(ctxCompany1, 10)
    const addedBefore = h.api.calls.addedImages.length
    const again = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(again.status).toBe('already_published')
    expect(again.images).toBeUndefined()
    expect(h.api.calls.create).toBe(1)
    expect(h.api.calls.addedImages.length).toBe(addedBefore)
  })

  it('SKU remoto sem vínculo: recusa sem criar nem enviar imagens', async () => {
    h.api.addRemote('111', { id: 777, name: { pt: 'Órfão' }, variants: [{ id: 778, sku: 'VR-P' }] })
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r.code).toBe('remote_sku_conflict')
    expect(h.api.calls.create).toBe(0)
    expect(h.api.calls.addedImages).toHaveLength(0)
  })

  it('dois cliques simultâneos no mesmo processo: só um cria', async () => {
    const [a, b] = await Promise.all([publishProductToNuvemshop(ctxCompany1, 10), publishProductToNuvemshop(ctxCompany1, 10)])
    expect([a.status, b.status].sort()).toEqual(['failed', 'published'])
    expect([a.code, b.code]).toContain('publish_in_progress')
    expect(h.api.calls.create).toBe(1)
  })

  it('timeout na criação: não grava vínculo e orienta a verificar (sem retry cego)', async () => {
    const { NuvemshopTransportError } = await import('@/lib/integrations/nuvemshop')
    h.api.createNuvemshopProductFull = async () => { throw new (NuvemshopTransportError as any)('Nuvemshop não respondeu em 20s', 'timeout') }
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'remote_error' })
    expect(r.message).toMatch(/pode ter sido criado/)
    expect(mapRows(10)).toHaveLength(0)
  })

  it('token inválido (401): falha clara, nada gravado', async () => {
    h.api.getNuvemshopProductBySku = async () => { throw new Error('Nuvemshop API 401: Invalid access token') }
    const r = await publishProductToNuvemshop(ctxCompany1, 10)
    expect(r).toMatchObject({ status: 'failed', code: 'remote_error' })
    expect(r.message).toMatch(/401/)
    expect(h.api.calls.create).toBe(0)
    expect(mapRows(10)).toHaveLength(0)
  })
})
