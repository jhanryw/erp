import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Building2, Package, Edit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'

async function getSupplier(id: string) {
  const supabase = createClient()
  const admin = createAdminClient()
  const supplierId = Number(id)

  const { data: supplier } = await supabase
    .from('suppliers')
    .select('*')
    .eq('id', supplierId)
    .single() as unknown as { data: any }

  if (!supplier) return null

  const [{ data: performance }, { data: recentLots }, { data: products }] = await Promise.all([
    admin
      .from('mv_supplier_performance' as any)
      .select('*')
      .eq('supplier_id', supplierId)
      .single() as unknown as Promise<{ data: any }>,

    admin
      .from('stock_lots')
      .select(`
        id, entry_date, quantity_original, total_lot_cost, cost_per_unit,
        product_variations (
          sku_variation, color, size,
          products (name)
        )
      `)
      .eq('supplier_id', supplierId)
      .order('entry_date', { ascending: false })
      .limit(10) as unknown as Promise<{ data: any[] }>,

    supabase
      .from('products')
      .select('id, name, sku, base_price, base_cost, margin_pct, active')
      .eq('supplier_id', supplierId)
      .order('name', { ascending: true }) as unknown as Promise<{ data: any[] }>,
  ])

  return {
    supplier,
    performance,
    recentLots: recentLots ?? [],
    products: products ?? [],
  }
}

export default async function FornecedorDetalhePage({ params }: { params: { id: string } }) {
  const result = await getSupplier(params.id)
  if (!result) notFound()

  const { supplier, performance, recentLots, products } = result
  const activeProducts = products.filter((p: any) => p.active).length

  return (
    <div className="space-y-5 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/fornecedores">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{supplier.name}</h2>
            <div className="flex items-center gap-3 mt-0.5">
              {supplier.city && (
                <span className="text-sm text-text-muted">
                  {supplier.city}{supplier.state ? `, ${supplier.state}` : ''}
                </span>
              )}
              {supplier.phone && (
                <span className="text-sm text-text-muted">{supplier.phone}</span>
              )}
              {supplier.document && (
                <span className="text-sm text-text-muted font-mono">{supplier.document}</span>
              )}
            </div>
          </div>
        </div>
        <Link href={`/fornecedores/${supplier.id}/editar`}>
          <Button variant="secondary" size="sm">
            <Edit className="w-3.5 h-3.5" />
            Editar
          </Button>
        </Link>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total Comprado"
          value={formatCurrency(performance?.total_purchased_brl ?? 0)}
          icon={<Building2 className="w-4 h-4" />}
        />
        <StatCard
          title="Receita Gerada"
          value={formatCurrency(performance?.total_revenue ?? 0)}
          subtitle="dos produtos deste fornecedor"
        />
        <StatCard
          title="Margem Média"
          value={`${(performance?.avg_margin_pct ?? 0).toFixed(1)}%`}
          subtitle="nos produtos vendidos"
        />
        <StatCard
          title="Produtos Cadastrados"
          value={activeProducts}
          subtitle={`de ${products.length} total`}
          icon={<Package className="w-4 h-4" />}
        />
      </div>

      {performance?.top_product_name && (
        <Card padding="md">
          <p className="text-sm text-text-muted">
            Produto destaque:{' '}
            <span className="font-semibold text-text-primary">{performance.top_product_name}</span>
          </p>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent lots */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-text-primary">Entradas Recentes</h3>
            </CardHeader>
            {recentLots.length === 0 ? (
              <div className="p-8 text-center text-sm text-text-muted">
                Nenhuma entrada de estoque registrada
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead>Data</TableHead>
                    <TableHead align="right">Qtd</TableHead>
                    <TableHead align="right">Custo Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentLots.map((lot: any) => {
                    const pv = lot.product_variations
                    const variation = [pv?.color, pv?.size].filter(Boolean).join(' / ')
                    return (
                      <TableRow key={lot.id}>
                        <TableCell>
                          <span className="font-medium text-text-primary">
                            {pv?.products?.name ?? '—'}
                          </span>
                          <span className="block text-xs text-text-muted">
                            {pv?.sku_variation}{variation ? ` · ${variation}` : ''}
                          </span>
                        </TableCell>
                        <TableCell muted>{formatDate(lot.entry_date)}</TableCell>
                        <TableCell align="right">{lot.quantity_original}</TableCell>
                        <TableCell align="right">{formatCurrency(lot.total_lot_cost)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>

        {/* Products */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Produtos</h3>
          </CardHeader>
          {products.length === 0 ? (
            <div className="px-4 pb-4 text-sm text-text-muted">Nenhum produto cadastrado</div>
          ) : (
            <div className="divide-y divide-border">
              {products.map((p: any) => (
                <div key={p.id} className="px-4 py-3">
                  <Link
                    href={`/produtos/${p.id}`}
                    className="text-sm font-medium text-accent hover:text-accent-muted block truncate transition-colors"
                  >
                    {p.name}
                  </Link>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-xs text-text-muted font-mono">{p.sku}</span>
                    <span className="text-xs text-text-secondary">
                      {(p.margin_pct ?? 0).toFixed(1)}% margem
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {supplier.notes && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
          <p className="text-sm text-text-secondary">{supplier.notes}</p>
        </Card>
      )}
    </div>
  )
}
