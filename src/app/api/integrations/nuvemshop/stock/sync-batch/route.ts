import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

const DELAY_MS = 300

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: { limit?: number } = {}
  try { body = await request.json() } catch { /* sem body — usa padrão */ }

  const limit = Math.min(Math.max(body.limit ?? 25, 1), 50)
  const admin  = createAdminClient()

  // 1. Buscar próximo lote: NULL first, depois mais antigas (garante progresso linear)
  const { data: mappings, error: fetchError } = (await (admin as any)
    .from('produto_map')
    .select('product_variation_id')
    .eq('source', 'nuvemshop')
    .not('external_variant_id', 'is', null)
    .not('product_variation_id', 'is', null)
    .order('last_stock_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit)) as {
      data: Array<{ product_variation_id: number }> | null
      error: { message: string } | null
    }

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 })
  }

  const variationIds = (mappings ?? []).map((m) => m.product_variation_id)

  if (variationIds.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, success: 0, failed: 0, remaining_unsynced: 0, errors: [] })
  }

  // 2. Processar cada variação do lote
  let processed = 0
  let success   = 0
  let failed    = 0
  const errors: Array<{ variation_id: number; error: string }> = []

  for (let i = 0; i < variationIds.length; i++) {
    const variationId = variationIds[i]

    const result = await pushVariantStockToNuvemshop(variationId, { eventType: 'stock_push_erp' })
    processed++

    if (result.skipped) {
      failed++
      errors.push({ variation_id: variationId, error: 'Sem mapeamento externo' })
    } else if (result.success) {
      success++
    } else {
      failed++
      errors.push({ variation_id: variationId, error: result.error ?? 'Erro desconhecido' })
    }

    if (i < variationIds.length - 1) {
      await sleep(DELAY_MS)
    }
  }

  // 3. Contar quantas ainda precisam de sync pela primeira vez
  const { count: remainingUnsynced } = (await (admin as any)
    .from('produto_map')
    .select('*', { count: 'exact', head: true })
    .eq('source', 'nuvemshop')
    .not('external_variant_id', 'is', null)
    .not('product_variation_id', 'is', null)
    .is('last_stock_synced_at', null)) as { count: number | null }

  return NextResponse.json({
    ok:                true,
    processed,
    success,
    failed,
    remaining_unsynced: remainingUnsynced ?? 0,
    errors,
  })
}
