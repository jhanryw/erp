import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { reconcileNuvemshopProducts } from '@/services/nuvemshop/reconcile.service'

/**
 * "Verificar produtos": compara mappings da empresa com a loja Nuvemshop.
 * Body opcional { dryRun: true } só reporta, sem invalidar nada.
 * Nunca exclui nem cria nada na Nuvemshop.
 */
export async function POST(request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  let body: { dryRun?: boolean } = {}
  try { body = await request.json() } catch { /* sem body = execução normal */ }

  const result = await reconcileNuvemshopProducts(ctx, { dryRun: body.dryRun === true })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status ?? 500 })
  return NextResponse.json({ ok: true, ...result.data })
}
