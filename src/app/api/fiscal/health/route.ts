export const dynamic = 'force-dynamic'

/**
 * GET  /api/fiscal/health — status local da fundação fiscal (sem chamada
 *      de rede à Focus), usado pela página Configurações → Fiscal.
 * POST /api/fiscal/health — teste de conexão real (`GET /v2/empresas` na
 *      Focus), só executado quando o usuário aciona explicitamente
 *      ("Testar conexão" na UI). Nunca automático.
 *
 * Gated a 'admin' — "Fiscal" é módulo bloqueado pra `usuario` (mesma regra
 * já confirmada em 20260812_open_cash_rpcs_to_usuario.sql) e a própria
 * página /configuracoes já é admin-only.
 *
 * O token NUNCA aparece em nenhuma das duas respostas.
 */

import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden } from '@/lib/api/response'
import { getFiscalHealth, testFocusConnection } from '@/services/fiscal/health.service'

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await getFiscalHealth(user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok({ health: result.data })
}

export async function POST() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const result = await testFocusConnection(user.company_id)
  if (!result.ok) return err(result.error, result.status)
  return ok({ connectionTest: result.data })
}
