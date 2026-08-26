import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getWholesaleSiteSettings } from '@/services/wholesale/settings'
import { listWholesaleBanners } from '@/services/wholesale/banners'
import { AtacadoConfigClient } from './_components/AtacadoConfigClient'

export const dynamic = 'force-dynamic'

export default async function ConfigAtacadoPage() {
  const profile = await requirePageRole('admin')

  if (!profile.company_id) {
    return <p className="text-sm text-error">Usuário sem empresa vinculada.</p>
  }

  const [settings, banners] = await Promise.all([
    getWholesaleSiteSettings(profile.company_id),
    listWholesaleBanners(profile.company_id),
  ])

  return <AtacadoConfigClient companyId={profile.company_id} initialSettings={settings} initialBanners={banners} />
}
