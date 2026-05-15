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

  const admin = createAdminClient()

  // Buscar todas as variações já mapeadas na Nuvemshop
  const { data: mappings, error } = (await (admin as any)
    .from('produto_map')
    .select('product_variation_id')
    .eq('source', 'nuvemshop')
    .not('external_variant_id', 'is', null)
    .not('product_variation_id', 'is', null)) as {
      data: Array<{ product_variation_id: number }> | null
      error: { message: string } | null
    }

  if (error || !mappings) {
    return NextResponse.json({ error: 'Erro ao buscar mapeamentos.' }, { status: 500 })
  }

  const variationIds = [...new Set(mappings.map((m) => m.product_variation_id))]

  let synced  = 0
  let skipped = 0
  let errors  = 0

  for (const variationId of variationIds) {
    const result = await pushVariantStockToNuvemshop(variationId, { eventType: 'stock_push_erp' })

    if (result.success && !result.skipped) synced++
    else if (result.skipped) skipped++
    else errors++

    await sleep(DELAY_MS)
  }

  return NextResponse.json({
    total:   variationIds.length,
    synced,
    skipped,
    errors,
  })
}
