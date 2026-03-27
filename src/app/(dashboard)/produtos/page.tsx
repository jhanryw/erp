import Link from 'next/link'
import Image from 'next/image'
import { Plus, Package } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { DeleteProductButton } from './_components/delete-product-button'

export const dynamic = 'force-dynamic'

type ProductCategory = {
  id: number
  name: string
}

type ProductSupplier = {
  id: number
  name: string
}

type ProductRow = {
  id: number
  name: string
  sku: string
  base_cost: number
  base_price: number
  margin_pct: number
  photo_url: string | null
  active: boolean
  origin: string | null
  categories: ProductCategory | ProductCategory[] | null
  suppliers: ProductSupplier | ProductSupplier[] | null
}

async function getProducts(): Promise<ProductRow[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('products')
    .select(`
      id,
      name,
      sku,
      base_cost,
      base_price,
      margin_pct,
      photo_url,
      active,
      origin,
      categories:category_id (id, name),
      suppliers:supplier_id (id, name)
    `)
    .order('name', { ascending: true })

  if (error) {
    console.error('Erro ao listar produtos:', error.message)
    return []
  }

  return (data ?? []) as unknown as ProductRow[]
}

export default async function ProdutosPage() {
  const products = await getProducts()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
          <p className="text-sm text-muted-foreground">
            {products.length} produto{products.length !== 1 ? 's' : ''} cadastrado
            {products.length !== 1 ? 's' : ''}
          </p>
        </div>

        <Button asChild>
          <Link href="/produtos/novo">
            <Plus className="mr-2 h-4 w-4" />
            Novo Produto
          </Link>
        </Button>
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Nenhum produto cadastrado"
          description="Cadastre o primeiro produto do catálogo."
          action={{ label: 'Cadastrar produto', href: '/produtos/novo' }}
        />
      ) : (
        <>
          <Card>
            <CardHeader className="text-sm text-muted-foreground">
              {products.length} itens
            </CardHeader>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Custo</TableHead>
                    <TableHead>Preço</TableHead>
                    <TableHead>Margem</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {products.map((product) => {
                    const category = Array.isArray(product.categories)
                      ? product.categories[0] ?? null
                      : product.categories ?? null

                    const supplier = Array.isArray(product.suppliers)
                      ? product.suppliers[0] ?? null
                      : product.suppliers ?? null

                    return (
                      <TableRow key={product.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            {product.photo_url ? (
                              <Image
                                src={product.photo_url}
                                alt={product.name}
                                width={40}
                                height={40}
                                className="h-10 w-10 rounded-md object-cover"
                              />
                            ) : (
                              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                                <Package className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}

                            <div className="font-medium">{product.name}</div>
                          </div>
                        </TableCell>

                        <TableCell>
                          <code>{product.sku}</code>
                        </TableCell>

                        <TableCell>{category?.name ?? '—'}</TableCell>
                        <TableCell>{supplier?.name ?? '—'}</TableCell>
                        <TableCell>{formatCurrency(product.base_cost)}</TableCell>
                        <TableCell>{formatCurrency(product.base_price)}</TableCell>

                        <TableCell>
                          <span
                            className={
                              product.margin_pct >= 40
                                ? 'text-success'
                                : product.margin_pct >= 25
                                ? 'text-warning'
                                : 'text-error'
                            }
                          >
                            {formatPercent(product.margin_pct)}
                          </span>
                        </TableCell>

                        <TableCell>
                          <Badge variant={product.active ? 'default' : 'secondary'}>
                            {product.active ? 'Ativo' : 'Inativo'}
                          </Badge>
                        </TableCell>

                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button asChild variant="outline" size="sm">
                              <Link href={`/produtos/editar/${product.id}`}>Editar</Link>
                            </Button>
                            <DeleteProductButton
                              productId={product.id}
                              productName={product.name}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}