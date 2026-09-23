import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { listNuvemshopMappingsForCompany } from '@/services/nuvemshop/mappings.service'
import { mappedVariationIds } from '@/services/nuvemshop/stockBatch'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

const DELAY_MS = 300

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  try {
    const rows = await listNuvemshopMappingsForCompany(ctx.companyId)
    if (!rows.ok) {
      console.error('[stock/sync] Erro ao buscar mapeamentos:', rows.error)
      return NextResponse.json({ error: `DB error: ${rows.error}` }, { status: 500 })
    }

    const variationIds = mappedVariationIds(rows.data)
    if (variationIds.length === 0) {
      return NextResponse.json({ total: 0, synced: 0, skipped: 0, errors: 0 })
    }

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
