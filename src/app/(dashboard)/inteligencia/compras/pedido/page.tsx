import { requirePageRole } from '@/lib/auth/requirePageRole'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, ClipboardList } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  PedidoCompras,
  type PedidoItem,
  type SupplierContact,
} from './_components/pedido-compras'

export const dynamic = 'force-dynamic'

async function getPedidoData(): Promise<{
  items: PedidoItem[]
  supplierContacts: Record<number, SupplierContact>
}> {
  const admin = createAdminClient()

  const { data: rawItems, error } = await (admin as any)
    .from('vw_purchase_suggestions')
    .select(
      'product_variation_id, product_id, product_name, sku_variation, color, size, ' +
      'suggested_purchase_qty, estimated_restock_cost, recommended_supplier_id, ' +
      'recommended_supplier_name, recommended_avg_cost_per_unit, urgency, unit_cost_estimate'
    )
    .gt('suggested_purchase_qty', 0) as unknown as {
      data: PedidoItem[] | null
      error: any
    }

  if (error) console.error('pedido data error:', error.message)
  const items = rawItems ?? []

  const supplierIds = [
    ...new Set(
      items
        .map(i => i.recommended_supplier_id)
        .filter((id): id is number => id !== null)
    ),
  ]

  let supplierContacts: Record<number, SupplierContact> = {}

  if (supplierIds.length > 0) {
    const { data: contacts } = await (admin as any)
      .from('suppliers')
      .select('id, phone, city, state')
      .in('id', supplierIds) as unknown as {
        data: SupplierContact[] | null
        error: any
      }

    if (contacts) {
      for (const c of contacts) supplierContacts[c.id] = c
    }
  }

  return { items, supplierContacts }
}

export default async function PedidoPage() {
  await requirePageRole('gerente')
  const { items, supplierContacts } = await getPedidoData()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia/compras">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-3">
          <ClipboardList className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Pedido de Compra Sugerido
            </h2>
            <p className="text-sm text-text-muted">
              Revisão agrupada por fornecedor — selecione os itens antes de gerar o pedido
            </p>
          </div>
        </div>
      </div>

      <PedidoCompras items={items} supplierContacts={supplierContacts} />
    </div>
  )
}
