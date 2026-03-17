import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import Image from 'next/image'
import { Plus, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'

async function getProducts() {
  const supabase = createClient()
  const { data } = await supabase
    .from('products')
    .select(`
      id, name, sku, base_cost, base_price, margin_pct, photo_url, active, origin,
      categories:category_id (id, name),
      suppliers:supplier_id (id, name)
    `)
    .order('name', { ascending: true }) as unknown as { data: any[] | null, error: any }

  return data ?? []
}

export default async function ProdutosPage() {
  const products = await getProducts()

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Produtos</h2>
          <p className="text-sm text-text-muted">{products.length} produto{products.length !== 1 ? 's' : ''} cadastrado{products.length !== 1 ? 's' : ''}</p>
        </div>
        <Link href="/produtos/novo">
          <Button size="sm">
            <Plus className="w-4 h-4" />
            Novo Produto
          </Button>
        </Link>
      </div>

      <Card>
        {products.length === 0 ? (
          <EmptyState
            icon={Package}
            title="Nenhum produto cadastrado"
            description="Cadastre o primeiro produto do catálogo."
            action={{ label: 'Cadastrar produto', href: '/produtos/novo' }}
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">{products.length} itens</p>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead align="right">Custo</TableHead>
                  <TableHead align="right">Preço</TableHead>
                  <TableHead align="right">Margem</TableHead>
                  <TableHead align="center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow
                    key={product.id}
                    className="group"
                  >
                    <TableCell>
                      <Link
                        href={`/produtos/${product.id}`}
                        className="flex items-center gap-3 group-hover:text-accent"
                      >
                        <div className="w-9 h-9 rounded-lg bg-bg-overlay flex items-center justify-center flex-shrink-0 overflow-hidden">
                          {product.photo_url ? (
                            <Image
                              src={product.photo_url}
                              alt={product.name}
                              width={36}
                              height={36}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Package className="w-4 h-4 text-text-muted" />
                          )}
                        </div>
                        <span className="font-medium text-sm line-clamp-1">{product.name}</span>
                      </Link>
                    </TableCell>
                    <TableCell muted>
                      <code className="text-xs bg-bg-overlay px-1.5 py-0.5 rounded">
                        {product.sku}
                      </code>
                    </TableCell>
                    <TableCell muted>
                      {(product.categories as any)?.name ?? '—'}
                    </TableCell>
                    <TableCell muted>
                      {(product.suppliers as any)?.name ?? '—'}
                    </TableCell>
                    <TableCell align="right" muted>
                      {formatCurrency(product.base_cost)}
                    </TableCell>
                    <TableCell align="right" className="font-medium">
                      {formatCurrency(product.base_price)}
                    </TableCell>
                    <TableCell align="right">
                      <span
                        className={`text-sm font-semibold ${
                          product.margin_pct >= 40
                            ? 'text-success'
                            : product.margin_pct >= 25
                            ? 'text-warning'
                            : 'text-error'
                        }`}
                      >
                        {formatPercent(product.margin_pct)}
                      </span>
                    </TableCell>
                    <TableCell align="center">
                      <Badge variant={product.active ? 'success' : 'default'} size="sm">
                        {product.active ? 'Ativo' : 'Inativo'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </div>
  )
}
