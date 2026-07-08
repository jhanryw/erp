export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'
import type { MediaUsageEntityType } from '@/types/database.types'
import { auditLog } from '@/lib/audit/log'
import { getMediaByPublicId, getMediaUsageById, deleteMediaUsage } from '@/services/media.service'
import { ok, err, forbidden, notFound } from '@/lib/api/response'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidPublicId(publicId: string): boolean {
  return UUID_RE.test(publicId)
}

// Mesmo mapa usado em POST /api/media/[publicId]/usages — role mínima
// exigida depende do entity_type do vínculo, não do método HTTP.
const ROLE_BY_ENTITY: Record<MediaUsageEntityType, AppRole> = {
  product: 'gerente',
  product_variation: 'gerente',
  shipment: 'usuario',
}

// ─── DELETE /api/media/[publicId]/usages/[usageId] ─────────────────────────────
// Desvincula (remove fisicamente a linha de media_usages). Nunca apaga
// `media`, nunca toca o arquivo no Storage, nunca altera `media.active`.

export async function DELETE(
  _req: Request,
  { params }: { params: { publicId: string; usageId: string } },
) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  if (!isValidPublicId(params.publicId)) {
    return err('public_id inválido.', 400)
  }

  const usageId = Number(params.usageId)
  if (!Number.isFinite(usageId) || usageId <= 0) {
    return err('usageId inválido.', 400)
  }

  const media = await getMediaByPublicId(params.publicId, user.company_id)
  if (!media) return notFound('Mídia')

  const usage = await getMediaUsageById(usageId, user.company_id)
  if (!usage || usage.media_id !== media.id) return notFound('Vínculo')

  if (!hasMinRole(user.role, ROLE_BY_ENTITY[usage.entity_type])) {
    return forbidden()
  }

  const result = await deleteMediaUsage(usageId, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'delete', resource: 'media_usage',
    resourceId: usage.id,
    before: {
      media_id: usage.media_id,
      entity_type: usage.entity_type,
      entity_id: usage.entity_id,
      role: usage.role,
      position: usage.position,
      company_id: usage.company_id,
    },
  })

  return ok({ ok: true })
}
