import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { adjustStock } from '@/services/estoque.service'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  product_variation_id: z.coerce.number().int().min(1, 'Selecione uma variação válida'),
  delta:  z.coerce.number().int('Deve ser número inteiro').refine((n) => n !== 0, { message: 'Delta não pode ser zero' }),
  reason: z.string().min(1, 'Informe o motivo do ajuste'),
  notes:  z.string().optional().nullable().transform((v) => (v == null || v.trim() === '') ? null : v.trim()),
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const fieldMsg = Object.values(flat.fieldErrors as Record<string, string[]>)[0]?.[0]
    const formMsg  = flat.formErrors[0]
    return NextResponse.json({ error: fieldMsg ?? formMsg ?? 'Dados inválidos' }, { status: 400 })
  }

  try {
    const result = await adjustStock(parsed.data, user.id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'adjust', resource: 'stock_adjustment',
      resourceId: parsed.data.product_variation_id,
      detail: `delta:${parsed.data.delta} reason:${parsed.data.reason}`,
      after:  { new_quantity: result.data.new_quantity, delta: result.data.delta },
    })

    pushVariantStockToNuvemshop(parsed.data.product_variation_id, { eventType: 'stock_push_erp' })
      .catch((err) => console.error('[POST /api/estoque/ajuste] Nuvemshop sync error', err))

    return NextResponse.json(result.data)
  } catch (err) {
    logError({
      route: 'POST /api/estoque/ajuste',
      err,
      context: {
        user_id:              user.id,
        company_id:           user.company_id,
        product_variation_id: parsed.data.product_variation_id,
        delta:                parsed.data.delta,
        reason:               parsed.data.reason,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
