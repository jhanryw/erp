/** Tradução de PublishResult para resposta HTTP das rotas de envio. */

import type { PublishResult } from './publish.service'

const STATUS_BY_CODE: Record<NonNullable<PublishResult['code']>, number> = {
  not_found:              404,
  inactive:               422,
  no_active_variations:   422,
  invalid_sku:            422,
  remote_sku_conflict:    409,
  remote_error:           502,
  mapping_persist_failed: 500,
  db_error:               500,
}

export function isPublishOk(result: PublishResult): boolean {
  return result.status === 'published' || result.status === 'already_published' || result.status === 'relinked'
}

export function publishHttpStatus(result: PublishResult): number {
  if (isPublishOk(result)) return 200
  if (result.status === 'inconsistent') return 409
  return STATUS_BY_CODE[result.code ?? 'db_error']
}
