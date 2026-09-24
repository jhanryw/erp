export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getMercadoLivreSizeChartTemplate } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'
import { zodErrorMessage } from '@/app/api/produtos/kits/schema'
import { templateBodySchema } from '../_schema'

/** POST — ficha técnica da tabela de medidas do domínio (campos do formulário de criação). */
export async function POST(request: Request) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = templateBodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })
  try {
    return NextResponse.json({ template: await getMercadoLivreSizeChartTemplate(user.company_id, parsed.data.domain_id, parsed.data.attributes) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
