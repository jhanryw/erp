export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { createStockEntry } from '@/services/estoque.service'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// ─── Schema ───────────────────────────────────────────────────────────────────

const itemSchema = z.object({
  product_variation_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  /** Custo unitário por item — sobrepõe o unit_cost global quando informado. */
  unit_cost: z.number().min(0).optional(),
})

const massaSchema = z.object({
  items: z.array(itemSchema).min(1, 'Informe ao menos uma variação.'),
  supplier_id: z.coerce.number().nullable().optional(),
  entry_type: z.enum(['purchase', 'own_production']),
  /**
   * Custo unitário global (usado quando o item não traz unit_cost próprio).
   * Obrigatório se nenhum item tiver unit_cost próprio.
   */
  unit_cost: z.coerce.number().min(0).default(0),
  freight_cost_total: z.coerce.number().min(0).default(0),
  tax_cost_total: z.coerce.number().min(0).default(0),
  entry_date: z.string().min(1, 'Data de entrada obrigatória.'),
  notes: z.string().nullable().optional(),
})

// ─── POST /api/estoque/entrada/massa ─────────────────────────────────────────

/**
 * Registra entrada de estoque em massa (grade cor × tamanho).
 *
 * Frete e impostos são distribuídos proporcionalmente à quantidade de cada
 * variação: `share = (item.qty / totalQty) * totalCost`.
 *
 * Resposta:
 *   201 — todos os itens registrados com sucesso.
 *   207 — pelo menos um item falhou (partial success). Verifique `results[].ok`.
 */
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = massaSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { items, freight_cost_total, tax_cost_total, unit_cost, entry_type, supplier_id, entry_date, notes } =
    parsed.data

  // Only process items with qty > 0 (client already filters, but double-check here)
  const activeItems = items.filter((i) => i.quantity > 0)
  if (activeItems.length === 0) {
    return NextResponse.json(
      { error: 'Informe quantidade em ao menos uma variação.' },
      { status: 422 }
    )
  }

  const totalQty = activeItems.reduce((sum, i) => sum + i.quantity, 0)

  type ItemResult = {
    product_variation_id: number
    ok: boolean
    lot_id?: string
    new_quantity?: number
    new_avg_cost?: number
    error?: string
  }
  const results: ItemResult[] = []
  let hasError = false

  for (const item of activeItems) {
    // Proportional cost distribution (rateio global entre todas as unidades do lote)
    const freightShare = totalQty > 0 ? (item.quantity / totalQty) * freight_cost_total : 0
    const taxShare = totalQty > 0 ? (item.quantity / totalQty) * tax_cost_total : 0
    // Per-item unit_cost takes precedence over the global one
    const effectiveUnitCost = item.unit_cost ?? unit_cost

    const result = await createStockEntry(
      {
        product_variation_id: item.product_variation_id,
        supplier_id: supplier_id ?? null,
        entry_type,
        quantity_original: item.quantity,
        unit_cost: effectiveUnitCost,
        freight_cost: freightShare,
        tax_cost: taxShare,
        entry_date,
        notes: notes ?? null,
      },
      user.id
    )

    if (result.ok) {
      results.push({
        product_variation_id: item.product_variation_id,
        ok: true,
        lot_id: result.data.lot_id,
        new_quantity: result.data.new_quantity,
        new_avg_cost: result.data.new_avg_cost,
      })

      auditLog({
        userId: user.id,
        userRole: user.role,
        action: 'create',
        resource: 'stock_entry',
        resourceId: item.product_variation_id,
        detail: `massa lot:${result.data.lot_id} qty:${item.quantity} unit_cost:${result.data.cost_per_unit.toFixed(2)}`,
        after: {
          lot_id: result.data.lot_id,
          new_quantity: result.data.new_quantity,
          new_avg_cost: result.data.new_avg_cost,
        },
      })
    } else {
      results.push({
        product_variation_id: item.product_variation_id,
        ok: false,
        error: result.error,
      })
      hasError = true

      logError({
        route: 'POST /api/estoque/entrada/massa',
        err: new Error(result.error),
        context: {
          user_id: user.id,
          company_id: user.company_id,
          product_variation_id: item.product_variation_id,
          quantity: item.quantity,
        },
      })
    }
  }

  const status = hasError ? 207 : 201
  return NextResponse.json(
    {
      results,
      totalQty,
      totalItems: results.filter((r) => r.ok).length,
      failedItems: results.filter((r) => !r.ok).length,
    },
    { status }
  )
}
