/**
 * Log operacional da Shopee — SEM segredo por construção: só campos de uma
 * allowlist entram no registro, e textos livres passam por `redactSecrets`.
 */

import { redactSecrets } from './errors'

export type ShopeeEvent =
  | 'shopee.oauth.started'
  | 'shopee.oauth.completed'
  | 'shopee.oauth.failed'
  | 'shopee.token.refreshed'
  | 'shopee.token.refresh_failed'
  | 'shopee.token.refresh_waited'
  | 'shopee.integration.disconnected'
  | 'shopee.api.error'

export interface ShopeeLogFields {
  company_id?: number | null
  integration_id?: number | null
  shop_id?: string | null
  user_id?: string | null
  http_status?: number | null
  request_id?: string | null
  worker_id?: string | null
  reason?: string | null
  path?: string | null
}

const ALLOWED_KEYS: ReadonlyArray<keyof ShopeeLogFields> = [
  'company_id', 'integration_id', 'shop_id', 'user_id', 'http_status', 'request_id', 'worker_id', 'reason', 'path',
]

export type LogSink = (line: string) => void

let sink: LogSink = (line) => console.info(line)

/** Só para testes — captura as linhas emitidas. */
export function setShopeeLogSink(next: LogSink | null): void {
  sink = next ?? ((line) => console.info(line))
}

export function logShopee(event: ShopeeEvent, fields: ShopeeLogFields = {}): void {
  try {
    const safe: Record<string, unknown> = { event, ts: new Date().toISOString() }
    for (const key of ALLOWED_KEYS) {
      const value = fields[key]
      if (value === undefined || value === null) continue
      safe[key] = typeof value === 'string' ? redactSecrets(value).slice(0, 300) : value
    }
    sink(JSON.stringify(safe))
  } catch {
    // log nunca derruba o fluxo
  }
}
