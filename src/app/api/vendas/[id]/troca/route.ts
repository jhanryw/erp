import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'

const itemSchema = z.object({
  sale_item_id:      z.coerce.number().int().positive(),
  quantity_returned: z.coerce.number().int().min(1),
})

const schema = z.object({
  customer_id: z.coerce.number().int().positive(),
  items:       z.array(itemSchema).min(1, 'Selecione ao menos um item.'),
  notes:       z.string().max(500).optional(),
})

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const saleId = Number(params.id)
  if (!saleId) return NextResponse.json({ error: 'ID de venda inválido.' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { customer_id, items, notes } = parsed.data
  const admin = createAdminClient()

  try {
    const { data, error } = await (admin as any).rpc('rpc_process_exchange', {
      p_company_id:  user.company_id,
      p_sale_id:     saleId,
      p_customer_id: customer_id,
      p_items:       items,
      p_notes:       notes ?? null,
      p_user_id:     user.id,
    }) as { data: { exchange_id: number; credit_amount: number } | null; error: { code: string; message: string } | null }

    if (error) {
      const status = error.code === 'P0001' ? 400 : 500
      return NextResponse.json({ error: error.message }, { status })
    }

    auditLog({
      userId: user.id, userRole: user.role,
      action:     'exchange',
      resource:   'sale',
      resourceId: saleId,
      after: {
        exchange_id:   data?.exchange_id,
        credit_amount: data?.credit_amount,
        items_count:   items.length,
      },
    })

    return NextResponse.json({
      ok:            true,
      exchange_id:   data?.exchange_id,
      credit_amount: data?.credit_amount,
    })
  } catch (err) {
    logError({
      route:   'POST /api/vendas/[id]/troca',
      err,
      context: { user_id: user.id, company_id: user.company_id, sale_id: saleId },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
