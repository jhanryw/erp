export const dynamic = 'force-dynamic'

/**
 * Tokens da Focus NFe (Motor Fiscal Configurável — Certificado/CSC):
 * `emission_token_homologacao`, `emission_token_producao`, `master_token`.
 * GET nunca devolve o valor completo (só os últimos 4 caracteres
 * mascarados). PUT salva um campo por vez — nunca aceita os 3 juntos, pra
 * a UI poder confirmar cada substituição isoladamente. Admin-only.
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { auditLog } from '@/lib/audit/log'
import { getFocusTokensMasked, saveEmissionToken, saveMasterToken } from '@/services/fiscal/focusCredentials.service'

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await getFocusTokensMasked(user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok({ ...result.data })
}

const putSchema = z.object({
  field: z.enum(['emission_token_homologacao', 'emission_token_producao', 'master_token']),
  token: z.string().trim().min(1, 'Token é obrigatório.'),
})

export async function PUT(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return err('JSON inválido.', 400)
  }
  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const result = parsed.data.field === 'master_token'
    ? await saveMasterToken({ companyId: user.company_id, userId: user.id, token: parsed.data.token })
    : await saveEmissionToken({
        companyId: user.company_id,
        userId: user.id,
        environment: parsed.data.field === 'emission_token_producao' ? 'producao' : 'homologacao',
        token: parsed.data.token,
      })

  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'fiscal_focus_token',
    detail: `Token Focus atualizado (${parsed.data.field})`,
  })

  return ok({ saved: true })
}
