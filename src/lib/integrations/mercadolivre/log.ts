/**
 * Log operacional do Mercado Livre — SEM segredo por construção: só campos
 * de uma allowlist entram no registro (qualquer outro campo é descartado,
 * nunca serializado), e textos livres passam por `redactSecrets`.
 */

import { redactSecrets } from './errors'

export type MercadoLivreEvent =
  | 'mercadolivre.oauth.started'
  | 'mercadolivre.oauth.completed'
  | 'mercadolivre.oauth.failed'
  | 'mercadolivre.token.refreshed'
  | 'mercadolivre.token.refresh_failed'
  | 'mercadolivre.token.refresh_waited'
  | 'mercadolivre.integration.validated'
  | 'mercadolivre.integration.disconnected'
  | 'mercadolivre.api.error'

export interface MercadoLivreLogFields {
  company_id?: number | null
  integration_id?: number | null
  seller_id?: string | null
  user_id?: string | null
  http_status?: number | null
  request_id?: string | null
  worker_id?: string | null
  reason?: string | null
  path?: string | null
  duration_ms?: number | null
}

const ALLOWED_KEYS: ReadonlyArray<keyof MercadoLivreLogFields> = [
  'company_id', 'integration_id', 'seller_id', 'user_id', 'http_status',
  'request_id', 'worker_id', 'reason', 'path', 'duration_ms',
]

export type LogSink = (line: string) => void

let sink: LogSink = (line) => console.info(line)

/** Só para testes — permite capturar e inspecionar as linhas emitidas. */
export function setMercadoLivreLogSink(next: LogSink | null): void {
  sink = next ?? ((line) => console.info(line))
}

export function buildLogLine(event: MercadoLivreEvent, fields: MercadoLivreLogFields = {}): string {
  const safe: Record<string, unknown> = { event, ts: new Date().toISOString() }
  for (const key of ALLOWED_KEYS) {
    const value = fields[key]
    if (value === undefined || value === null) continue
    safe[key] = typeof value === 'string' ? redactSecrets(value).slice(0, 300) : value
  }
  return JSON.stringify(safe)
}

export function logMercadoLivre(event: MercadoLivreEvent, fields: MercadoLivreLogFields = {}): void {
  try {
    sink(buildLogLine(event, fields))
  } catch {
    // log nunca derruba o fluxo
  }
}
