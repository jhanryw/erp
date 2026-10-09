/**
 * Log estruturado (uma linha JSON) para falhas do Media Hub.
 *
 * Só campos de diagnóstico não sensíveis: ids, bucket, motivo. NUNCA URL
 * assinada, token, nem o conteúdo do arquivo. `storage_key` é omitido de
 * propósito — `media_id`/`public_id` bastam para localizar o registro.
 */
export type MediaLogEvent =
  | 'media.url_resolve_failed'
  | 'media.upload_storage_failed'
  | 'media.upload_db_failed'
  | 'media.upload_orphan_cleanup_failed'
  | 'media.upload_orphan_cleaned'

export interface MediaLogFields {
  companyId?: number
  mediaPublicId?: string
  bucket?: string
  visibility?: string
  entityType?: string
  entityId?: string
  reason?: string
}

export function logMediaEvent(event: MediaLogEvent, fields: MediaLogFields): void {
  console.error(JSON.stringify({ level: 'error', scope: 'media-hub', event, ...fields }))
}
