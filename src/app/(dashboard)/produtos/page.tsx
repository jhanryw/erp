import { Suspense } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Plus, Package } from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { listPrimaryMediaByEntities } from '@/services/media.service'
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
import { Pagination } from '@/components/ui/pagination'
import { formatCurrency, formatPercent } from '@/lib/utils/currency'
import { NuvemshopBulkButton } from './_components/nuvemshop-bulk-button'
import { ProductsTable, type ProductTableRow } from './_components/products-table'
import { WholesaleFilters } from './_components/wholesale-filters'
import { listProductsForAdmin, ATACADO_FILTERS, SITUACAO_FILTERS, type AtacadoFilter, type SituacaoFilter } from '@/services/wholesale/adminList'

export const dynamic = 'force-dynamic'

type ProductCategory = { id: number; name: string }
type ProductSupplier  = { id: number; name: string }
type ProductBrand     = { id: number; name: string }

type ProductRowLite = {
  id:         number
  name:       string
  sku:        string
  base_price: number
  active:     boolean
  photo_url:  string | null
  categories: ProductCategory | ProductCategory[] | null
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

// Resolve a imagem principal do Media Hub em lote (1 query, independente do
// tamanho da lista) e monta o fallback pra photo_url por produto. Falha na
// busca de mídia nunca quebra a página — mantém o fallback pra todos.
async function resolveDisplayUrls<T extends { id: number; photo_url: string | null }>(
  products: T[],
  companyId: number | null,
): Promise<(T & { displayUrl: string | null })[]> {
  if (!companyId || products.length === 0) {
    return products.map((p) => ({ ...p, displayUrl: p.photo_url }))
  }

  let mediaMap = new Map<string, string>()
  try {
    const ids = products.map((p) => String(p.id))
    const result = await listPrimaryMediaByEntities('product', ids, companyId)
    if (result.ok) {
      mediaMap = new Map(result.data.map((m) => [m.entity_id, m.url]))
    }
  } catch {
    // mantém mediaMap vazio — cada produto cai no fallback de photo_url
  }

  return products.map((p) => ({ ...p, displayUrl: mediaMap.get(String(p.id)) ?? p.photo_url }))
}

export default async function ProdutosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; atacado?: string; situacao?: string }>
}) {
  const { q, page, atacado, situacao } = await searchParams
  const search = q?.trim() || undefined
  const atacadoFilter = ATACADO_FILTERS.find((f) => f === atacado) as AtacadoFilter | undefined
  const situacaoFilter = SITUACAO_FILTERS.find((f) => f === situacao) as SituacaoFilter | undefined

  const serverClient = createClient()
  const { data: { user } } = await serverClient.auth.getUser()
  const profile = user ? await getUserProfile(user.id, user.email) : null

  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  // Produtos não está bloqueado, então custo/margem passam a aparecer para
  // todos os roles (a validação server-side de venda continua autoritativa
  // e nunca confiou nesse valor — ver resolveAuthoritativeItemCosts).
  //
  // Sempre escopado por empresa. Status do atacado calculado em LOTE só
  // para a página exibida (ver services/wholesale/adminList.ts).
  const companyId = profile?.company_id ?? null
  const result = companyId
    ? await listProductsForAdmin(createAdminClient() as any, companyId, { search, atacado: atacadoFilter, situacao: situacaoFilter, page: Number(page) || 1 })
    : { products: [], summaries: new Map(), total: 0, page: 1, totalPages: 1 }
  const withImages = await resolveDisplayUrls(result.products, companyId)

  const rows: ProductTableRow[] = withImages.map((p) => {
    const first = <T,>(v: T | T[] | null) => (Array.isArray(v) ? v[0] ?? null : v ?? null)
    const summary = result.summaries.get(p.id)
    return {
      id: p.id, name: p.name, sku: p.sku,
      category: first(p.categories)?.name ?? null,
      supplier: first(p.suppliers)?.name ?? null,
      brand: first(p.brands)?.name ?? null,
      base_cost: p.base_cost, base_price: p.base_price, margin_pct: p.margin_pct, active: p.active,
      displayUrl: p.displayUrl,
      wholesaleStatus: summary?.status ?? 'disabled',
      hasImage: summary?.hasImage ?? false,
    }
  })

  return (
    <ProdutosFullView
      rows={rows} total={result.total} page={result.page} totalPages={result.totalPages}
      search={search} atacado={atacadoFilter} situacao={situacaoFilter}
    />
  )
}

// ─── Visão completa (admin/gerente) ────────────────────────────────────────────

function ProdutosFullView({
  rows, total, page, totalPages, search, atacado, situacao,
}: {
  rows: ProductTableRow[]
  total: number
  page: number
  totalPages: number
  search?: string
  atacado?: string
  situacao?: string
}) {
  const filtered = Boolean(search || atacado || situacao)
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Produtos</h1>
          <p className="text-sm text-text-muted">
            {total} produto{total !== 1 ? 's' : ''} {filtered ? 'encontrado' : 'cadastrado'}{total !== 1 ? 's' : ''}
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

      <div className="flex flex-wrap items-center gap-4">
        <Suspense>
          <PageSearch defaultValue={search} placeholder="Buscar por nome ou SKU..." />
        </Suspense>
        <Suspense>
          <WholesaleFilters atacado={atacado} situacao={situacao} />
        </Suspense>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Package className="h-4 w-4" />}
          title={filtered ? 'Nenhum produto para os filtros aplicados' : 'Nenhum produto cadastrado'}
          description={filtered ? 'Tente outro termo ou limpe os filtros.' : 'Cadastre o primeiro produto do catálogo.'}
          action={filtered ? undefined : { label: 'Cadastrar produto', href: '/produtos/novo' }}
        />
      ) : (
        <>
          <ProductsTable rows={rows} total={total} />
          <Pagination
            page={page} totalPages={totalPages} baseUrl="/produtos" query={search}
            extraParams={{ atacado, situacao }}
          />
        </>
      )}
    </div>
  )
}

// ─── Visão reduzida (usuario/vendedor) ─────────────────────────────────────────

function ProdutosLiteView({
  products,
  search,
}: {
  products: (ProductRowLite & { displayUrl: string | null })[]
  search?: string
}) {
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
                          <ProductThumb url={product.displayUrl} name={product.name} />
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
