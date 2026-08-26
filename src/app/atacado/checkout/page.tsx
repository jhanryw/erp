import { redirect } from 'next/navigation'
import { getWholesaleCustomerSession } from '@/lib/wholesale/session'
import { CheckoutClient } from './CheckoutClient'
import { getWholesaleBasePath } from '@/lib/wholesale/requestContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Finalizar pedido' }

export default async function CheckoutPage() {
  const session = await getWholesaleCustomerSession()
  if (!session) {
    const basePath = getWholesaleBasePath()
    redirect(`${wholesaleHref(basePath, '/entrar')}?redirect=${encodeURIComponent(wholesaleHref(basePath, '/checkout'))}`)
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-text-primary">Finalizar pedido</h1>
      <CheckoutClient customerName={session.name} />
    </div>
  )
}
