import { NextResponse }             from 'next/server'
import { requireRole }              from '@/lib/supabase/session'
import { adjustStock }              from '@/services/estoque.service'
import { pushVariantStockToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { auditLog }                 from '@/lib/audit/log'
import { logError }                 from '@/lib/errors/log'

export interface InventarioItemInput {
  product_variation_id: number
  delta:                number
  notes?:               string | null
}

export interface InventarioItemResult {
  product_variation_id: number
  previous_quantity:    number
  new_quantity:         number
  delta:                number
  error?:               string
}

/**
 * POST /api/estoque/inventario
 *
 * Aplica ajustes de inventário físico em lote via rpc_stock_adjust.
 * Itens com delta == 0 são ignorados silenciosamente.
 * Requer role gerente ou admin.
 *
 * Body:  { items: InventarioItemInput[], notes?: string }
 * Response: { ok, applied, errors, results }
 */
export async function POST(request: Request) {
  // Fase 2: contagem de inventário não expõe custo/margem — reativado para usuario.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: { items?: InventarioItemInput[]; notes?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const items = body.items ?? []
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items obrigatório e não pode ser vazio.' }, { status: 400 })
  }

  const toProcess  = items.filter((i) => Number.isInteger(i.delta) && i.delta !== 0)
  const sessionNote = body.notes?.trim() ||
    `Inventário físico — ${new Date().toLocaleDateString('pt-BR')}`

  if (toProcess.length === 0) {
    return NextResponse.json({ ok: true, results: [], errors: 0, applied: 0,
      message: 'Nenhum ajuste necessário (todos os deltas são zero).' })
  }

  const results: InventarioItemResult[] = []
  let errorCount = 0

  for (const item of toProcess) {
    try {
      const result = await adjustStock(
        {
          product_variation_id: item.product_variation_id,
          delta:                item.delta,
          reason:               'inventario-fisico',
          notes:                item.notes ?? sessionNote,
        },
        user.id
      )

      if (!result.ok) {
        errorCount++
        results.push({
          product_variation_id: item.product_variation_id,
          previous_quantity:    0,
          new_quantity:         0,
          delta:                item.delta,
          error:                result.error,
        })
      } else {
        results.push({
          product_variation_id: item.product_variation_id,
          previous_quantity:    result.data.previous_quantity,
          new_quantity:         result.data.new_quantity,
          delta:                result.data.delta,
        })

        // Sincronizar estoque corrigido na Nuvemshop de forma não-bloqueante
        pushVariantStockToNuvemshop(item.product_variation_id, { eventType: 'stock_push_erp' })
          .catch((err) => console.error('[POST /api/estoque/inventario] Nuvemshop sync error', err))
      }
    } catch (err) {
      errorCount++
      logError({
        route:   'POST /api/estoque/inventario',
        err,
        context: {
          user_id:               user.id,
          company_id:            user.company_id,
          product_variation_id:  item.product_variation_id,
          delta:                 item.delta,
        },
      })
      results.push({
        product_variation_id: item.product_variation_id,
        previous_quantity:    0,
        new_quantity:         0,
        delta:                item.delta,
        error:                'Erro interno ao processar este item.',
      })
    }
  }

  auditLog({
    userId:   user.id,
    userRole: user.role,
    action:   'inventory_count',
    resource: 'stock',
    detail:   `inventario-fisico: ${toProcess.length - errorCount} ajustes, ${errorCount} erros`,
  })

  if (errorCount > 0) {
    logError({
      route:   'POST /api/estoque/inventario',
      err:     new Error(`${errorCount} ajustes falharam`),
      context: { user_id: user.id, company_id: user.company_id, errors: errorCount },
    })
  }

  return NextResponse.json({
    ok:      errorCount === 0,
    applied: toProcess.length - errorCount,
    errors:  errorCount,
    results,
  }, { status: errorCount > 0 ? 207 : 200 })
}
