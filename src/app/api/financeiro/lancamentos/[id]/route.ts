export const dynamic = 'force-dynamic'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { financeEntrySchema, normalizeFinanceEntryPayment, financeEntryPaymentStatus } from '@/lib/validators'
import { NextResponse } from 'next/server'
import { brazilDate } from '@/lib/utils/date'

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = (await (admin as any).from('finance_entries').select('*').eq('id', Number(params.id)).eq('company_id', user.company_id).single()) as unknown as { data: any; error: any }
  if (error || !data) return NextResponse.json({ error: 'Lançamento não encontrado' }, { status: 404 })

  // Se veio de uma regularização do Caixa, traz o movimento original (mesma
  // company_id do usuário — nunca confiar só no cash_movement_id do lançamento)
  // para exibir na tela de edição, sem nunca alterá-lo.
  let cashMovement: any = null
  if (data.cash_movement_id != null) {
    const { data: cm } = await (admin as any)
      .from('cash_movements')
      .select('id, description, amount, method, created_at, cancelled_at, cancellation_reason, metadata')
      .eq('id', data.cash_movement_id)
      .eq('company_id', user.company_id)
      .maybeSingle()
    cashMovement = cm ?? null
  }

  // Histórico de auditoria deste lançamento: cobre tanto a criação original
  // via rpc_regularizar_despesa_caixa (que grava finance_entry_id) quanto
  // updates feitos por esta rota (que gravam resource/resource_id).
  const { data: auditRows } = await (admin as any)
    .from('audit_logs')
    .select('id, ts, action, user_role, before_data, after_data, detail, users(name)')
    .or(`finance_entry_id.eq.${data.id},and(resource.eq.finance_entry,resource_id.eq.${data.id})`)
    .order('ts', { ascending: false })
    .limit(20)

  return NextResponse.json({ entry: data, cashMovement, auditHistory: auditRows ?? [] })
}

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = financeEntrySchema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const fieldMsg = Object.values(flat.fieldErrors as Record<string, string[]>)[0]?.[0]
    const formMsg = flat.formErrors[0]
    return NextResponse.json({ error: fieldMsg ?? formMsg ?? 'Dados inválidos' }, { status: 422 })
  }

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()

  // Snapshot ANTES da mutação, escopado pela mesma company_id — usado para o
  // registro de auditoria (before_data) e, incidentalmente, confirma que o
  // registro pertence ao usuário antes de tentar o update.
  const { data: before } = await (admin as any)
    .from('finance_entries')
    .select('*')
    .eq('id', id)
    .eq('company_id', user.company_id)
    .maybeSingle()

  if (!before) return NextResponse.json({ error: 'Registro não encontrado' }, { status: 404 })

  // cash_movement_id nunca é aceito aqui — mesma regra do POST (o schema é
  // .strict() e rejeita a chave antes de chegar aqui). paid_at é DATE: string
  // 'yyyy-MM-dd' direto ao banco, sem conversão.
  //
  // payment_method precisa do mesmo tratamento explícito de paid_at: se ficar
  // `undefined` (campo limpo no formulário), o JSON.stringify da requisição
  // do supabase-js OMITE a chave e o UPDATE preserva o valor antigo da coluna
  // em vez de limpá-la — normalizeFinanceEntryPayment garante `null` explícito
  // nos dois campos juntos, nunca só um deles.
  // Registro legado/automático (paid, paid_at nulo) editado sem informar
  // pagamento continua realizado em reference_date — não vira pendente por
  // acidente. Qualquer registro com paid_at pode voltar a pendente.
  const isLegacyRealized = before.payment_status === 'paid' && before.paid_at == null
  const requested = financeEntryPaymentStatus(parsed.data)
  const explicit = parsed.data.payment_status
  const hasOrigin = before.sale_id != null || before.stock_lot_id != null ||
    before.marketing_cost_id != null || before.return_id != null

  // Registro legado/automático realizado, editado sem escolher status, segue
  // realizado em reference_date. Mover um legado para pendente/agendado é
  // bloqueado (não reclassificamos histórico), e lançamentos automáticos
  // (venda/estoque/marketing/devolução) nunca são agendados.
  let nextStatus: 'paid' | 'pending' | 'scheduled' = requested
  if (isLegacyRealized && !explicit && requested === 'pending') nextStatus = 'paid'
  if (isLegacyRealized && explicit && requested !== 'paid') {
    return NextResponse.json({ error: 'Registro realizado sem data de pagamento (legado) não pode voltar a pendente/agendado.' }, { status: 422 })
  }
  if (requested === 'scheduled' && hasOrigin) {
    return NextResponse.json({ error: 'Lançamentos automáticos não podem ser agendados.' }, { status: 422 })
  }
  if (requested === 'scheduled' && before.cash_movement_id != null) {
    return NextResponse.json({ error: 'Lançamento vinculado ao Caixa não pode ser agendado.' }, { status: 422 })
  }
  // Nova data programada nunca no passado (mantendo a data atual já gravada).
  if (requested === 'scheduled' && parsed.data.paid_at && parsed.data.paid_at < brazilDate() &&
      !(before.payment_status === 'scheduled' && before.paid_at === parsed.data.paid_at)) {
    return NextResponse.json({ error: 'A data programada não pode estar no passado.' }, { status: 422 })
  }
  const { payment_status: _ignored, ...rest } = parsed.data
  const updatePayload = {
    ...rest,
    ...normalizeFinanceEntryPayment(parsed.data),
    payment_status: nextStatus,
  }
  const { error, count } = (await (admin as any)
    .from('finance_entries')
    .update(updatePayload, { count: 'exact' })
    .eq('id', id)
    .eq('company_id', user.company_id)
    // Proteção contra operação concorrente: só atualiza se o status não mudou
    // desde a leitura (ex.: agendamento confirmado/cancelado em outra aba).
    .eq('payment_status', before.payment_status)) as { error: any; count: number | null }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Segunda camada de proteção contra "sucesso fantasma": se o ID pertencer a
  // outra empresa, o .eq('company_id', ...) já não afeta nenhuma linha — sem
  // esta checagem a API responderia 200 mesmo sem ter alterado nada.
  if (!count) return NextResponse.json({ error: 'O lançamento foi alterado por outra operação. Recarregue e tente novamente.' }, { status: 409 })

  auditLog({
    userId: user.id,
    userRole: user.role,
    action: 'update',
    resource: 'finance_entry',
    resourceId: id,
    before,
    after: updatePayload,
    detail: `${parsed.data.type}:${parsed.data.category}`,
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const id = Number(params.id)
  if (!id) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const admin = createAdminClient()
  const { error, count } = await (admin as any).from('finance_entries').delete({ count: 'exact' }).eq('id', id).eq('company_id', user.company_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'Registro não encontrado' }, { status: 404 })

  auditLog({ userId: user.id, userRole: user.role, action: 'delete', resource: 'finance_entry', resourceId: id })
  return NextResponse.json({ ok: true })
}
