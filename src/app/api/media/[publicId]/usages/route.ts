export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'
import type { MediaUsageEntityType } from '@/types/database.types'
import { auditLog } from '@/lib/audit/log'
import { getMediaByPublicId, entityBelongsToCompany, createMediaUsage } from '@/services/media.service'
import { mediaUsageSchema } from '@/lib/validators'
import { ok, err, forbidden, notFound, validationError } from '@/lib/api/response'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidPublicId(publicId: string): boolean {
  return UUID_RE.test(publicId)
}

// Role mínima exigida por entity_type — product/product_variation tocam
// conteúdo de catálogo (mesmo nível de POST /api/marcas); shipment é ação
// operacional (comprovante de entrega).
//
// crm_message: valor nunca alcançado de fato — mediaUsageSchema (src/lib/
// validators/index.ts) deliberadamente NÃO lista 'crm_message' no enum de
// entity_type, então o parse falha antes de chegar aqui. Bloqueio explícito
// e documentado (Entrega 4, decisão do usuário): anexo de mensagem só é
// criado pela service layer interna do CRM (chamada direta de função,
// nunca por esta rota humana). Entrada abaixo existe só para o TypeScript
// (Record exaustivo sobre MediaUsageEntityType).
const ROLE_BY_ENTITY: Record<MediaUsageEntityType, AppRole> = {
  product: 'gerente',
  product_variation: 'gerente',
  shipment: 'usuario',
  crm_message: 'admin',
}

// ─── POST /api/media/[publicId]/usages ─────────────────────────────────────────
// Vincula uma mídia já enviada a uma entidade (product/product_variation/
// shipment). Não implementa DELETE, troca atômica de primary, RPC ou UI —
// só a criação do vínculo.

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

  const parsed = mediaUsageSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  if (!hasMinRole(user.role, ROLE_BY_ENTITY[parsed.data.entity_type])) {
    return forbidden()
  }

  const belongs = await entityBelongsToCompany(parsed.data.entity_type, parsed.data.entity_id, user.company_id)
  if (!belongs) return notFound('Entidade')

  const result = await createMediaUsage(
    {
      mediaId: media.id,
      entityType: parsed.data.entity_type,
      entityId: parsed.data.entity_id,
      role: parsed.data.role,
      position: parsed.data.position,
    },
    user.company_id,
    user.id,
  )

  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'media_usage',
    resourceId: result.data.id,
    detail: `${result.data.entity_type}:${result.data.entity_id} role=${result.data.role}`,
    after: {
      media_id: result.data.media_id,
      entity_type: result.data.entity_type,
      entity_id: result.data.entity_id,
      role: result.data.role,
      position: result.data.position,
      company_id: result.data.company_id,
    },
  })

  // media.id nunca é exposto — só media_public_id. media_usages.id é exposto
  // (identificador de vínculo, sem o mesmo motivo de segurança de media.id).
  return ok({
    media_usage: {
      id: result.data.id,
      media_public_id: media.public_id,
      entity_type: result.data.entity_type,
      entity_id: result.data.entity_id,
      role: result.data.role,
      position: result.data.position,
      created_at: result.data.created_at,
    },
  }, 201)
}
