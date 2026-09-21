export const dynamic = 'force-dynamic'
// Catálogo/estoque/pedido NUNCA podem sair do cache de dados do Next (supabase-js usa fetch GET).
export const fetchCache = 'force-no-store'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { publicRouteError, resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { revalidateWholesaleCart } from '@/services/wholesale/cartValidation'

// Sem sessão de cliente — o catálogo não tem login (seção 1 do pedido).
// Só revalida preço/estoque contra o banco real antes do WhatsApp; nunca
// cria venda, nunca baixa/reserva estoque.

const schema = z.object({
  items: z.array(z.object({
    variationId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1).max(200),
})

export async function POST(request: Request) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  try {
    const result = await revalidateWholesaleCart(ctx.companyId, parsed.data.items)
    return NextResponse.json(result)
  } catch (err) {
    return publicRouteError('POST /api/wholesale/cart/validate', err, { company_id: ctx.companyId, lines: parsed.data.items.length })
  }
}
