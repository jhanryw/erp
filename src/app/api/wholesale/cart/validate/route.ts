export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { resolveWholesaleSiteTenant } from '@/lib/wholesale/tenant'
import { revalidateWholesaleCart } from '@/services/wholesale/cartValidation'

// Sem sessão de cliente — o catálogo não tem login (seção 1 do pedido).
// Só revalida preço/estoque contra o banco real antes do WhatsApp; nunca
// cria venda, nunca baixa/reserva estoque.

const schema = z.object({
  items: z.array(z.object({
    variationId: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })).min(1),
})

export async function POST(request: Request) {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return NextResponse.json({ error: 'Catálogo de atacado não configurado.' }, { status: 404 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const result = await revalidateWholesaleCart(tenant.companyId, parsed.data.items)
  return NextResponse.json(result)
}
