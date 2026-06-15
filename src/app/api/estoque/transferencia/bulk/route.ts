import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { transferStockBulk } from '@/services/estoque.service'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  from_location_id: z.coerce.number().int().positive('Informe o local de origem'),
  to_location_id:   z.coerce.number().int().positive('Informe o local de destino'),
  notes: z
    .string()
    .nullable()
    .optional()
    .transform(v => (v == null || v.trim() === '') ? null : v.trim()),
  items: z
    .array(
      z.object({
        product_variation_id: z.coerce.number().int().positive('ID de variação inválido'),
        quantity:             z.coerce.number().int().positive('Quantidade deve ser maior que zero'),
      })
    )
    .min(1, 'Informe ao menos um item'),
}).refine(d => d.from_location_id !== d.to_location_id, {
  message: 'Origem e destino não podem ser iguais',
  path: ['to_location_id'],
})

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const fieldMsg = Object.values(flat.fieldErrors as Record<string, string[]>)[0]?.[0]
    return NextResponse.json(
      { error: fieldMsg ?? flat.formErrors[0] ?? 'Dados inválidos' },
      { status: 400 }
    )
  }

  try {
    const result = await transferStockBulk(parsed.data, user.id)

    // Erro de camada de serviço (Postgres, rede, etc.)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }

    const outcome = result.data

    // Erros de negócio retornados pela RPC (ok:false com lista detalhada de erros)
    if (!outcome.ok) {
      return NextResponse.json(outcome, { status: 400 })
    }

    // Transferência realizada com sucesso
    auditLog({
      userId:     user.id,
      userRole:   user.role,
      action:     'transfer',
      resource:   'stock_transfer',
      resourceId: outcome.batch_id,
      detail: `bulk from:${outcome.from_location_id} to:${outcome.to_location_id} items:${outcome.total_items} qty:${outcome.total_quantity}`,
      after: outcome as unknown as Record<string, unknown>,
    })

    // Sincronizar cada variação transferida com a Nuvemshop (fire-and-forget, non-fatal)
    for (const item of outcome.transferred) {
      pushVariantStockToNuvemshop(item.product_variation_id, { eventType: 'stock_push_erp' })
        .catch(err =>
          console.error(
            `[POST /api/estoque/transferencia/bulk] Nuvemshop sync error pvid:${item.product_variation_id}`,
            err
          )
        )
    }

    return NextResponse.json(outcome)
  } catch (err) {
    logError({
      route: 'POST /api/estoque/transferencia/bulk',
      err,
      context: {
        user_id:          user.id,
        from_location_id: parsed.data.from_location_id,
        to_location_id:   parsed.data.to_location_id,
        items_count:      parsed.data.items.length,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
