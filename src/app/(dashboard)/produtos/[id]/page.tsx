import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Package, Edit } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { DeleteProductButton } from '../_components/delete-product-button'

export const dynamic = 'force-dynamic'

async function getProduct(id: string) {
  const supabase = createClient()
  const productId = Number(id)

  const { data: product } = await supabase
    .from('products')
    .select(`
      id, name, sku, base_cost, base_price, margin_pct, photo_url, active, origin, created_at,
      categories:category_id (id, name),
      suppliers:supplier_id (id, name)
    `)
    .eq('id', productId)
    .single() as unknown as { data: any }

  if (!product) return null

  const { data: variations } = await supabase
    .from('product_variations')
    .select('id, sku_variation, color, size, model, fabric, cost_override, price_override, active')
    .eq('product_id', productId)
    .order('sku_variation', { ascending: true }) as unknown as { data: any[] }

  return { product, variations: variations ?? [] }
}

const ORIGIN_LABELS: Record<string, string> = {
  own_brand: 'Marca Própria',
  third_party: 'Terceiro',
}

export default async function ProdutoDetalhePage({ params }: { params: { id: string } }) {
  const result = await getProduct(params.id)
  if (!result) notFound()

  const { product, variations } = result

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/produtos">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{product.name}</h2>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              <code className="text-xs bg-bg-overlay px-1.5 py-0.5 rounded text-text-muted">{product.sku}</code>
              {product.categories?.name && (
                <span className="text-sm text-text-muted">{product.categories.name}</span>
              )}
              {product.suppliers?.name && (
                <span className="text-sm text-text-muted">· {product.suppliers.name}</span>
              )}
              <Badge variant={product.active ? 'success' : 'default'} size="sm">
                {product.active ? 'Ativo' : 'Inativo'}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/produtos/${product.id}/editar`}>
            <Button variant="secondary" size="sm">
              <Edit className="w-3.5 h-3.5" />
              Editar
            </Button>
          </Link>
          <DeleteProductButton id={product.id} redirectAfter />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Custo Base"
          value={formatCurrency(product.base_cost)}
          icon={<Package className="w-4 h-4" />}
        />
        <StatCard
          title="Preço de Venda"
          value={formatCurrency(product.base_price)}
        />
        <StatCard
          title="Margem"
          value={formatPercent(product.margin_pct ?? 0)}
          subtitle={product.margin_pct >= 40 ? 'Excelente' : product.margin_pct >= 25 ? 'Boa' : 'Baixa'}
        />
        <StatCard
          title="Origem"
          value={ORIGIN_LABELS[product.origin] ?? product.origin}
        />
      </div>

      {/* Variations */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text-primary">
              Variações <span className="text-text-muted font-normal">({variations.length})</span>
            </h3>
          </div>
        </CardHeader>

        {variations.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-muted">
            Nenhuma variação cadastrada para este produto.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU Variação</TableHead>
                <TableHead>Cor</TableHead>
                <TableHead>Tamanho</TableHead>
                <TableHead>Modelo</TableHead>
                <TableHead align="right">Custo</TableHead>
                <TableHead align="right">Preço</TableHead>
                <TableHead align="center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variations.map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <code className="text-xs bg-bg-overlay px-1.5 py-0.5 rounded">{v.sku_variation}</code>
                  </TableCell>
                  <TableCell muted>{v.color ?? '—'}</TableCell>
                  <TableCell muted>{v.size ?? '—'}</TableCell>
                  <TableCell muted>{v.model ?? '—'}</TableCell>
                  <TableCell align="right" muted>
                    {v.cost_override != null ? formatCurrency(v.cost_override) : <span className="text-text-muted text-xs">base</span>}
                  </TableCell>
                  <TableCell align="right">
                    {v.price_override != null ? formatCurrency(v.price_override) : <span className="text-text-muted text-xs">base</span>}
                  </TableCell>
                  <TableCell align="center">
                    <Badge variant={v.active ? 'success' : 'default'} size="sm">
                      {v.active ? 'Ativa' : 'Inativa'}
                    </Badge>
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
