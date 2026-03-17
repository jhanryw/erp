import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft, ArrowDownToLine } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

export const dynamic = 'force-dynamic'

async function getLotes() {
  const supabase = createClient()
  const { data } = await supabase
    .from('stock_lots')
    .select(`
      id,
      quantity_original,
      quantity_remaining,
      unit_cost,
      freight_cost,
      tax_cost,
      total_lot_cost,
      cost_per_unit,
      entry_type,
      entry_date,
      notes,
      product_variations (
        sku_variation,
        color,
        size,
        model,
        products ( name, sku )
      ),
      suppliers ( name )
    `)
    .order('entry_date', { ascending: false })
    .limit(200)

  return data ?? []
}

export default async function MovimentacoesPage() {
  const lotes = await getLotes()

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/estoque">
          <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Movimentações de Estoque</h2>
          <p className="text-sm text-text-muted">Histórico de lotes de entrada</p>
        </div>
      </div>

      <Card>
        {lotes.length === 0 ? (
          <EmptyState
            icon={<ArrowDownToLine className="w-6 h-6 text-text-muted" />}
            title="Nenhuma movimentação"
            description="Registre a primeira entrada de estoque."
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{lotes.length} lotes registrados</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto / Variação</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead align="right">Qtd</TableHead>
                  <TableHead align="right">Custo/Un</TableHead>
                  <TableHead align="right">Total Lote</TableHead>
                  <TableHead>Data</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lotes.map((item: any) => {
                  const variation = item.product_variations
                  const dims = [variation?.color, variation?.size, variation?.model]
                    .filter(Boolean)
                    .join(' / ')
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <span className="text-sm font-medium text-text-primary">
                          {variation?.products?.name}
                        </span>
                        {dims && (
                          <span className="ml-2 text-xs text-text-muted">{dims}</span>
                        )}
                        <p className="text-xs text-text-disabled mt-0.5">
                          {variation?.sku_variation}
                        </p>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            item.entry_type === 'purchase'
                              ? 'bg-info/15 text-info'
                              : 'bg-success/15 text-success'
                          }`}
                        >
                          {item.entry_type === 'purchase' ? 'Compra' : 'Produção'}
                        </span>
                      </TableCell>
                      <TableCell muted>{item.suppliers?.name ?? '—'}</TableCell>
                      <TableCell align="right">
                        <div className="flex items-center justify-end gap-1">
                          <ArrowDownToLine className="w-3 h-3 text-success" />
                          <span className="text-sm font-medium">{item.quantity_original}</span>
                        </div>
                      </TableCell>
                      <TableCell align="right" muted>
                        {formatCurrency(item.cost_per_unit)}
                      </TableCell>
                      <TableCell align="right" className="font-medium">
                        {formatCurrency(item.total_lot_cost)}
                      </TableCell>
                      <TableCell muted>{formatDate(item.entry_date)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
