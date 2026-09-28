export const dynamic = 'force-dynamic'

import { auditLog } from '@/lib/audit/log'
import { completeShopeeOAuth } from '@/services/integrations/shopee.service'
import { isShopeeError } from '@/lib/integrations/shopee/errors'
import { integrationPageLocation, requireIntegrationAdmin, safeRedirect } from '../_shared'

/**
 * GET /api/integrations/shopee/callback — retorno da autorização da Shopee
 * (?code&shop_id&state). Valida o state (hash, uso único, TTL, empresa e
 * usuário da sessão), troca o code no SERVIDOR e redireciona para a tela da
 * integração SEM code/token na URL (Referrer-Policy: no-referrer).
 *
 * Exige sessão admin (o navegador que volta da Shopee é o que iniciou o
 * fluxo). NÃO está em PUBLIC_PATHS. A empresa nunca vem da URL.
 */
export async function GET(request: Request) {
  const { user, response } = await requireIntegrationAdmin()
  if (response) {
    return safeRedirect(integrationPageLocation({ shopee: 'error', reason: response.status === 403 ? 'forbidden' : 'session' }))
  }

  const params = new URL(request.url).searchParams
  let result: Record<string, string>
  try {
    const outcome = await completeShopeeOAuth(
      { userId: user.id, companyId: user.company_id },
      { code: params.get('code'), shopId: params.get('shop_id'), state: params.get('state'), error: params.get('error') },
    )
    auditLog({
      userId: user.id, userRole: user.role, action: outcome.reconnected ? 'update' : 'create',
      resource: 'company_integration', resourceId: outcome.integrationId,
      detail: `shopee: loja ${outcome.shopId} ${outcome.reconnected ? 'reconectada' : 'conectada'}`,
    })
    result = { shopee: outcome.reconnected ? 'reconnected' : 'connected' }
  } catch (err) {
    result = { shopee: 'error', reason: isShopeeError(err) ? err.kind : 'internal' }
  }
  return safeRedirect(integrationPageLocation(result))
}
