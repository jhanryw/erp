import { NextResponse } from 'next/server'
import { authenticateNuvemshopWebhook } from '@/lib/integrations/nuvemshopWebhook'
import { resolveNuvemshopContextForStore } from '@/services/nuvemshop/context.service'
import { HANDLED_PRODUCT_EVENTS, processNuvemshopProductDeleted } from '@/services/nuvemshop/productWebhook.service'

/**
 * Webhook de produtos Nuvemshop (registrar `product/deleted` apontando para
 * esta URL). Tenant: store_id do payload → integração → empresa. Loja
 * desconhecida é ignorada com 200 (não há o que reprocessar).
 * Erro de banco → 500 para a Nuvemshop reenviar.
 */
export async function POST(request: Request) {
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return NextResponse.json({ error: 'Erro ao ler body.' }, { status: 400 })
  }

  const auth = authenticateNuvemshopWebhook(rawBody, request.headers)
  if (!auth.ok) {
    console.warn('[webhook/nuvemshop/product] rejeitado', { status: auth.status })
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let body: { store_id?: number | string; event?: string; id?: number | string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const event = String(body.event ?? '')
  const remoteProductId = body.id != null ? String(body.id) : ''
  const storeId = body.store_id != null ? String(body.store_id) : ''
  if (!event || !/^\d+$/.test(remoteProductId) || !storeId) {
    return NextResponse.json({ error: 'store_id, event e id obrigatórios.' }, { status: 400 })
  }

  if (!HANDLED_PRODUCT_EVENTS.has(event)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'event_not_handled' })
  }

  const ctx = await resolveNuvemshopContextForStore(storeId)
  if (!ctx.ok) {
    console.error('[webhook/nuvemshop/product] Falha ao resolver loja', { storeId, error: ctx.error })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
  if (!ctx.data) {
    console.warn('[webhook/nuvemshop/product] store_id sem integração', { storeId, event })
    return NextResponse.json({ ok: true, skipped: true, reason: 'unknown_store' })
  }

  const result = await processNuvemshopProductDeleted(ctx.data, remoteProductId)
  if (!result.ok) {
    console.error('[webhook/nuvemshop/product] Falha ao processar', { storeId, remoteProductId, error: result.error })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }

  console.info('[webhook/nuvemshop/product] processado', { event, storeId, remoteProductId, ...result.data })
  return NextResponse.json({ ok: true, ...result.data })
}
