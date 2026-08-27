export const dynamic = 'force-dynamic'

/**
 * CSC (Código de Segurança do Contribuinte) — seção 28 do pedido.
 * GET nunca devolve o token completo (só os últimos 4 caracteres
 * mascarados). PUT salva CSC ID (não-secreto) + CSC Token (cifrado,
 * mesmo cofre do certificado). Admin-only.
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { auditLog } from '@/lib/audit/log'
import { getCscMasked, saveCsc } from '@/services/fiscal/certificateService'

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await getCscMasked(user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok(result.data)
}

const putSchema = z.object({
  csc_id: z.string().trim().min(1, 'CSC ID é obrigatório.'),
  csc_token: z.string().trim().min(1, 'CSC Token é obrigatório.'),
})

export async function PUT(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try { body = await request.json() } catch {
    return err('JSON inválido.', 400)
  }
  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const result = await saveCsc({ companyId: user.company_id, userId: user.id, cscId: parsed.data.csc_id, cscToken: parsed.data.csc_token })
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'fiscal_csc',
    detail: `CSC atualizado (ID ${parsed.data.csc_id})`,
  })

  return ok({ saved: true })
}
