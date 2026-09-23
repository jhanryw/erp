import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { listNuvemshopMappingsForCompany } from '@/services/nuvemshop/mappings.service'
import { mappedVariationIds } from '@/services/nuvemshop/stockBatch'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'

const DELAY_MS = 300

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST() {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch { /* cliente desconectou */ }
      }

      try {
        const rows = await listNuvemshopMappingsForCompany(ctx.companyId)
        if (!rows.ok) {
          send({ type: 'error', message: `Erro ao buscar mapeamentos: ${rows.error}` })
          controller.close()
          return
        }

        const variationIds = mappedVariationIds(rows.data)

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

          if (result.invalidated) {
            send({ type: 'variant', status: 'error', variation_id: variationId, index: i + 1, error: 'Excluído na Nuvemshop — vínculo removido' })
            errors++
          } else if (result.skipped) {
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
