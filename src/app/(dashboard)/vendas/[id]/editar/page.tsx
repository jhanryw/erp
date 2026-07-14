import { createAdminClient } from '@/lib/supabase/admin'
import { resolveOrThrow, type PgErrorLike } from '@/lib/errors/pgResult'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EditSaleForm } from './EditSaleForm'

export const dynamic = 'force-dynamic'

async function getSale(id: string) {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('sales')
    .select('id, sale_number, sale_origin, notes, sale_date, status')
    .eq('id', Number(id))
    .single() as {
      data: { id: number; sale_number: string; sale_origin: string | null; notes: string | null; sale_date: string; status: string } | null
      error: PgErrorLike | null
    }
  return resolveOrThrow(data, error, 'GET /vendas/[id]/editar getSale', { sale_id: id })
}

export default async function EditarVendaPage({ params }: { params: { id: string } }) {
  const sale = await getSale(params.id)
  if (!sale) notFound()

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/vendas/${sale.id}`}>
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-lg font-semibold">Editar Venda</h1>
          <p className="text-sm text-text-muted font-mono">{sale.sale_number}</p>
        </div>
      </div>

      <EditSaleForm sale={sale} />
    </div>
  )
}
