import { Suspense } from 'react'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { Plus, DollarSign, History, CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate, formatDateTime, brazilDate } from '@/lib/utils/date'
import { DeleteEntryButton } from './_components/delete-entry-button'
import { LancamentosFilters } from './_components/lancamentos-filters'

export const dynamic = 'force-dynamic'

const CATEGORY_LABELS: Record<string, string> = {
  sale: 'Venda',
  cashback_used: 'Cashback Utilizado',
  other_income: 'Outra Receita',
  stock_purchase: 'Compra de Estoque',
  freight_cost: 'Frete',
  marketing: 'Marketing',
  rent: 'Aluguel',
  salaries: 'Salários',
  operational: 'Operacional',
  taxes: 'Impostos',
  other_expense: 'Outra Despesa',
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Dinheiro',
  pix: 'PIX',
  credit_card: 'Crédito',
  debit_card: 'Débito',
  card: 'Cartão legado',
}

const ORIGIN_LABELS: Record<string, string> = {
  manual: 'Manual',
  sale: 'Venda',
  stock: 'Estoque',
  marketing: 'Marketing',
  return: 'Devolução',
  cash: 'Caixa',
}

const TYPE_VALUES = new Set(['income', 'expense'])
const STATUS_VALUES = new Set(['paid', 'pending'])
const ORIGIN_VALUES = new Set(['manual', 'sale', 'stock', 'marketing', 'return', 'cash'])
const SORT_VALUES = new Set(['created_at', 'reference_date'])
const PAGE_SIZE_OPTIONS = new Set([25, 50, 100, 200])
const DEFAULT_PAGE_SIZE = 50
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Filtro padrão da listagem: quando é criada em finance_entries (created_at),
// não quando o gasto ocorreu (reference_date/competência) — propositalmente
// diferente, para permitir auditar a leva de importação do Caixa (que tem
// created_at em julho mas reference_date de meses anteriores). Só aplicado
// quando o usuário não escolheu createdFrom/createdTo nem clicou em "Ver
// todo o histórico" (allTime=1).
const DEFAULT_CREATED_FROM = '2026-07-01'

type EntryType = 'income' | 'expense'
type OriginKey = 'manual' | 'sale' | 'stock' | 'marketing' | 'return' | 'cash'
type SortKey = 'created_at' | 'reference_date'

type EntryRow = {
  id: number
  type: EntryType
  category: string
  description: string
  amount: number
  reference_date: string
  notes: string | null
  payment_method: string | null
  paid_at: string | null
  cash_movement_id: number | null
  sale_id: number | null
  stock_lot_id: number | null
  marketing_cost_id: number | null
  return_id: number | null
  created_at: string
}

interface ParsedFilters {
  q?: string
  type?: EntryType
  category?: string
  status?: 'paid' | 'pending'
  // Data de criação no sistema (created_at) — auditoria de importação/entrada.
  createdFrom?: string
  createdTo?: string
  allTime?: boolean
  // Competência financeira (reference_date) — análise contábil, sem default.
  referenceFrom?: string
  referenceTo?: string
  origin?: OriginKey
  sort: SortKey
}

// Evita que vírgulas/parênteses do termo de busca quebrem a sintaxe do
// .or() do PostgREST (essa é a real ameaça de "injeção" aqui — não SQL,
// já que o supabase-js parametriza o ILIKE por baixo).
function escapeOrValue(value: string): string {
  return value.replace(/[,()]/g, (c) => `\\${c}`)
}

// Aritmética de calendário pura (UTC-anchored) só para achar "o dia seguinte"
// — não tem relação com o fuso horário usado na comparação de created_at.
function nextDayString(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + 1)
  return dt.toISOString().slice(0, 10)
}

function computeOrigin(entry: Pick<EntryRow, 'sale_id' | 'stock_lot_id' | 'marketing_cost_id' | 'return_id' | 'cash_movement_id'>): OriginKey {
  if (entry.cash_movement_id != null) return 'cash'
  if (entry.sale_id != null) return 'sale'
  if (entry.stock_lot_id != null) return 'stock'
  if (entry.marketing_cost_id != null) return 'marketing'
  if (entry.return_id != null) return 'return'
  return 'manual'
}

