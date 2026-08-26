export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'
import type { MediaUsageEntityType } from '@/types/database.types'
import { auditLog } from '@/lib/audit/log'
import { getMediaByPublicId, setPrimaryMedia } from '@/services/media.service'
import { ok, err, forbidden, notFound, validationError } from '@/lib/api/response'
import { z } from 'zod'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidPublicId(publicId: string): boolean {
  return UUID_RE.test(publicId)
}

// Mesmo mapa usado em POST/DELETE de usages — role mínima exigida depende
// do entity_type, não do método HTTP.
//
// crm_message: nunca alcançado — bodySchema abaixo não lista 'crm_message'.
// Mensagem não tem conceito de "primary" (é role='attachment', não
// singular) — mesmo bloqueio explícito da Entrega 4, ver usages/route.ts.
// Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
// Produtos não está bloqueado: gerenciar mídia de produto liberado.
const ROLE_BY_ENTITY: Record<MediaUsageEntityType, AppRole> = {
  product: 'usuario',
  product_variation: 'usuario',
  shipment: 'usuario',
  crm_message: 'admin',
  // company: nunca alcançado — bodySchema abaixo não lista 'company'. Logo
  // é role='logo' (singular via uq_media_usages_singular_role), não
  // 'primary' — não usa esta troca atômica, ver usages/route.ts.
  company: 'admin',
}

const bodySchema = z.object({
  entity_type: z.enum(['product', 'product_variation', 'shipment']),
  entity_id: z.coerce.string().regex(/^\d+$/, 'entity_id deve ser um inteiro positivo'),
})

// ─── POST /api/media/[publicId]/primary ────────────────────────────────────────
// Troca atômica: remove o vínculo `primary` antigo da entidade (se existir)
// e cria o novo apontando pra esta mídia, na mesma transação (RPC). Não
// apaga mídia nem arquivo do Storage — só troca o vínculo em media_usages.

export async function POST(request: Request, { params }: { params: { publicId: string } }) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  if (!isValidPublicId(params.publicId)) {
    return err('public_id inválido.', 400)
  }

  const media = await getMediaByPublicId(params.publicId, user.company_id)
  if (!media) return notFound('Mídia')
  if (!media.active) return err('Mídia inativa não pode ser vinculada.', 422)

  let body: unknown
  try { body = await request.json() } catch { return err('JSON inválido.', 400) }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  if (!hasMinRole(user.role, ROLE_BY_ENTITY[parsed.data.entity_type])) {
    return forbidden()
  }

  const result = await setPrimaryMedia(
    media.id,
    parsed.data.entity_type,
    parsed.data.entity_id,
    user.company_id,
    user.id,
  )

  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'media_usage',
    resourceId: result.data.usage_id,
    detail: `${result.data.entity_type}:${result.data.entity_id} role=primary`,
    before: result.data.previous_usage_id
      ? { usage_id: result.data.previous_usage_id, media_id: result.data.previous_media_id, role: 'primary' }
      : null,
    after: {
      usage_id: result.data.usage_id,
      media_id: result.data.media_id,
      entity_type: result.data.entity_type,
      entity_id: result.data.entity_id,
      role: 'primary',
      position: result.data.position,
    },
  })

  return ok({
    media_usage: {
      usage_id: result.data.usage_id,
      media_public_id: media.public_id,
      entity_type: result.data.entity_type,
      entity_id: result.data.entity_id,
      role: 'primary',
      position: result.data.position,
      created_at: result.data.created_at,
    },
  })
}
