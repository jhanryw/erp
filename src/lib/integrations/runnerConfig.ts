/**
 * Configuração centralizada do runner de integration_outbox/deliveries
 * (Fase 5, seção 8 do pedido — "não hardcode espalhado; centralizar
 * configuração"). Único lugar do projeto que define batch size — nunca um
 * número mágico duplicado em `runner.ts`/rota/teste.
 *
 * Valores default escolhidos pelo custo atual (seção 8): a Santtorini é
 * hoje o único tenant real (ver Fase 0) e o volume de vendas está longe de
 * gerar milhares de eventos por minuto — 50 eventos de outbox e 20
 * deliveries Chatwoot por execução é folgado o bastante pra nunca acumular
 * atraso visível, e pequeno o bastante pra uma execução de cron a cada
 * poucos segundos nunca ficar presa numa request longa. Ajustável via env
 * var sem precisar de deploy de código, caso o volume cresça.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export const OUTBOX_FANOUT_BATCH_SIZE = envInt('OUTBOX_FANOUT_BATCH_SIZE', 50)
export const CHATWOOT_DELIVERY_BATCH_SIZE = envInt('CHATWOOT_DELIVERY_BATCH_SIZE', 20)
