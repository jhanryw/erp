export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { searchMercadoLivreSizeCharts } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'
import { zodErrorMessage } from '@/app/api/produtos/kits/schema'

const bodySchema = z.object({
  domain_id: z.string().trim().regex(/^([A-Z]{3}-)?[A-Z0-9_]{2,80}$/, 'Domínio inválido.'),
  attributes: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    value_id: z.string().trim().max(80).nullable().optional(),
    value_name: z.string().trim().max(255).nullable().optional(),
  })).max(200).default([]),
})

/** POST — tabelas de medidas aplicáveis (domínio + filtros exigidos pela ficha técnica). */
export async function POST(request: Request) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })
  try {
    return NextResponse.json(await searchMercadoLivreSizeCharts(user.company_id, parsed.data.domain_id, parsed.data.attributes))
  } catch (err) {
    return channelErrorResponse(err)
  }
}
