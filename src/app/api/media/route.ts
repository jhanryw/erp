export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { createMediaFromUpload, listMediaByEntity } from '@/services/media.service'
import { mediaUploadMetaSchema } from '@/lib/validators'
import type { MediaUsageEntityType } from '@/types/database.types'
import { ok, err, forbidden, validationError } from '@/lib/api/response'

function isValidEntityType(value: string): value is MediaUsageEntityType {
  return value === 'product' || value === 'product_variation' || value === 'shipment' || value === 'company'
}

// ─── GET /api/media?entity_type=&entity_id= ────────────────────────────────────
// Lista mídias vinculadas a uma entidade, já resolvidas para URL utilizável.
// Não audita (leitura pura, mesmo padrão do resto do Media Hub).

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)
  const entityType = searchParams.get('entity_type')
  const entityId = searchParams.get('entity_id')

  if (!entityType || !entityId) {
    return err('entity_type e entity_id são obrigatórios.', 400)
  }

  if (!isValidEntityType(entityType)) {
    return err('entity_type inválido.', 400)
  }

  if (!/^\d+$/.test(entityId)) {
    return err('entity_id deve ser um inteiro positivo.', 400)
  }

  const result = await listMediaByEntity(entityType, entityId, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  return ok({ media: result.data })
}

// ─── POST /api/media ──────────────────────────────────────────────────────────
// Upload real: Storage + insert em `media`. Escopo desta entrega é só
// upload → Storage → tabela media → audit log → resposta — não cria
// media_usages, não gera thumbnails, não implementa GET/PATCH/DELETE.

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return err('multipart/form-data inválido.', 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return err('Campo "file" é obrigatório.', 400)
  }

  const parsed = mediaUploadMetaSchema.safeParse({
    visibility: formData.get('visibility') ?? undefined,
    alt_text: formData.get('alt_text') ?? undefined,
  })
  if (!parsed.success) return validationError(parsed.error.flatten())

  const buffer = Buffer.from(await file.arrayBuffer())

  const result = await createMediaFromUpload(
    {
      buffer,
      mimeType: file.type,
      fileName: file.name,
      visibility: parsed.data.visibility,
      altText: parsed.data.alt_text ?? null,
    },
    user.company_id,
    user.id,
  )

  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'media',
    resourceId: result.data.id,
    detail: result.data.original_filename ?? undefined,
    after: {
      public_id: result.data.public_id,
      company_id: result.data.company_id,
      storage_key: result.data.storage_key,
      mime_type: result.data.mime_type,
      file_size: result.data.file_size,
      visibility: result.data.visibility,
      created_source: result.data.created_source,
      extension: result.data.extension,
      original_filename: result.data.original_filename,
    },
  })

  // Nunca retornar `id` (interno) nem `storage_key` (path do bucket) —
  // só `public_id` é exposto como identificador externo.
  return ok({
    media: {
      public_id: result.data.public_id,
      visibility: result.data.visibility,
      mime_type: result.data.mime_type,
      extension: result.data.extension,
      file_size: result.data.file_size,
      original_filename: result.data.original_filename,
      alt_text: result.data.alt_text,
      status: result.data.status,
      created_source: result.data.created_source,
      created_at: result.data.created_at,
    },
  }, 201)
}
