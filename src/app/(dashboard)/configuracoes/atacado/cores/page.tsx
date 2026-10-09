import { requirePageRole } from '@/lib/auth/requirePageRole'
import { ColorGroupsManager } from './ColorGroupsManager'

export const dynamic = 'force-dynamic'

export default async function CoresAtacadoPage() {
  const profile = await requirePageRole('admin')
  if (!profile.company_id) return <p className="text-sm text-error">Usuário sem empresa vinculada.</p>
  return <ColorGroupsManager />
}