function parseFilters(sp: Record<string, string | undefined>): ParsedFilters {
  const type = sp.type && TYPE_VALUES.has(sp.type) ? (sp.type as EntryType) : undefined
  const category = sp.category && sp.category in CATEGORY_LABELS ? sp.category : undefined
  const status = sp.status && STATUS_VALUES.has(sp.status) ? (sp.status as 'paid' | 'pending') : undefined
  const origin = sp.origin && ORIGIN_VALUES.has(sp.origin) ? (sp.origin as OriginKey) : undefined
  const createdFrom = sp.createdFrom && DATE_RE.test(sp.createdFrom) ? sp.createdFrom : undefined
  const createdTo = sp.createdTo && DATE_RE.test(sp.createdTo) ? sp.createdTo : undefined
  const referenceFrom = sp.referenceFrom && DATE_RE.test(sp.referenceFrom) ? sp.referenceFrom : undefined
  const referenceTo = sp.referenceTo && DATE_RE.test(sp.referenceTo) ? sp.referenceTo : undefined
  const allTime = sp.allTime === '1'
  const sort = sp.sort && SORT_VALUES.has(sp.sort) ? (sp.sort as SortKey) : 'created_at'
  const q = sp.q?.trim() || undefined
  return { q, type, category, status, createdFrom, createdTo, allTime, referenceFrom, referenceTo, origin, sort }
}

async function getEntries(
  companyId: number,
  filters: ParsedFilters,
  effectiveCreatedFrom: string | undefined,
  effectiveCreatedTo: string | undefined,
  page: number,
  pageSize: number,
) {
  const admin = createAdminClient()

  let query = (admin as any)
    .from('finance_entries')
    .select(
      'id, type, category, description, amount, reference_date, notes, payment_method, paid_at, cash_movement_id, sale_id, stock_lot_id, marketing_cost_id, return_id, created_at',
      { count: 'exact' },
    )
    .eq('company_id', companyId)

  // Busca por texto SEMPRE combina com os filtros de data ativos (nunca os
  // ignora silenciosamente) — "aluguel" + createdFrom só acha o que também
  // estiver dentro do período.
  if (filters.q) {
    const term = escapeOrValue(filters.q)
    query = query.or(`description.ilike.%${term}%,notes.ilike.%${term}%`)
  }
  if (filters.type) query = query.eq('type', filters.type)
  if (filters.category) query = query.eq('category', filters.category)
  if (filters.status === 'paid') query = query.not('paid_at', 'is', null)
  if (filters.status === 'pending') query = query.is('paid_at', null)

  // created_at é TIMESTAMPTZ — o limite superior precisa ser "< dia seguinte
  // 00:00", nunca "<= data" (que truncaria o dia inteiro do createdTo, já
  // que qualquer horário depois da meia-noite ficaria de fora).
  if (effectiveCreatedFrom) query = query.gte('created_at', `${effectiveCreatedFrom}T00:00:00`)
  if (effectiveCreatedTo) query = query.lt('created_at', `${nextDayString(effectiveCreatedTo)}T00:00:00`)

  // reference_date é DATE — comparação direta, sem ajuste de fim de dia.
  if (filters.referenceFrom) query = query.gte('reference_date', filters.referenceFrom)
  if (filters.referenceTo) query = query.lte('reference_date', filters.referenceTo)

  if (filters.origin === 'manual') {
    query = query
      .is('sale_id', null)
      .is('stock_lot_id', null)
      .is('marketing_cost_id', null)
      .is('return_id', null)
      .is('cash_movement_id', null)
  } else if (filters.origin === 'sale') query = query.not('sale_id', 'is', null)
  else if (filters.origin === 'stock') query = query.not('stock_lot_id', 'is', null)
  else if (filters.origin === 'marketing') query = query.not('marketing_cost_id', 'is', null)
  else if (filters.origin === 'return') query = query.not('return_id', 'is', null)
  else if (filters.origin === 'cash') query = query.not('cash_movement_id', 'is', null)

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  // count: 'exact' pede ao Postgres a contagem total de linhas que batem com
  // TODOS os filtros acima, antes do .range() — não é o tamanho da página.
  const { data, error, count } = await query
    .order(filters.sort, { ascending: false })
    .order('id', { ascending: false })
    .range(from, to)

  if (error) {
    console.error('Erro ao listar lançamentos financeiros:', error.message)
    return { entries: [] as EntryRow[], total: 0, error: error.message as string }
  }

  return { entries: (data ?? []) as EntryRow[], total: (count ?? 0) as number, error: null as string | null }
}

