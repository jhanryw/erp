export const dynamic = 'force-dynamic'

/**
 * POST /api/fiscal/nfe/consultar — Fase Fiscal 2B, seção 9 do pedido.
 *
 * Verificação manual de status (não emite, não automatiza) — usado
 * quando uma tentativa anterior ficou `pending` e alguém quer checar
 * agora, sem esperar/reenviar. Qualquer usuário autenticado da empresa
 * (decisão de produto — operação fiscal de venda nunca foi pra ser
 * admin-only). Único input: `sale_id`; isolamento garantido dentro de
 * `consultNfeStatus` (sempre escopado por `user.company_id`).
 */

import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { consultNfeStatus } from '@/services/fiscal/consultNfeStatus'

const bodySchema = z.object({
  sale_id: z.number().int().positive(),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return err('JSON inválido.', 400)
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const result = await consultNfeStatus(parsed.data.sale_id, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  return ok({ status: result.data })
}
