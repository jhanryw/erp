import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { listNuvemshopMappingsForCompany } from '@/services/nuvemshop/mappings.service'
import { selectPendingStockBatch } from '@/services/nuvemshop/stockBatch'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

const DELAY_MS = 300

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Um lote de variações pendentes (nunca sincronizadas) da empresa.
 * Body: { limit?: number, cursor?: number }. Cliente repete com
 * `next_cursor` até `done: true` — término garantido (cursor só avança).
 */
export async function POST(request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  let body: { limit?: number; cursor?: number } = {}
  try { body = await request.json() } catch { /* sem body — usa padrão */ }

  const limit  = Math.min(Math.max(Number(body.limit) || 25, 1), 50)
  const cursor = Number.isInteger(body.cursor) && (body.cursor as number) > 0 ? (body.cursor as number) : 0

  const rows = await listNuvemshopMappingsForCompany(ctx.companyId)
  if (!rows.ok) return NextResponse.json({ ok: false, error: rows.error }, { status: 500 })

  const batch = selectPendingStockBatch(rows.data, cursor, limit)

  let processed = 0, success = 0, failed = 0, skipped = 0, invalidated = 0
  const errors: Array<{ variation_id: number; error: string }> = []

  for (let i = 0; i < batch.variationIds.length; i++) {
    const variationId = batch.variationIds[i]
    const result = await pushVariantStockToNuvemshop(variationId, { eventType: 'stock_push_erp' })
    processed++

    if (result.invalidated) {
      invalidated++
      errors.push({ variation_id: variationId, error: result.invalidated === 'product' ? 'Produto excluído na Nuvemshop — vínculo removido' : 'Variante excluída na Nuvemshop — vínculo removido' })
    } else if (result.skipped) {
      skipped++
    } else if (result.success) {
      success++
    } else {
      failed++
      errors.push({ variation_id: variationId, error: result.error ?? 'Erro desconhecido' })
    }

    if (i < batch.variationIds.length - 1) await sleep(DELAY_MS)
  }

  const after = await listNuvemshopMappingsForCompany(ctx.companyId)
  const remaining = after.ok ? selectPendingStockBatch(after.data, 0, Number.MAX_SAFE_INTEGER).variationIds.length : null

  return NextResponse.json({
    ok:                 true,
    processed,
    success,
    failed,
    skipped,
    invalidated,
    next_cursor:        batch.nextCursor,
    done:               batch.done,
    remaining_unsynced: remaining,
    errors,
  })
}