export default async function LancamentosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const profile = await requirePageRole('gerente')

  const filters = parseFilters(sp)
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const requestedPageSize = parseInt(sp.pageSize ?? '', 10)
  const pageSize = PAGE_SIZE_OPTIONS.has(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE

  const isDefaultCreatedPeriod = !filters.createdFrom && !filters.createdTo && !filters.allTime
  const effectiveCreatedFrom = filters.createdFrom ?? (filters.allTime ? undefined : DEFAULT_CREATED_FROM)
  const effectiveCreatedTo = filters.createdTo

  const { entries, total, error } = profile.company_id
    ? await getEntries(profile.company_id, filters, effectiveCreatedFrom, effectiveCreatedTo, page, pageSize)
    : { entries: [] as EntryRow[], total: 0, error: null as string | null }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const hasActiveFilters = Boolean(
    filters.q || filters.type || filters.category || filters.status || filters.origin ||
    filters.referenceFrom || filters.referenceTo || !isDefaultCreatedPeriod,
  )

  // Preserva os filtros atuais ao ir para editar/novo e ao trocar de página —
  // inclui os dois grupos de data, ordenação, busca, tipo, categoria, status
  // e origem.
  const currentQuery = new URLSearchParams()
  if (filters.q) currentQuery.set('q', filters.q)
  if (filters.type) currentQuery.set('type', filters.type)
  if (filters.category) currentQuery.set('category', filters.category)
  if (filters.status) currentQuery.set('status', filters.status)
  if (filters.createdFrom) currentQuery.set('createdFrom', filters.createdFrom)
  if (filters.createdTo) currentQuery.set('createdTo', filters.createdTo)
  if (filters.allTime) currentQuery.set('allTime', '1')
  if (filters.referenceFrom) currentQuery.set('referenceFrom', filters.referenceFrom)
  if (filters.referenceTo) currentQuery.set('referenceTo', filters.referenceTo)
  if (filters.origin) currentQuery.set('origin', filters.origin)
  if (filters.sort !== 'created_at') currentQuery.set('sort', filters.sort)
  if (pageSize !== DEFAULT_PAGE_SIZE) currentQuery.set('pageSize', String(pageSize))
  currentQuery.set('page', String(page))
  const returnTo = encodeURIComponent(`/financeiro/lancamentos?${currentQuery.toString()}`)

  // Botões rápidos: todos mantêm os demais filtros (tipo/categoria/status/
  // origem/competência/busca), só reescrevem createdFrom/createdTo/allTime.
  function quickDateHref(overrides: { createdFrom?: string; createdTo?: string; allTime?: string }) {
    const q = new URLSearchParams(currentQuery)
    q.delete('createdFrom')
    q.delete('createdTo')
    q.delete('allTime')
    q.delete('page')
    if (overrides.createdFrom) q.set('createdFrom', overrides.createdFrom)
    if (overrides.createdTo) q.set('createdTo', overrides.createdTo)
    if (overrides.allTime) q.set('allTime', overrides.allTime)
    return `/financeiro/lancamentos?${q.toString()}`
  }

  const today = brazilDate()
  const currentMonth = today.slice(0, 7)
  const [cy, cm] = currentMonth.split('-').map(Number)
  const lastDayOfMonth = new Date(cy, cm, 0).getDate()
  const monthEnd = `${currentMonth}-${String(lastDayOfMonth).padStart(2, '0')}`

  const verTodoHistoricoHref = quickDateHref({ allTime: '1' })
  const criadosDesdeJulhoHref = quickDateHref({ createdFrom: DEFAULT_CREATED_FROM })
  const criadosHojeHref = quickDateHref({ createdFrom: today, createdTo: today })
  const criadosNesteMesHref = quickDateHref({ createdFrom: `${currentMonth}-01`, createdTo: monthEnd })

  const totalIncome = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0)
  const totalExpense = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0)

  const paginationExtraParams: Record<string, string | undefined> = {
    type: filters.type,
    category: filters.category,
    status: filters.status,
    createdFrom: filters.createdFrom,
    createdTo: filters.createdTo,
    allTime: filters.allTime ? '1' : undefined,
    referenceFrom: filters.referenceFrom,
    referenceTo: filters.referenceTo,
    origin: filters.origin,
    sort: filters.sort !== 'created_at' ? filters.sort : undefined,
    pageSize: pageSize !== DEFAULT_PAGE_SIZE ? String(pageSize) : undefined,
  }

  const createdPeriodLabel = filters.allTime
    ? 'Todo o histórico'
    : filters.createdFrom || filters.createdTo
      ? `De ${filters.createdFrom ? formatDate(filters.createdFrom) : '—'} até ${filters.createdTo ? formatDate(filters.createdTo) : 'hoje'}`
      : `${formatDate(DEFAULT_CREATED_FROM)} até hoje`

  const referencePeriodLabel = filters.referenceFrom || filters.referenceTo
    ? `De ${filters.referenceFrom ? formatDate(filters.referenceFrom) : '—'} até ${filters.referenceTo ? formatDate(filters.referenceTo) : '—'}`
    : null

  const startIdx = total === 0 ? 0 : (page - 1) * pageSize + 1
  const endIdx = Math.min(page * pageSize, total)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Lançamentos Financeiros</h2>
          <p className="text-sm text-text-muted">{total} lançamento{total !== 1 ? 's' : ''} encontrado{total !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/financeiro">
            <Button variant="secondary" size="sm">← Financeiro</Button>
          </Link>
          <Link href={`/financeiro/lancamentos/novo?from=${returnTo}`}>
            <Button size="sm">
              <Plus className="w-4 h-4" />
              Novo Lançamento
            </Button>
          </Link>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-bg-overlay px-3 py-2 space-y-2 text-sm">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-text-secondary inline-flex items-center gap-1.5">
            <CalendarClock className="w-3.5 h-3.5" />
            Criados: <span className="font-medium text-text-primary">{createdPeriodLabel}</span>
          </span>
          {referencePeriodLabel && (
            <span className="text-text-secondary">
              Competência: <span className="font-medium text-text-primary">{referencePeriodLabel}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <Link href={criadosDesdeJulhoHref} className="rounded-full border border-border px-2.5 py-1 hover:bg-bg-hover">
            Criados desde 01/07/2026
          </Link>
          <Link href={criadosHojeHref} className="rounded-full border border-border px-2.5 py-1 hover:bg-bg-hover">
            Criados hoje
          </Link>
          <Link href={criadosNesteMesHref} className="rounded-full border border-border px-2.5 py-1 hover:bg-bg-hover">
            Criados neste mês
          </Link>
          {!filters.allTime && (
            <Link href={verTodoHistoricoHref} className="rounded-full border border-brand/30 text-brand px-2.5 py-1 hover:bg-brand/5 inline-flex items-center gap-1">
              <History className="w-3 h-3" />
              Ver todo o histórico
            </Link>
          )}
        </div>
      </div>

      <Suspense>
        <LancamentosFilters defaultQ={filters.q} />
      </Suspense>

      {/* KPIs refletem só os lançamentos exibidos na página atual (após
          filtros), não um total geral da empresa — evita rodar uma segunda
          consulta agregando todo o conjunto filtrado a cada troca de página. */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Receitas nesta página</p>
          <p className="text-xl font-bold text-success">{formatCurrency(totalIncome)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Despesas nesta página</p>
          <p className="text-xl font-bold text-error">{formatCurrency(totalExpense)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Saldo nesta página</p>
          <p className={`text-xl font-bold ${totalIncome - totalExpense >= 0 ? 'text-success' : 'text-error'}`}>
            {formatCurrency(totalIncome - totalExpense)}
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
          Erro ao carregar lançamentos: {error}
        </div>
      )}

      <Card>
        {!error && entries.length === 0 ? (
          <EmptyState
            icon={<DollarSign className="w-6 h-6 text-text-muted" />}
            title={
              hasActiveFilters
                ? isDefaultCreatedPeriod
                  ? `Nenhum lançamento criado desde ${formatDate(DEFAULT_CREATED_FROM)}`
                  : 'Nenhum lançamento encontrado para estes filtros'
                : 'Nenhum lançamento registrado'
            }
            description={
              hasActiveFilters
                ? isDefaultCreatedPeriod
                  ? 'Pode haver lançamentos criados antes dessa data. Veja o histórico completo ou ajuste o período.'
                  : 'Tente ajustar os filtros ou o período de busca.'
                : 'Registre receitas e despesas para controle financeiro.'
            }
            action={
              hasActiveFilters
                ? isDefaultCreatedPeriod
                  ? { label: 'Ver todo o histórico', href: verTodoHistoricoHref }
                  : undefined
                : { label: 'Novo Lançamento', href: `/financeiro/lancamentos/novo?from=${returnTo}` }
            }
          />
        ) : (
          <>
            <CardHeader>
              <p className="text-xs text-text-muted">
                Exibindo {startIdx}–{endIdx} de {total} lançamento{total !== 1 ? 's' : ''} — página {page} de {totalPages}
              </p>
            </CardHeader>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Competência</TableHead>
                    <TableHead>Criado em</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Forma de pagamento</TableHead>
                    <TableHead align="right">Valor</TableHead>
                    <TableHead align="center">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const origin = computeOrigin(entry)
                    const pendingCashLink =
                      entry.type === 'expense' &&
                      entry.payment_method === 'cash' &&
                      entry.cash_movement_id == null

                    return (
                      <TableRow key={entry.id}>
                        <TableCell muted>{formatDate(entry.reference_date)}</TableCell>
                        <TableCell muted className="whitespace-nowrap text-xs">{formatDateTime(entry.created_at)}</TableCell>
                        <TableCell>
                          <Badge variant={entry.type === 'income' ? 'success' : 'error'} size="sm">
                            {entry.type === 'income' ? 'Receita' : 'Despesa'}
                          </Badge>
                        </TableCell>
                        <TableCell muted>{CATEGORY_LABELS[entry.category] ?? entry.category}</TableCell>
                        <TableCell className="max-w-xs">
                          <span className="truncate block">{entry.description}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={origin === 'manual' ? 'default' : 'info'} size="sm">
                            {ORIGIN_LABELS[origin]}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <span className={entry.payment_method ? 'text-text-secondary' : 'text-text-muted italic'}>
                              {entry.payment_method ? (PAYMENT_METHOD_LABELS[entry.payment_method] ?? entry.payment_method) : 'Pendente'}
                            </span>
                            {pendingCashLink && (
                              <div>
                                <Badge variant="warning" size="sm">Pendente de vínculo com o Caixa</Badge>
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell align="right">
                          <span className={`font-semibold ${entry.type === 'income' ? 'text-success' : 'text-error'}`}>
                            {entry.type === 'income' ? '+' : '−'} {formatCurrency(entry.amount)}
                          </span>
                        </TableCell>
                        <TableCell align="center">
                          <div className="flex items-center justify-center gap-1">
                            <Link href={`/financeiro/lancamentos/${entry.id}/editar?from=${returnTo}`}>
                              <Button variant="ghost" size="sm" className="text-xs px-2">Editar</Button>
                            </Link>
                            <DeleteEntryButton id={entry.id} />
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <Pagination
                page={page}
                totalPages={totalPages}
                baseUrl="/financeiro/lancamentos"
                query={filters.q}
                extraParams={paginationExtraParams}
              />
            )}
          </>
        )}
      </Card>
    </div>
  )
}
