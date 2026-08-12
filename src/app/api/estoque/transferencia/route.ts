import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { transferStock } from '@/services/estoque.service'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  product_variation_id: z.coerce.number().int().positive('Selecione uma variação'),
  from_location_id:     z.coerce.number().int().positive('Informe a origem'),
  to_location_id:       z.coerce.number().int().positive('Informe o destino'),
  quantity:             z.coerce.number().int().positive('Quantidade deve ser maior que zero'),
  notes:                z.string().nullable().optional().transform((v) => (v == null || v.trim() === '') ? null : v.trim()),
}).refine((d) => d.from_location_id !== d.to_location_id, {
  message: 'Origem e destino não podem ser iguais',
  path: ['to_location_id'],
})

export async function POST(request: Request) {
  // Fase 2: transferência entre locais não expõe custo/margem — reativado para usuario.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const fieldMsg = Object.values(flat.fieldErrors as Record<string, string[]>)[0]?.[0]
    return NextResponse.json({ error: fieldMsg ?? flat.formErrors[0] ?? 'Dados inválidos' }, { status: 400 })
  }

  try {
    const result = await transferStock(parsed.data, user.id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    auditLog({
      userId: user.id, userRole: user.role,
      action: 'transfer', resource: 'stock_transfer',
      resourceId: parsed.data.product_variation_id,
      detail: `from:${parsed.data.from_location_id} to:${parsed.data.to_location_id} qty:${parsed.data.quantity}`,
      after: result.data as unknown as Record<string, unknown>,
    })

    // Sincronizar total para Nuvemshop (non-fatal)
    pushVariantStockToNuvemshop(parsed.data.product_variation_id, { eventType: 'stock_push_erp' })
      .catch((err) => console.error('[POST /api/estoque/transferencia] Nuvemshop sync error', err))

    return NextResponse.json(result.data)
  } catch (err) {
    logError({
      route: 'POST /api/estoque/transferencia',
      err,
      context: {
        user_id:              user.id,
        product_variation_id: parsed.data.product_variation_id,
        from_location_id:     parsed.data.from_location_id,
        to_location_id:       parsed.data.to_location_id,
        quantity:             parsed.data.quantity,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
