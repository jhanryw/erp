export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { calculateShipping } from '@/lib/services/shippingCalculatorService'
import { z } from 'zod'

const schema = z.object({
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  cep: z.string().min(5),
  city: z.string().min(2),
  neighborhood: z.string().min(2),
  order_total: z.coerce.number().min(0),
})

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
    }

    const result = await calculateShipping(
      parsed.data.latitude,
      parsed.data.longitude,
      parsed.data.cep,
      parsed.data.city,
      parsed.data.neighborhood,
      parsed.data.order_total,
      'delivery'
    )

    return NextResponse.json(result, { status: 'error' in result ? 400 : 200 })
  } catch (error) {
    console.error('[API Shipping Calculate]', error)
    return NextResponse.json({ error: 'Erro ao processar requisição' }, { status: 500 })
  }
}
