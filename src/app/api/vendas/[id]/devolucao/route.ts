import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { getSaleForMutation, restoreStock } from '@/services/vendas.service'
import { NextResponse } from 'next/server'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const saleId = Number(params.id)

  const systemUserId = process.env.SYSTEM_USER_ID
  if (!systemUserId) return NextResponse.json({ error: 'SYSTEM_USER_ID não configurado.' }, { status: 500 })

  // Buscar e validar venda via service
  const saleResult = await getSaleForMutation(saleId)
  if (!saleResult.ok) return NextResponse.json({ error: saleResult.error }, { status: saleResult.status })

  const { sale, saleItems } = saleResult.data

  // Restaurar estoque
  const stockResult = await restoreStock(saleItems)
  if (!stockResult.ok) return NextResponse.json({ error: stockResult.error }, { status: stockResult.status })

  const admin = createAdminClient() // admin client: escrita multi-tabela (status + finance_entry)

  await (admin.from('sales') as any).update({ status: 'returned' }).eq('id', saleId)

  await admin.from('finance_entries').insert({
    type:           'expense',
    category:       'other_expense',
    description:    `Devolução — Venda ${(sale as any).sale_number}`,
    amount:         (sale as any).total,
    reference_date: new Date().toISOString().slice(0, 10),
    sale_id:        saleId,
    created_by:     systemUserId,
  } as any)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'return', resource: 'sale', resourceId: saleId,
    before: { status: (sale as any).status },
    after:  { status: 'returned' },
  })
  return NextResponse.json({ success: true })
}
