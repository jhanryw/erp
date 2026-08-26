import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { CarrinhoClient } from './CarrinhoClient'

export const dynamic = 'force-dynamic'

export default async function CarrinhoPage() {
  const tenant = await resolveWholesaleSiteTenant()
  const settings = tenant ? await getWholesaleSiteSettings(tenant.companyId) : null

  return (
    <CarrinhoClient
      minimumOrderAmount={settings?.minimumOrderAmount ?? 0}
      whatsappPhone={settings?.whatsappPhone ?? null}
      displayName={settings?.displayName ?? null}
    />
  )
}
