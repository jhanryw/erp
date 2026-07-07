import { Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Plus, Package } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'
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
import { PageSearch } from '@/components/ui/page-search'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { DeleteProductButton } from './_components/delete-product-button'
import { NuvemshopBulkButton } from './_components/nuvemshop-bulk-button'

export const dynamic = 'force-dynamic'

type ProductCategory = { id: number; name: string }
type ProductSupplier  = { id: number; name: string }
type ProductBrand     = { id: number; name: string }

type ProductRowFull = {
  id:         number
  name:       string
  sku:        string
  base_cost:  number
  base_price: number
  margin_pct: number
  photo_url:  string | null
  active:     boolean
  categories: ProductCategory | ProductCategory[] | null
  suppliers:  ProductSupplier | ProductSupplier[] | null
  brands:     ProductBrand | ProductBrand[] | null
}

type ProductRowLite = {
  id:         number
  name:       string
  sku:        string
  base_price: number
  active:     boolean
  photo_url:  string | null
  categories: ProductCategory | ProductCategory[] | null
}

async function getProductsFull(search?: string): Promise<ProductRowFull[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('products')
    .select(`id, name, sku, base_cost, base_price, margin_pct, photo_url, active,
             categories:category_id (id, name), suppliers:supplier_id (id, name),
             brands:brand_id (id, name)`)
    .order('name', { ascending: true })

  if (search) query = (query as any).or(`name.ilike.%${search}%,sku.ilike.%${search}%`)

  const { data, error } = await query
  if (error) { console.error('Erro ao listar produtos:', error.message); return [] }
  return (data ?? []) as unknown as ProductRowFull[]
}

async function getProductsLite(search?: string): Promise<ProductRowLite[]> {
  const supabase = createAdminClient()
  let query = supabase
    .from('products')
    .select(`id, name, sku, base_price, photo_url, active, categories:category_id (id, name)`)
    .eq('active', true)
    .order('name', { ascending: true })

  if (search) query = (query as any).or(`name.ilike.%${search}%,sku.ilike.%${search}%`)

  const { data, error } = await query
  if (error) { console.error('Erro ao listar produtos:', error.message); return [] }
  return (data ?? []) as unknown as ProductRowLite[]
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const search = q?.trim() || undefined

  const serverClient = createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null
  const isManager = hasMinRole(profile?.role ?? 'usuario', 'gerente')

  if (isManager) {
    const products = await getProductsFull(search)
    return <ProdutosFullView products={products} search={search} />
  }

  const products = await getProductsLite(search)
  return <ProdutosLiteView products={products} search={search} />
}

// ─── Visão completa (admin/gerente) ────────────────────────────────────────────

function ProdutosFullView({ products, search }: { products: ProductRowFull[]; search?: string }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
          <p className="text-sm text-text-muted">
            {products.length} produto{products.length !== 1 ? 's' : ''} cadastrado{products.length !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NuvemshopBulkButton />
          <Link href="/produtos/importar"><Button variant="outline">Importar</Button></Link>
          <Link href="/produtos/novo">
            <Button><Plus className="mr-2 h-4 w-4" />Novo Produto</Button>
          </Link>
        </div>
      </div>

      <Suspense>
        <PageSearch defaultValue={search} placeholder="Buscar por nome ou SKU..." />
      </Suspense>

      {products.length === 0 ? (
        <EmptyState
          icon={<Package className="h-4 w-4" />}
          title={search ? `Nenhum produto para "${search}"` : 'Nenhum produto cadastrado'}
          description={search ? 'Tente outro termo.' : 'Cadastre o primeiro produto do catálogo.'}
          action={search ? undefined : { label: 'Cadastrar produto', href: '/produtos/novo' }}
        />
      ) : (
        <Card>
          <CardHeader className="text-sm text-text-muted">{products.length} itens</CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Fornecedor</TableHead>
                  <TableHead>Marca</TableHead>
                  <TableHead>Custo</TableHead>
                  <TableHead>Preço</TableHead>
                  <TableHead>Margem</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => {
                  const category = Array.isArray(product.categories) ? product.categories[0] ?? null : product.categories ?? null
                  const supplier = Array.isArray(product.suppliers)  ? product.suppliers[0]  ?? null : product.suppliers  ?? null
                  const brand    = Array.isArray(product.brands)     ? product.brands[0]     ?? null : product.brands     ?? null
                  return (
                    <TableRow key={product.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <ProductThumb url={product.photo_url} name={product.name} />
                          <div className="font-medium">{product.name}</div>
                        </div>
                      </TableCell>
                      <TableCell><code>{product.sku}</code></TableCell>
                      <TableCell>{category?.name ?? '—'}</TableCell>
                      <TableCell>{supplier?.name ?? '—'}</TableCell>
                      <TableCell>{brand?.name ?? '—'}</TableCell>
                      <TableCell>{formatCurrency(product.base_cost)}</TableCell>
                      <TableCell>{formatCurrency(product.base_price)}</TableCell>
                      <TableCell>
                        <span className={product.margin_pct >= 40 ? 'text-success' : product.margin_pct >= 25 ? 'text-warning' : 'text-error'}>
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
                          <Link href={`/produtos/${product.id}`}><Button variant="outline" size="sm">Ver</Button></Link>
                          <DeleteProductButton id={product.id} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Visão reduzida (usuario/vendedor) ─────────────────────────────────────────

function ProdutosLiteView({ products, search }: { products: ProductRowLite[]; search?: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
        <p className="text-sm text-text-muted">
          {products.length} produto{products.length !== 1 ? 's' : ''} ativo{products.length !== 1 ? 's' : ''}
        </p>
      </div>

      <Suspense>
        <PageSearch defaultValue={search} placeholder="Buscar por nome ou SKU..." />
      </Suspense>

      {products.length === 0 ? (
        <EmptyState
          icon={<Package className="h-4 w-4" />}
          title={search ? `Nenhum produto para "${search}"` : 'Nenhum produto disponível'}
          description={search ? 'Tente outro termo.' : 'Nenhum produto ativo no momento.'}
        />
      ) : (
        <Card>
          <CardHeader className="text-sm text-text-muted">{products.length} itens</CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead>Preço</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => {
                  const category = Array.isArray(product.categories) ? product.categories[0] ?? null : product.categories ?? null
                  return (
                    <TableRow key={product.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <ProductThumb url={product.photo_url} name={product.name} />
                          <div className="font-medium">{product.name}</div>
                        </div>
                      </TableCell>
                      <TableCell><code>{product.sku}</code></TableCell>
                      <TableCell>{category?.name ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">{formatCurrency(product.base_price)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Helper ────────────────────────────────────────────────────────────────────

function ProductThumb({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <Image src={url} alt={name} width={40} height={40} className="h-10 w-10 rounded-md object-cover" />
    )
  }
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-bg-overlay">
      <Package className="h-4 w-4 text-text-muted" />
    </div>
  )
}
