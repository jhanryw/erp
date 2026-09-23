import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { publishProductToNuvemshop } from '@/services/nuvemshop/publish.service'
import { getNuvemshopPublicationOverview } from '@/services/nuvemshop/publicationStatus.service'

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Publicação em lote com progresso (SSE) — /configuracoes/nuvemshop.
 * Sem productIds: todos os produtos ativos NÃO PUBLICADOS da empresa.
 * Com productIds: só esses (restritos à empresa pelo service).
 */
export async function POST(request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  let body: { productIds?: number[] } = {}
  try { body = await request.json() } catch { /* sem body é sync total */ }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch { /* cliente desconectou */ }
      }

      try {
        let ids: number[]
        if (Array.isArray(body.productIds) && body.productIds.length > 0) {
          ids = [...new Set(body.productIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))]
        } else {
          const overview = await getNuvemshopPublicationOverview(ctx.companyId)
          if (!overview.ok) {
            send({ type: 'error', message: overview.error })
            controller.close()
            return
          }
          ids = overview.data.items.filter((i) => i.state === 'not_published').map((i) => i.id)
        }

        send({ type: 'start', total: ids.length })
        let synced = 0, errors = 0, noVariants = 0, skipped = 0

        for (const id of ids) {
          const r = await publishProductToNuvemshop(ctx, id)
          const name = r.productName ?? `#${id}`
          if (r.status === 'published' || r.status === 'relinked') {
            send({ type: 'product', status: 'ok', name, product_id: id, variants_mapped: r.variantsMapped ?? 0, stock_total: r.stockTotal ?? 0, relinked: r.status === 'relinked' })
            synced++
          } else if (r.status === 'already_published') {
            send({ type: 'product', status: 'skipped', name, product_id: id, reason: 'Já publicado' })
            skipped++
          } else if (r.code === 'no_active_variations') {
            send({ type: 'product', status: 'no_variants', name, product_id: id })
            noVariants++
          } else {
            send({ type: 'product', status: 'error', name, product_id: id, error: r.message ?? 'Erro desconhecido' })
            errors++
          }
          await sleep(DELAY_MS)
        }

        send({ type: 'done', synced, errors, no_variants: noVariants, skipped, total: ids.length })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[sync-stream] Exceção não tratada', msg)
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
