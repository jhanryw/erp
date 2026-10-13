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
import { buildOrderWhatsAppMessage, buildPendingOrderWhatsAppMessage } from '@/lib/wholesale/whatsapp'
import { resolveClientIp } from '@/lib/wholesale/clientIp'
import { createWholesaleOrder, ORDER_MAX_LINES, ORDER_MAX_QUANTITY_PER_LINE } from '@/services/wholesale/orders'

const schema = z.object({
  idempotency_key: z.string().uuid(),
  // Opcional: o carrinho não pede mais nome/WhatsApp — o cliente é identificado pela conversa no WhatsApp.
  customer: z.object({
    name: z.string().min(1).max(120),
    phone: z.string().min(8).max(30),
  }).strict().optional(),
  items: z.array(z.object({
    variation_id: z.number().int().positive(),
    quantity: z.number().int().positive().max(ORDER_MAX_QUANTITY_PER_LINE),
  }).strict()).min(1).max(ORDER_MAX_LINES),
}).strict()

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
      customer: parsed.data.customer ?? null,
      items: parsed.data.items.map((i) => ({ variationId: i.variation_id, quantity: i.quantity })),
      // Só IP de proxy declarado como confiável (ver clientIp.ts); senão null → balde de IP desconhecido.
      clientIp: resolveClientIp(request.headers).ip,
    })
  } catch (err) {
    return publicRouteError('POST /api/wholesale/orders', err, { company_id: ctx.companyId, idempotency_key: parsed.data.idempotency_key, lines: parsed.data.items.length })
  }

  if (!result.ok) {
    const { status, error, message, minimumOrder, currentTotal, missingAmount, validation, fallbackLines } = result

    // Fallback SOMENTE para rate limiting: o carrinho já passou pela validação do servidor (estoque, preço e
    // mínimo), e a mensagem é montada AQUI com as linhas do banco — nada do que o cliente enviou entra nela.
    // Não é um pedido registrado: não há código nem confirmação de registro.
    if (error === 'rate_limited' && fallbackLines) {
      const pending = buildPendingOrderWhatsAppMessage(fallbackLines, ctx.settings.whatsappPhone)
      if (pending) {
        return NextResponse.json({
          error, message,
          fallback: { whatsappUrl: pending.url, message: pending.message, totalItems: pending.totalItems, subtotal: pending.subtotal },
        }, { status })
      }
    }

    // Resposta pública enxuta e explícita: só campos conhecidos (nunca o objeto interno inteiro).
    return NextResponse.json({
      error, message,
      ...(minimumOrder != null ? { minimumOrder, currentTotal, missingAmount } : {}),
      ...(status === 409 && validation ? { validation } : {}),
    }, { status })
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
