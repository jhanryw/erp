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

  try {
    const { data: mappings, error } = (await (admin as any)
      .from('produto_map')
      .select('product_variation_id')
      .eq('source', 'nuvemshop')
      .neq('external_variant_id', null)
      .neq('product_variation_id', null)) as {
        data: Array<{ product_variation_id: number }> | null
        error: { message: string } | null
      }

    if (error) {
      console.error('[stock/sync] Erro ao buscar mapeamentos:', error)
      return NextResponse.json({ error: `DB error: ${error.message}` }, { status: 500 })
    }

    if (!mappings || mappings.length === 0) {
      return NextResponse.json({ total: 0, synced: 0, skipped: 0, errors: 0 })
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[stock/sync] Exceção não tratada:', msg)
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
