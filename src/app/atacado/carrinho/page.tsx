import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { resolveSiteTexts } from '@/services/wholesale/siteTexts'
import { CarrinhoClient } from './CarrinhoClient'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

export default async function CarrinhoPage() {
  const tenant = await resolveWholesaleSiteTenant()
  const settings = tenant ? await getWholesaleSiteSettings(tenant.companyId) : null

  if (settings && !settings.catalogActive) return null // catálogo desativado (controle mestre)

  const texts = resolveSiteTexts(settings?.texts, settings?.displayName ?? null)

  return (
    <CarrinhoClient
      minimumOrderAmount={settings?.minimumOrderAmount ?? 0}
      minimumOrderNote={texts.minimumOrderNote}
      addAlsoTitle={texts.addAlsoTitle}
    />
  )
}
