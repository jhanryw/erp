import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft, AlertTriangle, Clock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'

export const dynamic = 'force-dynamic'

async function getAlerts() {
  const admin = createAdminClient()

  const [criticos, zerados] = await Promise.all([
    // Estoque crítico (qty entre 1 e 3)
    admin
      .from('mv_stock_status')
      .select('product_variation_id, product_id, product_name, sku, current_qty, stock_value_at_cost, stock_value_at_price')
      .gt('current_qty', 0)
      .lte('current_qty', 3)
      .order('current_qty', { ascending: true }),

    // Zerados
    admin
      .from('mv_stock_status')
      .select('product_variation_id, product_id, product_name, sku, current_qty, stock_value_at_cost, stock_value_at_price')
      .eq('current_qty', 0)
      .order('product_name', { ascending: true })
      .limit(50),
  ])

  return {
    criticos: criticos.data ?? [],
    zerados: zerados.data ?? [],
  }
}

export default async function AlertasPage() {
  const { criticos, zerados } = await getAlerts()
  const totalAlertas = criticos.length + zerados.length

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/estoque">
            <button className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Alertas de Estoque</h2>
            <p className="text-sm text-text-muted">
              {totalAlertas === 0 ? 'Todos os produtos com estoque adequado' : `${totalAlertas} produto${totalAlertas !== 1 ? 's' : ''} precisam de atenção`}
            </p>
          </div>
        </div>
        <Link href="/estoque/entrada">
          <Button size="sm">
            <Plus className="w-4 h-4" />
            Registrar Entrada
          </Button>
        </Link>
      </div>

      {/* Críticos (1–3 unidades) */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <h3 className="text-sm font-semibold text-text-primary">Estoque Crítico</h3>
            <span className="text-xs text-warning font-medium">
              {criticos.length} produto{criticos.length !== 1 ? 's' : ''}
            </span>
          </div>
        </CardHeader>
        {criticos.length === 0 ? (
          <EmptyState
            icon={<AlertTriangle className="w-6 h-6 text-text-muted" />}
            title="Nenhum alerta crítico"
            description="Todos os produtos estão acima do limite mínimo."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>Variação</TableHead>
                <TableHead align="right">Qtd Atual</TableHead>
                <TableHead align="right">Valor a Preço</TableHead>
                <TableHead>Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {criticos.map((item: any) => (
                <TableRow key={item.product_variation_id}>
                  <TableCell>
                    <Link
                      href={`/produtos/${item.product_id}`}
                      className="text-sm font-medium hover:text-accent"
                    >
                      {item.product_name}
                    </Link>
                  </TableCell>
                  <TableCell muted>
                    <span className="text-xs">
                      {item.sku}
                    </span>
                  </TableCell>
                  <TableCell align="right">
                    <span className="text-sm font-semibold text-warning">
                      {formatNumber(item.current_qty)}
                    </span>
                  </TableCell>
                  <TableCell align="right" muted>
                    {formatCurrency(item.stock_value_at_price)}
                  </TableCell>
                  <TableCell>
                    <Link href={`/estoque/entrada?pv=${item.product_variation_id}`}>
                      <Button size="sm" variant="secondary">
                        Repor
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Zerados */}
      {zerados.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-error" />
              <h3 className="text-sm font-semibold text-text-primary">Estoque Zerado</h3>
              <span className="text-xs text-error font-medium">
                {zerados.length} produto{zerados.length !== 1 ? 's' : ''}
              </span>
            </div>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produto</TableHead>
                <TableHead>Variação</TableHead>
                <TableHead align="right">Qtd</TableHead>
                <TableHead>Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zerados.map((item: any) => (
                <TableRow key={item.product_variation_id}>
                  <TableCell>
                    <Link
                      href={`/produtos/${item.product_id}`}
                      className="text-sm font-medium hover:text-accent"
                    >
                      {item.product_name}
                    </Link>
                  </TableCell>
                  <TableCell muted>
                    <span className="text-xs">
                      {item.sku}
                    </span>
                  </TableCell>
                  <TableCell align="right">
                    <span className="text-sm font-semibold text-error">0</span>
                  </TableCell>
                  <TableCell>
                    <Link href={`/estoque/entrada?pv=${item.product_variation_id}`}>
                      <Button size="sm" variant="secondary">
                        Repor
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {totalAlertas === 0 && (
        <div className="text-center py-10 text-text-muted text-sm">
          Estoque saudável! Nenhum produto com alerta no momento.
        </div>
      )}
    </div>
  )
}
