import { Suspense } from 'react'
import Link from 'next/link'
import {
  Plus,
  Warehouse,
  AlertTriangle,
  Package,
  DollarSign,
  Boxes,
  ClipboardList,
  ArrowLeftRight,
} from 'lucide-react'

import { createAdminClient } from '@/lib/supabase/admin'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { EmptyState } from '@/components/ui/empty-state'
import { formatCurrency, formatNumber } from '@/lib/utils/currency'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getMultiStockData } from '@/services/stockList'
import { getKitStockAnnotations } from '@/services/inventory/availability.service'
import { SupplierFilter } from '@/components/ui/supplier-filter'
import { listSuppliersForFilter, parseSupplierFilter, type SupplierOption } from '@/lib/suppliers/filter'
import { EstoqueSearch } from './estoque-search'
import { EstoqueMultiTable } from './estoque-multi-table'

export const dynamic = 'force-dynamic'

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; fornecedor?: string }>
}) {
  const { q, fornecedor } = await searchParams
  const search = q?.trim() || undefined
  const supplierId = parseSupplierFilter(fornecedor)

  // Empresa SEMPRE da sessão (a view e os locais eram lidos sem filtro de empresa).
  const profile = await requirePageRole('usuario')
  const admin = createAdminClient() as any
  const [data, suppliers] = profile.company_id
    ? await Promise.all([
        getMultiStockData(admin, profile.company_id, { search, supplierId }),
        listSuppliersForFilter(admin, profile.company_id),
      ])
    : [await getMultiStockData(admin, -1, {}), [] as SupplierOption[]]

  // Kits (2026-09-23): nunca têm saldo por local — a tabela mostra a
  // disponibilidade DERIVADA dos componentes, calculada pela camada central.
  const kitAnnotations = profile.company_id
    ? await getKitStockAnnotations(profile.company_id, data.items.map((i) => i.product_variation_id))
    : null
  const kitAvailability = kitAnnotations?.ok ? Object.fromEntries(kitAnnotations.data) : {}

  // Fase 2 (ajuste final) — usuario = admin fora dos 9 módulos bloqueados.
  // Estoque não está bloqueado: valor em custo/estoque aparece para todos os
  // roles (a validação server-side de venda nunca confiou nesse valor vindo
  // do cliente — ver resolveAuthoritativeItemCosts, preservado).
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
          <p className="text-sm text-text-muted">
            {data.locations.length > 1 ? `${data.locations.length} locais ativos` : 'Posição atual'}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/estoque/entrada/lote">
            <Button variant="outline"><Plus className="mr-2 h-4 w-4" />Entrada em Lote</Button>
          </Link>
          <Link href="/estoque/entrada/matriz">
            <Button variant="outline"><Plus className="mr-2 h-4 w-4" />Entrada em Matriz</Button>
          </Link>
          <Link href="/estoque/entrada">
            <Button><Plus className="mr-2 h-4 w-4" />Registrar Entrada</Button>
          </Link>
        </div>
      </div>

      {/* Alerta de transferência */}
      {data.needsTransferCount > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/8 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-warning">
              {data.needsTransferCount} produto{data.needsTransferCount !== 1 ? 's' : ''} com
              estoque em local secundário mas sem saldo no Estoque Loja
            </p>
            <p className="text-xs text-text-secondary mt-0.5">
              Esses produtos não podem ser vendidos presencialmente até que o estoque seja
              transferido para o Estoque Loja. Use o botão &ldquo;Transferir&rdquo; na linha do produto.
            </p>
          </div>
        </div>
      )}

      {/* Stat cards completos */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard title="Produtos"          value={formatNumber(data.productCount)} icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="Quantidade Total"  value={formatNumber(data.totalQty)}     icon={<Warehouse className="h-4 w-4" />} />
        <StatCard title="Valor em Custo"    value={formatCurrency(data.totalCostValue)} icon={<DollarSign className="h-4 w-4" />} />
        <StatCard title="Valor em Venda"    value={formatCurrency(data.totalSaleValue)} icon={<Package className="h-4 w-4" />} />
        <StatCard
          title="Alertas de Estoque"
          value={formatNumber(data.alertCount)}
          icon={<AlertTriangle className="h-4 w-4" />}
          valueClassName={data.alertCount > 0 ? 'text-warning' : undefined}
        />
      </div>

      {/* Botões de ação administrativos */}
      <div className="flex flex-wrap gap-3">
        <Link href="/estoque/movimentacoes"><Button variant="outline">Ver Movimentações</Button></Link>
        <Link href="/estoque/ajuste"><Button variant="outline">Ajuste de Estoque</Button></Link>
        <Link href="/estoque/inventario">
          <Button variant="outline"><ClipboardList className="mr-2 h-4 w-4" />Conferir Estoque</Button>
        </Link>
        {data.locations.length > 1 && (
          <>
            <Link href="/estoque/transferencia-em-massa">
              <Button variant="outline"><ArrowLeftRight className="mr-2 h-4 w-4" />Transferência em Massa</Button>
            </Link>
            <Link href="/estoque/localizacoes"><Button variant="outline">Gerenciar Locais</Button></Link>
          </>
        )}
        <Link href="/estoque/alertas">
          <Button variant="outline">
            Ver Alertas
            {data.alertCount > 0 && (
              <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning">
                {data.alertCount}
              </span>
            )}
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Suspense><EstoqueSearch defaultValue={q} /></Suspense>
        <Suspense><SupplierFilter suppliers={suppliers} selected={supplierId} /></Suspense>
      </div>

      {data.items.length === 0 ? (
        (search || supplierId !== undefined) ? (
          <EmptyState
            icon={<Warehouse className="h-4 w-4" />}
            title="Nenhum item para os filtros aplicados"
            description="Tente outro termo ou limpe o filtro de fornecedor."
          />
        ) : (
          <EmptyState
            icon={<Warehouse className="h-4 w-4" />}
            title="Estoque vazio"
            description="Registre a primeira entrada de estoque."
            action={{ label: 'Registrar entrada', href: '/estoque/entrada' }}
          />
        )
      ) : (
        <EstoqueMultiTable items={data.items} locations={data.locations} kitAvailability={kitAvailability} />
      )}
    </div>
  )
}

// ─── Visão somente consulta para usuario/vendedor ─────────────────────────────

function EstoqueLiteView({
  data,
  search,
  q,
}: {
  data: Awaited<ReturnType<typeof getMultiStockData>>
  search?: string
  q?: string
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Estoque</h1>
        <p className="text-sm text-text-muted">Consulta de disponibilidade</p>
      </div>

      {/* Apenas cards operacionais: produtos e quantidade */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard title="Produtos com Estoque" value={formatNumber(data.productCount)} icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="Quantidade Total"     value={formatNumber(data.totalQty)}     icon={<Warehouse className="h-4 w-4" />} />
      </div>

      <Suspense><EstoqueSearch defaultValue={q} /></Suspense>

      {data.items.length === 0 ? (
        <EmptyState
          icon={<Warehouse className="h-4 w-4" />}
          title={search ? `Nenhum item para "${search}"` : 'Estoque vazio'}
          description={search ? 'Tente outro termo.' : 'Nenhum produto com estoque no momento.'}
        />
      ) : (
        <EstoqueMultiTable items={data.items} locations={data.locations} />
      )}
    </div>
  )
}
