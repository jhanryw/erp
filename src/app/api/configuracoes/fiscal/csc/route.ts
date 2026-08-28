export const dynamic = 'force-dynamic'

/**
 * CSC (Código de Segurança do Contribuinte) — seção 28 do pedido.
 * GET nunca devolve o token completo (só os últimos 4 caracteres
 * mascarados). PUT salva CSC ID (não-secreto) + CSC Token (cifrado,
 * mesmo cofre do certificado) PRA UM AMBIENTE EXPLÍCITO (`environment`,
 * obrigatório — nunca inferido, ver comentário em `saveCsc`). Admin-only.
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

// `environment` OBRIGATÓRIO, sem default — achado real (incidente de
// produção): quando este campo não existia, o backend inferia o ambiente
// de um campo de config não relacionado (nunca atualizado), e um CSC de
// PRODUÇÃO acabou sincronizado como homologação na Focus. Nunca mais uma
// suposição — a UI precisa perguntar explicitamente qual ambiente.
const putSchema = z.object({
  environment: z.enum(['homologacao', 'producao'], { errorMap: () => ({ message: 'Selecione o ambiente (homologação ou produção).' }) }),
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

  const result = await saveCsc({
    companyId: user.company_id, userId: user.id,
    environment: parsed.data.environment, cscId: parsed.data.csc_id, cscToken: parsed.data.csc_token,
  })
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'fiscal_csc',
    detail: `CSC atualizado (ambiente: ${parsed.data.environment}, ID ${parsed.data.csc_id}) — sync Focus: ${result.data.focus.status}`,
  })

  // Nunca reduzir a `{saved: true}` — salvar localmente e sincronizar com a
  // Focus são resultados distintos, a UI precisa saber dos dois.
  return ok({ saved: true, focus: result.data.focus })
}
