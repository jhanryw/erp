export const dynamic = 'force-dynamic'

/**
 * GET  /api/fiscal/health — status local da fundação fiscal (sem chamada
 *      de rede à Focus), usado pela página Configurações → Fiscal.
 * POST /api/fiscal/health — dois testes de conexão real e INDEPENDENTES,
 *      só executados quando o usuário aciona explicitamente ("Testar
 *      conexão" na UI). Nunca automático:
 *        - `emissionTest`: `GET /v2/nfce/inutilizacoes` com o token de
 *          EMISSÃO do ambiente atual — prova só a emissão.
 *        - `managementTest`: `GET /v2/empresas` com o `master_token` —
 *          prova só o gerenciamento (cadastro de empresa/certificado/CSC).
 *      Um nunca substitui o outro — os dois sempre rodam e são reportados
 *      separadamente.
 *
 * Gated a 'admin' — "Fiscal" é módulo bloqueado pra `usuario` (mesma regra
 * já confirmada em 20260812_open_cash_rpcs_to_usuario.sql) e a própria
 * página /configuracoes já é admin-only.
 *
 * O token NUNCA aparece em nenhuma das respostas.
 */

import { requireRole } from '@/lib/supabase/session'
import { ok, err, forbidden } from '@/lib/api/response'
import { getFiscalHealth, testFocusEmission, testFocusManagement } from '@/services/fiscal/health.service'

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

  const [emissionResult, managementResult] = await Promise.all([
    testFocusEmission(user.company_id),
    testFocusManagement(user.company_id),
  ])
  if (!emissionResult.ok) return err(emissionResult.error, emissionResult.status)
  if (!managementResult.ok) return err(managementResult.error, managementResult.status)

  return ok({ emissionTest: emissionResult.data, managementTest: managementResult.data })
}
