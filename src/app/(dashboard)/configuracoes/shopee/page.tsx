import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getShopeeConnections, type ShopeeConnectionView } from '@/services/integrations/shopee.service'
import { ShopeeIntegration } from './ShopeeIntegration'

export const dynamic = 'force-dynamic'

/**
 * Configurações → Canais de venda → Shopee (Fase 1: só a conexão das lojas).
 * Admin da empresa. A view carrega só metadados não sensíveis — nenhum token
 * nem a partner_key chega ao navegador.
 */
export default async function ShopeePage({
  searchParams,
}: {
  searchParams: { shopee?: string; reason?: string }
}) {
  const profile = await requirePageRole('admin')

  let connection: ShopeeConnectionView | null = null
  let loadError = false
  if (profile.company_id) {
    try {
      connection = await getShopeeConnections(profile.company_id)
    } catch {
      loadError = true
    }
  }

  return (
    <ShopeeIntegration
      initial={connection}
      loadError={loadError || !profile.company_id}
      flash={searchParams.shopee ?? null}
      reason={searchParams.reason ?? null}
    />
  )
}
