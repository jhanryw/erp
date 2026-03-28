import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Package, Edit } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardHeader } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { DeleteProductButton } from '../_components/delete-product-button'

export const dynamic = 'force-dynamic'

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
  created_at: string
  categories?: { id: number; name: string } | null
  suppliers?: { id: number; name: string } | null
}

type AttributeRow = {
  variation_types: { name: string; slug: string } | null
  variation_values: { value: string } | null
}

type VariationRow = {
  id: number
  sku_variation: string
  cost_override: number | null
  price_override: number | null
  active: boolean
  product_variation_attributes: AttributeRow[]
}

async function getProduct(id: string) {
  const supabase = createAdminClient()
  const productId = Number(id)

  if (!Number.isFinite(productId)) return null

  const { data: product, error: productError } = await supabase
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
      created_at,
      categories:category_id (id, name),
      suppliers:supplier_id (id, name)
    `)
    .eq('id', productId)
    .single()

  if (productError || !product) return null

  const { data: variations } = await supabase
    .from('product_variations')
    .select(`
      id,
      sku_variation,
      cost_override,
      price_override,
      active,
      product_variation_attributes (
        variation_types:variation_type_id ( name, slug ),
        variation_values:variation_value_id ( value )
      )
    `)
    .eq('product_id', productId)
    .order('sku_variation', { ascending: true })

  return {
    product: product as unknown as ProductRow,
    variations: (variations ?? []) as VariationRow[],
  }
}

const ORIGIN_LABELS: Record<string, string> = {
  own_brand: 'Marca Própria',
  third_party: 'Terceiro',
}

export default async function ProdutoDetalhePage({
  params,
}: {
  params: { id: string }
}) {
  const result = await getProduct(params.id)

  if (!result) notFound()

  const { product, variations } = result

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Link href="/produtos">
            <Button variant="outline" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Voltar
            </Button>
          </Link>

          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <code>{product.sku}</code>
              {product.categories?.name && <span>{product.categories.name}</span>}
              {product.suppliers?.name && <span>· {product.suppliers.name}</span>}
              <Badge variant={product.active ? 'default' : 'outline'}>
                {product.active ? 'Ativo' : 'Inativo'}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <Link href={`/produtos/${product.id}/editar`}>
            <Button variant="outline">
              <Edit className="mr-2 h-4 w-4" />
              Editar
            </Button>
          </Link>
          <DeleteProductButton id={product.id} redirectAfter />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Preço Base"
          value={formatCurrency(product.base_price)}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          title="Custo Base"
          value={formatCurrency(product.base_cost)}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          title="Margem"
          value={formatPercent(product.margin_pct)}
          icon={<Package className="h-4 w-4" />}
        />
        <StatCard
          title="Origem"
          value={ORIGIN_LABELS[product.origin ?? ''] ?? '—'}
          icon={<Package className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Variações ({variations.length})</h2>
        </CardHeader>

        {variations.length === 0 ? (
          <div className="px-6 pb-6 text-sm text-muted-foreground">
            Nenhuma variação cadastrada para este produto.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU Variação</TableHead>
                  <TableHead>Atributos</TableHead>
                  <TableHead>Custo</TableHead>
                  <TableHead>Preço</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {variations.map((v) => {
                  const attrs = v.product_variation_attributes
                    .map((a) => a.variation_values?.value)
                    .filter(Boolean)
                    .join(' / ')

                  return (
                    <TableRow key={v.id}>
                      <TableCell>
                        <code>{v.sku_variation}</code>
                      </TableCell>
                      <TableCell>{attrs || '—'}</TableCell>
                      <TableCell>
                        {v.cost_override != null
                          ? formatCurrency(v.cost_override)
                          : 'base'}
                      </TableCell>
                      <TableCell>
                        {v.price_override != null
                          ? formatCurrency(v.price_override)
                          : 'base'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={v.active ? 'default' : 'outline'}>
                          {v.active ? 'Ativa' : 'Inativa'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}