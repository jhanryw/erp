export const dynamic = 'force-dynamic'

import { auditLog } from '@/lib/audit/log'
import { completeMercadoLivreOAuth } from '@/services/integrations/mercadolivre.service'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { integrationPageLocation, requireIntegrationAdmin, safeRedirect } from '../_shared'

/**
 * GET /api/integrations/mercadolivre/callback — redirect_uri FIXA cadastrada
 * no DevCenter. Recebe ?code&state (ou ?error), valida o state contra a
 * sessão (mesma empresa + mesmo usuário), troca o code no SERVIDOR e
 * redireciona para a tela da integração SEM nenhum token/código na URL
 * (Referrer-Policy: no-referrer impede o code de vazar via Referer).
 *
 * Exige sessão admin: o navegador que volta do Mercado Livre é o mesmo que
 * iniciou o fluxo. NÃO está em PUBLIC_PATHS.
 *
 * O destino do redirect vem SEMPRE da origem pública (APP_URL); da
 * requisição só se leem os parâmetros de query.
 */
export async function GET(request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) {
    return safeRedirect(integrationPageLocation({ ml: 'error', reason: response.status === 403 ? 'forbidden' : 'session' }))
  }

  const params = new URL(request.url).searchParams
  let result: Record<string, string>
  try {
    const outcome = await completeMercadoLivreOAuth(
      { userId: user.id, companyId: user.company_id },
      { code: params.get('code'), state: params.get('state'), error: params.get('error') },
    )
    auditLog({
      userId: user.id, userRole: user.role, action: outcome.reconnected ? 'update' : 'create',
      resource: 'company_integration', resourceId: outcome.integrationId,
      detail: `mercadolivre: conta ${outcome.sellerId} ${outcome.reconnected ? 'reconectada' : 'conectada'}`,
    })
    result = { ml: outcome.reconnected ? 'reconnected' : 'connected' }
  } catch (err) {
    result = { ml: 'error', reason: isMercadoLivreError(err) ? err.kind : 'internal' }
  }
  return safeRedirect(integrationPageLocation(result))
}
