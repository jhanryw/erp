export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { getMediaByPublicId, resolveMediaUrl } from '@/services/media.service'
import { ok, err, forbidden, notFound } from '@/lib/api/response'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidPublicId(publicId: string): boolean {
  return UUID_RE.test(publicId)
}

// ─── GET /api/media/[publicId] ─────────────────────────────────────────────────
// Resolve uma mídia já enviada para uma URL utilizável (pública estável ou
// signed URL). Não audita (leitura pura, mesmo padrão do resto do projeto).

export async function GET(_req: Request, { params }: { params: { publicId: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  if (!isValidPublicId(params.publicId)) {
    return err('public_id inválido.', 400)
  }

  const media = await getMediaByPublicId(params.publicId, user.company_id)
  if (!media) return notFound('Mídia')

  const resolved = await resolveMediaUrl(media)
  if (!resolved.ok) return err(resolved.error, resolved.status)

  // Nunca retornar `id` (interno) nem `storage_key` (path do bucket).
  return ok({
    media: {
      public_id: media.public_id,
      visibility: media.visibility,
      mime_type: media.mime_type,
      extension: media.extension,
      file_size: media.file_size,
      original_filename: media.original_filename,
      alt_text: media.alt_text,
      status: media.status,
      created_source: media.created_source,
      active: media.active,
      created_at: media.created_at,
      url: resolved.data.url,
      url_expires_at: resolved.data.expiresAt,
    },
  })
}
