import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { brazilDate } from '@/lib/utils/date'

// Job de expiração de cashback.
//
// IMPORTANTE: este job é de limpeza e auditoria. A segurança real está na
// v_cashback_balance e no rpc_create_sale, que filtram expiry_date na query.
// Cashback vencido não pode ser usado mesmo que este job nunca rode.
export async function POST(request: Request) {
  const authHeader = request.headers.get('Authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createAdminClient()
  const today = brazilDate()

  // Busca earn disponíveis com expiry_date vencida
  const { data: toExpire, error: selectError } = await (supabase
    .from('cashback_transactions') as any)
    .select('id, customer_id, company_id, amount')
    .eq('type', 'earn')
    .eq('status', 'available')
    .not('expiry_date', 'is', null)
    .lte('expiry_date', today) as { data: any[] | null; error: any }

  if (selectError) {
    return NextResponse.json({ error: selectError.message }, { status: 500 })
  }

  const rows = toExpire ?? []
  if (rows.length === 0) {
    return NextResponse.json({ expired: 0, date: today })
  }

  const ids = rows.map((r: any) => r.id as number)

  const { error: updateError } = await (supabase
    .from('cashback_transactions') as any)
    .update({ status: 'expired' })
    .in('id', ids) as { error: any }

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // Registra tipo 'expire' para auditoria e para o total_expired da view
  const expireRecords = rows.map((r: any) => ({
    customer_id: r.customer_id as number,
    company_id:  r.company_id  as number,
    type:        'expire',
    amount:      r.amount      as number,
    status:      'expired',
  }))

  const { error: insertError } = await (supabase
    .from('cashback_transactions') as any)
    .insert(expireRecords) as { error: any }

  if (insertError) {
    console.error('[cashback-expire] Erro ao inserir registros de auditoria:', insertError.message)
  }

  return NextResponse.json({ expired: rows.length, date: today })
}
