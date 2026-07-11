import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { Card } from '@/components/ui/card'
import { RegularizacaoTable, type PendingMovement } from './_components/regularizacao-table'

export const dynamic = 'force-dynamic'

// Caso de duplicidade confirmado manualmente (não é detecção automática por
// heurística — literal e revisado). Se um novo caso aparecer no futuro, ele
// entra aqui só depois de confirmação humana, igual a este.
const CONFIRMED_DUPLICATE_LINKS: Record<number, number> = {
  10: 1382,
}

async function getPendingMovements(companyId: number): Promise<PendingMovement[]> {
  const admin = createAdminClient()

  const [movementsRes, linkedRes] = await Promise.all([
    admin
      .from('cash_movements')
      .select('id, description, amount, method, created_at, cash_session_id, company_id, users:created_by(name)')
      .eq('type', 'expense')
      .eq('company_id', companyId)
      .is('cancelled_at', null)
      .order('created_at', { ascending: true }) as unknown as {
        data: Array<{
          id: number
          description: string
          amount: number
          method: string
          created_at: string
          cash_session_id: number
          company_id: number
          users: { name: string } | null
        }> | null
        error: { message: string } | null
      },
    // Movimentos já regularizados — exclui da lista de pendentes
    admin
      .from('finance_entries')
      .select('cash_movement_id')
      .not('cash_movement_id', 'is', null) as unknown as {
        data: Array<{ cash_movement_id: number }> | null
        error: { message: string } | null
      },
  ])

  const linkedIds = new Set((linkedRes.data ?? []).map((r) => r.cash_movement_id))
  const pending = (movementsRes.data ?? []).filter((m) => !linkedIds.has(m.id))

  if (pending.length === 0) return []

  // Busca os finance_entries dos casos de duplicidade confirmada, só para
  // os movimentos que ainda estão pendentes e têm um caso confirmado.
  const duplicateFeIds = pending
    .map((m) => CONFIRMED_DUPLICATE_LINKS[m.id])
    .filter((id): id is number => id != null)

  const { data: duplicateEntries } = duplicateFeIds.length > 0
    ? await admin
        .from('finance_entries')
        .select('id, description, amount, category, reference_date')
        .in('id', duplicateFeIds) as unknown as {
          data: Array<{ id: number; description: string; amount: number; category: string; reference_date: string }> | null
        }
    : { data: [] }

  const duplicateById = new Map((duplicateEntries ?? []).map((fe) => [fe.id, fe]))

  return pending.map((m) => {
    const confirmedFeId = CONFIRMED_DUPLICATE_LINKS[m.id]
    const confirmedDuplicate = confirmedFeId ? duplicateById.get(confirmedFeId) ?? null : null

    return {
      id: m.id,
      description: m.description,
      amount: m.amount,
      method: m.method,
      createdAt: m.created_at,
      cashSessionId: m.cash_session_id,
      userName: m.users?.name ?? '—',
      confirmedDuplicate: confirmedDuplicate
        ? {
            financeEntryId: confirmedDuplicate.id,
            description: confirmedDuplicate.description,
            amount: confirmedDuplicate.amount,
            category: confirmedDuplicate.category,
            referenceDate: confirmedDuplicate.reference_date,
          }
        : null,
    }
  })
}

export default async function RegularizacaoCaixaPage() {
  const supabase = createClient()
  const { data: { user: authUser } } = await supabase.auth.getUser()
  const profile = authUser ? await getUserProfile(authUser.id, authUser.email) : null

  if (!profile || profile.role !== 'admin') {
    return (
      <div className="max-w-lg mx-auto pt-16 text-center space-y-2">
        <h1 className="text-lg font-semibold text-text-primary">Acesso restrito</h1>
        <p className="text-sm text-text-muted">
          Esta ferramenta administrativa é exclusiva para administradores.
        </p>
      </div>
    )
  }

  const movements = profile.company_id ? await getPendingMovements(profile.company_id) : []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">Regularização de despesas do Caixa</h1>
        <p className="text-sm text-text-muted">
          Ferramenta administrativa temporária — converte despesas históricas registradas no Caixa
          (antes do bloqueio da Entrega 1) em lançamentos financeiros normais. {movements.length} pendente(s).
        </p>
      </div>

      <Card>
        <RegularizacaoTable movements={movements} />
      </Card>
    </div>
  )
}
