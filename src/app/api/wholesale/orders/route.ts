export const dynamic = 'force-dynamic'
// Catálogo/estoque/pedido NUNCA podem sair do cache de dados do Next (supabase-js usa fetch GET).
export const fetchCache = 'force-no-store'

/**
 * POST /api/wholesale/orders — cria o pedido (intenção de compra) do catálogo
 * de atacado. Público, sem login. Não cria venda nem mexe em estoque.
 *
 * O corpo aceita SÓ: chave de idempotência, nome/telefone do comprador e
 * `variation_id` + `quantity` por item. `.strict()` rejeita qualquer outro
 * campo (preço, nome, SKU, subtotal, total, company_id…) — o servidor
 * reconstrói tudo do banco. Não existe GET público de pedidos.
 */

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { publicRouteError, resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { buildOrderWhatsAppMessage } from '@/lib/wholesale/whatsapp'
import { createWholesaleOrder, ORDER_MAX_LINES, ORDER_MAX_QUANTITY_PER_LINE } from '@/services/wholesale/orders'

const schema = z.object({
  idempotency_key: z.string().uuid(),
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().min(8).max(30),
  }).strict(),
  items: z.array(z.object({
    variation_id: z.number().int().positive(),
    quantity: z.number().int().positive().max(ORDER_MAX_QUANTITY_PER_LINE),
  }).strict()).min(1).max(ORDER_MAX_LINES),
}).strict()

/**
 * IP de origem (só para anti-spam; nunca gravado cru). ATENÇÃO: `X-Forwarded-For` só é
 * confiável se o proxy de borda (Traefik/EasyPanel) SOBRESCREVE o valor enviado pelo cliente.
 * Por isso dá pra apontar um header que a borda controla via `WHOLESALE_CLIENT_IP_HEADER`
 * (ex.: `cf-connecting-ip`, `x-real-ip`). Sem a env, usa o 1º valor do X-Forwarded-For.
 * O teto global por empresa (na RPC) protege mesmo se este IP for falsificável.
 */
function clientIp(request: Request): string | null {
  const custom = process.env.WHOLESALE_CLIENT_IP_HEADER?.trim().toLowerCase()
  if (custom) return request.headers.get(custom)?.split(',')[0]?.trim() || null
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || request.headers.get('x-real-ip') || null
}

export async function POST(request: Request) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return NextResponse.json({ error: 'catalog_unavailable', message: ctx.error }, { status: ctx.status })

  // Só JSON de verdade: `text/plain`/form (POST cross-site sem preflight) não passa — evita spam
  // disparado a partir do navegador de terceiros em sites de outra origem.
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'unsupported_media_type', message: 'Content-Type deve ser application/json.' }, { status: 415 })
  }

  // Limita o corpo antes de parsear (payload excessivo).
  const raw = await request.text()
  if (raw.length > 100_000) return NextResponse.json({ error: 'payload_too_large', message: 'Pedido grande demais.' }, { status: 413 })

  let body: unknown
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'invalid_json', message: 'JSON inválido.' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_payload', message: 'Dados do pedido inválidos.' }, { status: 422 })

  let result: Awaited<ReturnType<typeof createWholesaleOrder>>
  try {
    result = await createWholesaleOrder({
      companyId: ctx.companyId,
      settings: ctx.settings,
      idempotencyKey: parsed.data.idempotency_key,
      customer: parsed.data.customer,
      items: parsed.data.items.map((i) => ({ variationId: i.variation_id, quantity: i.quantity })),
      clientIp: clientIp(request),
    })
  } catch (err) {
    return publicRouteError('POST /api/wholesale/orders', err, { company_id: ctx.companyId, idempotency_key: parsed.data.idempotency_key, lines: parsed.data.items.length })
  }

  if (!result.ok) {
    const { status, ...payload } = result
    return NextResponse.json(payload, { status })
  }

  const { order } = result
  const whatsapp = buildOrderWhatsAppMessage(order, ctx.settings.whatsappPhone)
  if (!whatsapp) return NextResponse.json({ error: 'whatsapp_not_configured', message: 'WhatsApp indisponível.' }, { status: 503 })

  // Resposta pública mínima: SEM dados pessoais (nome/telefone), sem id interno.
  return NextResponse.json({
    replay: result.replay,
    whatsappUrl: whatsapp.url,
    order: {
      code: order.code,
      totalItems: order.totalItems,
      subtotal: order.subtotal,
      items: order.items.map((i) => ({
        productName: i.productName, sku: i.sku, attributes: i.attributes,
        quantity: i.quantity, unitPrice: i.unitPrice, subtotal: i.subtotal,
      })),
    },
  }, { status: result.replay ? 200 : 201 })
}
