export const dynamic = 'force-dynamic'

/**
 * "Validar certificado" (seção 53 do pedido) — reabre o PFX JÁ ARMAZENADO
 * com a senha JÁ ARMAZENADA. NUNCA transmite nada fiscal, nunca aceita
 * upload aqui (isso é POST /api/configuracoes/fiscal/certificado).
 */

import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden } from '@/lib/api/response'
import { validateStoredCertificate } from '@/services/fiscal/certificateService'

export async function POST() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await validateStoredCertificate(user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok({ certificate: result.data })
}
