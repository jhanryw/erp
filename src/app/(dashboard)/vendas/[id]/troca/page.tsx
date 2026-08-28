import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { isExemptFromExchangeAuthorization } from '@/lib/auth/exchangeAuthorizationExemptions'
import { logQueryError, type PgErrorLike } from '@/lib/errors/pgResult'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ExchangeForm } from './ExchangeForm'
import { formatDate } from '@/lib/utils/date'
import type { SaleType } from '@/lib/pricing/resolveSalePrice'

export const dynamic = 'force-dynamic'

const ROUTE = 'GET /vendas/[id]/troca getExchangeData'

async function getExchangeData(saleId: number) {
  const admin = createAdminClient()

  // ── Etapa 1: venda base — sem embeds, é a única que decide notFound() ──────
  const { data: saleData, error: saleError } = await admin
    .from('sales')
    .select('id, sale_number, sale_date, status, total, customer_id, sale_type')
    .eq('id', saleId)
    .maybeSingle() as unknown as { data: any; error: PgErrorLike | null }

  if (saleError) {
    logQueryError(saleError, `${ROUTE} (sale_base)`, { sale_id: saleId, stage: 'sale_base' })
    throw new Error(`Erro ao consultar dados (${ROUTE} (sale_base)).`)
  }
  if (!saleData) return null
  const saleBase = saleData

  // ── Etapa 2: relações de 1º nível, em paralelo ──────────────────────────────
  const stage2 = await Promise.all([
    admin.from('customers').select('id, name').eq('id', saleBase.customer_id).maybeSingle(),
    admin.from('sale_items').select('id, quantity, unit_price, total_price, product_variation_id').eq('sale_id', saleBase.id),
    (admin as any)
      .from('exchange_items')
      .select('sale_item_id, quantity_returned, exchanges!inner(original_sale_id, status)')
      .eq('exchanges.original_sale_id', saleId)
      .eq('exchanges.status', 'completed'),
  ]) as any[]

  const [
    { data: customer, error: customerError },
    { data: saleItems, error: saleItemsError },
    { data: existingExchangeItems, error: existingExchangeItemsError },
  ] = stage2

  logQueryError(customerError,               `${ROUTE} (customer)`,       { sale_id: saleId, stage: 'customer' })
  logQueryError(saleItemsError,               `${ROUTE} (sale_items)`,     { sale_id: saleId, stage: 'sale_items' })
  logQueryError(existingExchangeItemsError,   `${ROUTE} (exchange_items)`, { sale_id: saleId, stage: 'exchange_items' })

  // ── Etapa 3: variações dos itens vendidos ───────────────────────────────────
  const variationIds = [...new Set((saleItems ?? []).map((i: any) => i.product_variation_id))]

  const { data: productVariations, error: productVariationsError } = variationIds.length
    ? await admin.from('product_variations').select('id, sku_variation, product_id').in('id', variationIds)
    : { data: [] as any[], error: null }
  logQueryError(productVariationsError, `${ROUTE} (product_variations)`, { sale_id: saleId, stage: 'product_variations' })

  // ── Etapa 4: produtos + atributos das variações, em paralelo ────────────────
  const productIds = [...new Set((productVariations ?? []).map((v: any) => v.product_id))]

  const stage4 = await Promise.all([
    productIds.length
      ? admin.from('products').select('id, name').in('id', productIds)
      : Promise.resolve({ data: [], error: null }),
    variationIds.length
      ? (admin as any)
          .from('product_variation_attributes')
          .select('product_variation_id, variation_types:variation_type_id(slug,name), variation_values:variation_value_id(value)')
          .in('product_variation_id', variationIds)
      : Promise.resolve({ data: [], error: null }),
  ]) as any[]

  const [
    { data: products, error: productsError },
    { data: variationAttributes, error: variationAttributesError },
  ] = stage4

  logQueryError(productsError,            `${ROUTE} (products)`,            { sale_id: saleId, stage: 'products' })
  logQueryError(variationAttributesError, `${ROUTE} (variation_attributes)`, { sale_id: saleId, stage: 'variation_attributes' })

  // ── Reagrupar no mesmo formato que a página já consome ──────────────────────
  const productsById = new Map((products ?? []).map((p: any) => [p.id, p]))

  const attrsByVariation = new Map<number, any[]>()
  for (const a of variationAttributes ?? []) {
    const list = attrsByVariation.get(a.product_variation_id) ?? []
    list.push(a)
    attrsByVariation.set(a.product_variation_id, list)
  }

  const variationsById = new Map(
    (productVariations ?? []).map((v: any) => [v.id, {
      ...v,
      products: productsById.get(v.product_id) ?? null,
      product_variation_attributes: attrsByVariation.get(v.id) ?? [],
    }])
  )

  const sale = {
    ...saleBase,
    customers: customer ?? null,
    sale_items: (saleItems ?? []).map((item: any) => ({
      ...item,
      product_variations: variationsById.get(item.product_variation_id) ?? null,
    })),
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
  const requiresAuth = profile?.role === 'usuario' && !isExemptFromExchangeAuthorization(profile.id)

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
            {' · '}
            <span className="font-medium text-text-secondary">
              {sale.sale_type === 'wholesale' ? 'Atacado' : 'Varejo'}
            </span>
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
          saleType={(sale.sale_type as SaleType) ?? 'retail'}
        />
      )}
    </div>
  )
}
