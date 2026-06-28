import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ExchangeForm } from './ExchangeForm'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

async function getExchangeData(saleId: number) {
  const admin = createAdminClient()

  // Venda com itens
  const { data: sale } = await (admin as any)
    .from('sales')
    .select(`
      id, sale_number, sale_date, status, total, customer_id,
      customers:customer_id (id, name),
      sale_items (
        id, quantity, unit_price, total_price,
        product_variations (
          id, sku_variation,
          products (id, name),
          product_variation_attributes (
            variation_types:variation_type_id (slug, name),
            variation_values:variation_value_id (value)
          )
        )
      )
    `)
    .eq('id', saleId)
    .single() as unknown as { data: any }

  if (!sale) return null

  // Quantidades já devolvidas via trocas anteriores para cada sale_item
  const { data: existingExchangeItems } = await (admin as any)
    .from('exchange_items')
    .select('sale_item_id, quantity_returned, exchanges!inner(original_sale_id, status)')
    .eq('exchanges.original_sale_id', saleId)
    .eq('exchanges.status', 'completed') as unknown as {
      data: { sale_item_id: number; quantity_returned: number }[] | null
    }

  const alreadyReturned: Record<number, number> = {}
  for (const ei of existingExchangeItems ?? []) {
    alreadyReturned[ei.sale_item_id] =
      (alreadyReturned[ei.sale_item_id] ?? 0) + ei.quantity_returned
  }

  // Enriquecer itens com available_to_return
  const items = (sale.sale_items ?? []).map((item: any) => ({
    ...item,
    already_returned:    alreadyReturned[item.id] ?? 0,
    available_to_return: item.quantity - (alreadyReturned[item.id] ?? 0),
  }))

  return { sale, items }
}

export default async function TrocaPage({ params }: { params: { id: string } }) {
  const saleId = Number(params.id)
  const result = await getExchangeData(saleId)
  if (!result) notFound()

  const { sale, items } = result

  const canExchange = ['paid', 'delivered'].includes(sale.status)
  const hasAvailable = items.some((i: any) => i.available_to_return > 0)

  const customer = Array.isArray(sale.customers) ? sale.customers[0] : sale.customers

  const serverClient = createClient()
  const { data: { user: authUser } } = await serverClient.auth.getUser()
  const profile = authUser ? await getUserProfile(authUser.id, authUser.email) : null
  const requiresAuth = profile?.role === 'usuario'

  return (
    <div className="max-w-2xl space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/vendas/${saleId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold">
            Registrar Troca —{' '}
            <span className="font-mono text-text-secondary">{sale.sale_number}</span>
          </h1>
          <p className="text-sm text-text-muted">
            {customer?.name ?? '—'} · {formatDate(sale.sale_date)}
          </p>
        </div>
      </div>

      {!canExchange && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          Esta venda está com status <strong>{sale.status}</strong> e não pode ser trocada.
        </div>
      )}

      {canExchange && !hasAvailable && (
        <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
          Todos os itens desta venda já foram devolvidos via trocas anteriores.
        </div>
      )}

      {canExchange && hasAvailable && (
        <ExchangeForm
          saleId={sale.id}
          customerId={customer?.id ?? sale.customer_id}
          customerName={customer?.name ?? ''}
          items={items}
          requiresAuth={requiresAuth}
        />
      )}
    </div>
  )
}
