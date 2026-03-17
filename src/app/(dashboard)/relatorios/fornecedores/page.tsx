import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'

async function getSuppliersData() {
  const supabase = createClient()
  const { data } = await supabase
    .from('mv_supplier_performance')
    .select('*')
    .order('total_revenue', { ascending: false }) as unknown as { data: any[] | null }
  return data ?? []
}

export default async function RelatorioFornecedoresPage() {
  const suppliers = await getSuppliersData()

  const totalPurchased = suppliers.reduce((s, sup) => s + (sup.total_purchased_value ?? 0), 0)
  const totalRevenue = suppliers.reduce((s, sup) => s + (sup.total_revenue ?? 0), 0)
  const totalProfit = suppliers.reduce((s, sup) => s + (sup.total_gross_profit ?? 0), 0)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/relatorios">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Relatório de Fornecedores</h2>
          <p className="text-sm text-text-muted">{suppliers.length} fornecedores com histórico</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: 'Total Comprado', value: formatCurrency(totalPurchased) },
          { label: 'Faturamento Gerado', value: formatCurrency(totalRevenue) },
          { label: 'Lucro Bruto Total', value: formatCurrency(totalProfit) },
        ].map((kpi) => (
          <div key={kpi.label} className="card p-4">
            <p className="text-xs text-text-muted mb-1">{kpi.label}</p>
            <p className="text-xl font-bold text-text-primary">{kpi.value}</p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Performance por Fornecedor</h3>
        </CardHeader>
        {suppliers.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">Nenhuma entrada de estoque registrada</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead align="right">Produtos</TableHead>
                <TableHead align="right">Lotes</TableHead>
                <TableHead align="right">Total Comprado</TableHead>
                <TableHead align="right">Unid. Vendidas</TableHead>
                <TableHead align="right">Faturamento</TableHead>
                <TableHead align="right">Lucro Bruto</TableHead>
                <TableHead align="right">Margem %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((sup) => (
                <TableRow key={sup.supplier_id}>
                  <TableCell>
                    <Link href={`/fornecedores/${sup.supplier_id}`} className="font-medium hover:text-accent">
                      {sup.supplier_name}
                    </Link>
                  </TableCell>
                  <TableCell align="right">{sup.product_count ?? 0}</TableCell>
                  <TableCell align="right">{sup.total_lots ?? 0}</TableCell>
                  <TableCell align="right">{formatCurrency(sup.total_purchased_value ?? 0)}</TableCell>
                  <TableCell align="right">{sup.total_units_sold ?? 0}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(sup.total_revenue ?? 0)}</TableCell>
                  <TableCell align="right" className="text-success">{formatCurrency(sup.total_gross_profit ?? 0)}</TableCell>
                  <TableCell align="right">
                    <span className={`font-semibold text-sm ${(sup.avg_margin_pct ?? 0) >= 30 ? 'text-success' : (sup.avg_margin_pct ?? 0) >= 15 ? 'text-warning' : 'text-error'}`}>
                      {(sup.avg_margin_pct ?? 0).toFixed(1)}%
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}
