import { requirePageRole } from '@/lib/auth/requirePageRole'
import { NuvemshopIntegration } from './NuvemshopIntegration'

export const dynamic = 'force-dynamic'

export default async function NuvemshopPage() {
  await requirePageRole('admin')
  return <NuvemshopIntegration />
}
