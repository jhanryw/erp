export const dynamic = 'force-dynamic'

import { auditLog } from '@/lib/audit/log'
import { completeMercadoLivreOAuth } from '@/services/integrations/mercadolivre.service'
import { isMercadoLivreError } from '@/lib/integrations/mercadolivre/errors'
import { INTEGRATION_PAGE_PATH, requireIntegrationAdmin, safeRedirect } from '../_shared'

/**
 * GET /api/integrations/mercadolivre/callback — redirect_uri FIXA cadastrada
 * no DevCenter. Recebe ?code&state (ou ?error), valida o state contra a
 * sessão (mesma empresa + mesmo usuário), troca o code no SERVIDOR e
 * redireciona para a tela da integração SEM nenhum token/código na URL
 * (Referrer-Policy: no-referrer impede o code de vazar via Referer).
 *
 * Exige sessão admin: o navegador que volta do Mercado Livre é o mesmo que
 * iniciou o fluxo. NÃO está em PUBLIC_PATHS.
 */
export async function GET(request: Request) {
  const page = new URL(INTEGRATION_PAGE_PATH, request.url)
  const { user, response } = await requireIntegrationAdmin()
  if (response) {
    page.searchParams.set('ml', 'error')
    page.searchParams.set('reason', response.status === 403 ? 'forbidden' : 'session')
    return safeRedirect(page)
  }

  const params = new URL(request.url).searchParams
  try {
    const result = await completeMercadoLivreOAuth(
      { userId: user.id, companyId: user.company_id },
      { code: params.get('code'), state: params.get('state'), error: params.get('error') },
    )
    auditLog({
      userId: user.id, userRole: user.role, action: result.reconnected ? 'update' : 'create',
      resource: 'company_integration', resourceId: result.integrationId,
      detail: `mercadolivre: conta ${result.sellerId} ${result.reconnected ? 'reconectada' : 'conectada'}`,
    })
    page.searchParams.set('ml', result.reconnected ? 'reconnected' : 'connected')
  } catch (err) {
    page.searchParams.set('ml', 'error')
    page.searchParams.set('reason', isMercadoLivreError(err) ? err.kind : 'internal')
  }
  return safeRedirect(page)
}
