export const dynamic = 'force-dynamic'

/**
 * GET /api/estoque/extrato
 *
 * Retorna o histórico de movimentações de estoque com suporte a filtros.
 * Requer role mínimo: gerente.
 *
 * Query params (todos opcionais):
 *   product_id    — filtra por produto pai
 *   variation_id  — filtra por variação específica
 *   type          — entry | sale | return | adjust | initial
 *   from          — data inicial (ISO 8601, ex: 2025-01-01)
 *   to            — data final   (ISO 8601, ex: 2025-12-31)
 *   limit         — máximo de registros (default: 50, max: 500)
 *   offset        — paginação (default: 0)
 *
 * Exemplo:
 *   GET /api/estoque/extrato?variation_id=5&type=sale&limit=20
 */

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

const MOVEMENT_TYPES = ['entry', 'sale', 'return', 'adjust', 'initial'] as const
type MovementType = typeof MOVEMENT_TYPES[number]

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const { searchParams } = new URL(request.url)

  // ── Parsear e validar query params ───────────────────────────────────────────

  const rawProductId   = searchParams.get('product_id')
  const rawVariationId = searchParams.get('variation_id')
  const rawType        = searchParams.get('type')
  const rawFrom        = searchParams.get('from')
  const rawTo          = searchParams.get('to')
  const rawLimit       = searchParams.get('limit')
  const rawOffset      = searchParams.get('offset')

  const productId   = rawProductId   ? parseInt(rawProductId,   10) : null
  const variationId = rawVariationId ? parseInt(rawVariationId, 10) : null
  const limit       = Math.min(Math.max(parseInt(rawLimit  ?? '50',  10) || 50,  1), 500)
  const offset      = Math.max(parseInt(rawOffset ?? '0',  10) || 0,  0)

  if (rawProductId   && isNaN(productId!))   return NextResponse.json({ error: 'product_id inválido.'   }, { status: 400 })
  if (rawVariationId && isNaN(variationId!)) return NextResponse.json({ error: 'variation_id inválido.' }, { status: 400 })

  if (rawType && !MOVEMENT_TYPES.includes(rawType as MovementType)) {
    return NextResponse.json(
      { error: `Tipo inválido. Use: ${MOVEMENT_TYPES.join(', ')}.` },
      { status: 400 }
    )
  }

  // ── Query ─────────────────────────────────────────────────────────────────────

  const admin = createAdminClient()

  let query = admin
    .from('stock_movements')
    .select(`
      id,
      type,
      quantity,
      previous_stock,
      new_stock,
      unit_cost,
      reference_id,
      notes,
      created_at,
      product_variation_id,
      product_id,
      product_variations ( sku_variation ),
      products ( name, sku )
    `, { count: 'exact' })
    .eq('company_id', user.company_id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (productId)   query = query.eq('product_id',           productId)
  if (variationId) query = query.eq('product_variation_id', variationId)
  if (rawType)     query = query.eq('type',                 rawType)
  if (rawFrom)     query = (query as any).gte('created_at', rawFrom)
  if (rawTo)       query = (query as any).lte('created_at', rawTo + 'T23:59:59.999Z')

  const { data: movements, error, count } = await query as unknown as {
    data: {
      id: number
      type: MovementType
      quantity: number
      previous_stock: number
      new_stock: number
      unit_cost: number | null
      reference_id: string | null
      notes: string | null
      created_at: string
      product_variation_id: number
      product_id: number
      product_variations: { sku_variation: string } | null
      products: { name: string; sku: string } | null
    }[] | null
    error: { message: string } | null
    count: number | null
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ── Formatar resposta ─────────────────────────────────────────────────────────

  const formatted = (movements ?? []).map((m) => ({
    id:                   m.id,
    type:                 m.type,
    quantity:             m.quantity,        // sinalizado: positivo=entrada, negativo=saída
    previous_stock:       m.previous_stock,
    new_stock:            m.new_stock,
    unit_cost:            m.unit_cost,
    reference_id:         m.reference_id,
    notes:                m.notes,
    created_at:           m.created_at,
    product_variation_id: m.product_variation_id,
    product_id:           m.product_id,
    sku_variation:        m.product_variations?.sku_variation ?? null,
    product_name:         m.products?.name ?? null,
    product_sku:          m.products?.sku  ?? null,
  }))

  return NextResponse.json({
    movements: formatted,
    total:     count ?? 0,
    limit,
    offset,
  })
}
