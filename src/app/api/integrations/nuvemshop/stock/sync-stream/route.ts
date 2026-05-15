import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

const DELAY_MS = 300

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST() {
  const { response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const admin   = createAdminClient()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch { /* cliente desconectou */ }
      }

      try {
        const { data: mappings, error } = (await (admin as any)
          .from('produto_map')
          .select('product_variation_id')
          .eq('source', 'nuvemshop')
          .not('external_variant_id', 'is', null)
          .not('product_variation_id', 'is', null)) as {
            data: Array<{ product_variation_id: number }> | null
            error: { message: string } | null
          }

        if (error) {
          send({ type: 'error', message: `Erro ao buscar mapeamentos: ${error.message}` })
          controller.close()
          return
        }

        const variationIds = [...new Set((mappings ?? []).map((m) => m.product_variation_id))]

        send({ type: 'start', total: variationIds.length })

        if (variationIds.length === 0) {
          send({ type: 'done', synced: 0, errors: 0, skipped: 0, total: 0 })
          controller.close()
          return
        }

        let synced = 0, errors = 0, skipped = 0

        for (let i = 0; i < variationIds.length; i++) {
          const variationId = variationIds[i]
          const result = await pushVariantStockToNuvemshop(variationId, { eventType: 'stock_push_erp' })

          if (result.skipped) {
            send({ type: 'variant', status: 'skipped', variation_id: variationId, index: i + 1 })
            skipped++
          } else if (result.success) {
            send({ type: 'variant', status: 'ok', variation_id: variationId, index: i + 1, new_qty: result.newQty })
            synced++
          } else {
            send({ type: 'variant', status: 'error', variation_id: variationId, index: i + 1, error: result.error })
            errors++
          }

          await sleep(DELAY_MS)
        }

        send({ type: 'done', synced, errors, skipped, total: variationIds.length })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[stock/sync-stream] Exceção não tratada', msg)
        send({ type: 'error', message: msg })
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
