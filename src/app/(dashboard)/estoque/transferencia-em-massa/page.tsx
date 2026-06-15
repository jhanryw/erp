import { createAdminClient } from '@/lib/supabase/admin'
import {
  BulkTransferForm,
  type LocationForSelect,
  type StockItemForTransfer,
} from './_components/bulk-transfer-form'

export const dynamic = 'force-dynamic'

async function getData(): Promise<{
  locations:  LocationForSelect[]
  stockItems: StockItemForTransfer[]
}> {
  const admin = createAdminClient()

  const [locationsResult, itemsResult] = await Promise.all([
    (admin as any)
      .from('stock_locations')
      .select('id, name, is_main_store')
      .eq('active', true)
      .order('priority', { ascending: true }),
    (admin as any)
      .from('vw_stock_live_multi')
      .select(
        'product_variation_id, product_name, sku_variation, sku_parent, cor, tamanho, balances_by_location',
      )
      .gt('total_qty', 0)
      .order('product_name', { ascending: true })
      .order('tamanho',      { ascending: true })
      .order('cor',          { ascending: true }),
  ])

  return {
    locations:  (locationsResult.data ?? []) as LocationForSelect[],
    stockItems: (itemsResult.data     ?? []) as StockItemForTransfer[],
  }
}

export default async function TransferenciaEmMassaPage() {
  const { locations, stockItems } = await getData()

  return (
    <div className="mx-auto max-w-3xl space-y-0">
      <BulkTransferForm locations={locations} stockItems={stockItems} />
    </div>
  )
}
