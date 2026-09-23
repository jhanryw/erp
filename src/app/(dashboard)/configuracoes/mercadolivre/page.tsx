import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getMercadoLivreConnection, type MercadoLivreConnectionView } from '@/services/integrations/mercadolivre.service'
import { MercadoLivreIntegration } from './MercadoLivreIntegration'

export const dynamic = 'force-dynamic'

/**
 * Configurações → Canais de venda → Mercado Livre (Fase 1: só a conexão).
 * Admin da empresa, mesmo nível das demais integrações (Nuvemshop/Fiscal).
 * A view carrega só metadados não sensíveis — nenhum token chega ao navegador.
 */
export default async function MercadoLivrePage({
  searchParams,
}: {
  searchParams: { ml?: string; reason?: string }
}) {
  const profile = await requirePageRole('admin')

  let connection: MercadoLivreConnectionView | null = null
  let loadError = false
  if (profile.company_id) {
    try {
      connection = await getMercadoLivreConnection(profile.company_id)
    } catch {
      loadError = true
    }
  }

  return (
    <MercadoLivreIntegration
      initial={connection}
      loadError={loadError || !profile.company_id}
      flash={searchParams.ml ?? null}
      reason={searchParams.reason ?? null}
    />
  )
}
