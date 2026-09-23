import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { publishProductToNuvemshop } from '@/services/nuvemshop/publish.service'
import { getNuvemshopPublicationOverview } from '@/services/nuvemshop/publicationStatus.service'

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Legado (sem UI): publica todos os produtos NÃO PUBLICADOS da empresa.
 * Mantida por compatibilidade; delega ao service canônico.
 */
export async function POST() {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  const overview = await getNuvemshopPublicationOverview(ctx.companyId)
  if (!overview.ok) return NextResponse.json({ error: overview.error }, { status: 500 })
  const pending = overview.data.items.filter((i) => i.state === 'not_published')

  const results: Array<{ product_id: number; name: string; status: 'ok' | 'error' | 'no_variants'; external_id?: string; variants_mapped?: number; error?: string }> = []
  for (const item of pending) {
    const r = await publishProductToNuvemshop(ctx, item.id)
    if (r.status === 'published' || r.status === 'relinked' || r.status === 'already_published') {
      results.push({ product_id: item.id, name: item.name, status: 'ok', external_id: r.remoteProductId, variants_mapped: r.variantsMapped })
    } else if (r.code === 'no_active_variations') {
      results.push({ product_id: item.id, name: item.name, status: 'no_variants' })
    } else {
      results.push({ product_id: item.id, name: item.name, status: 'error', error: r.message })
    }
    await sleep(DELAY_MS)
  }

  return NextResponse.json({
    total_pending: pending.length,
    synced:        results.filter((r) => r.status === 'ok').length,
    errors:        results.filter((r) => r.status === 'error').length,
    no_variants:   results.filter((r) => r.status === 'no_variants').length,
    results,
  })
}
