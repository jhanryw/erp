/**
 * Um ciclo do Marketplace Hub: processa notificações pendentes e, se algum
 * pedido virou venda/cancelamento, roda o fan-out genérico de estoque
 * (stock.changed → canais). Usado pelo webhook (disparo imediato, sem
 * bloquear a resposta) e pelo job agendado (garantia).
 */

import { logMercadoLivre } from '@/lib/integrations/mercadolivre/log'
import { processInboundEvents, type InboundWorkerDeps, type ProcessInboundResult } from './inboundEvents.service'
import { runStockChannelFanout, type StockFanoutDeps, type StockFanoutResult } from './stockFanout.service'

export async function runInboundCycle(
  workerId: string,
  opts: { limit?: number; alwaysFanout?: boolean; inbound?: InboundWorkerDeps; fanout?: StockFanoutDeps } = {},
): Promise<{ inbound: ProcessInboundResult; fanout: StockFanoutResult | null }> {
  const inbound = await processInboundEvents(workerId, opts.limit ?? 10, opts.inbound)
  for (const o of inbound.outcomes) {
    logMercadoLivre(o.status === 'processed' ? 'mercadolivre.inbound.processed' : 'mercadolivre.inbound.failed', {
      event_id: o.eventId, action: o.action ?? o.status, reason: o.code ?? (o.error ? o.error.slice(0, 120) : null),
    })
  }
  const fanout = inbound.stockMayHaveChanged || opts.alwaysFanout ? await runStockChannelFanout(workerId, 200, opts.fanout) : null
  return { inbound, fanout }
}
