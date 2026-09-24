export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/audit/log'
import { createMercadoLivreSizeChart } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'
import { zodErrorMessage } from '@/app/api/produtos/kits/schema'
import { createChartBodySchema } from './_schema'

/**
 * POST — cria tabela de medidas SPECIFIC para o seller conectado.
 * Só em usuário TEST do ML (mesma trava da publicação).
 */
export async function POST(request: Request) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const parsed = createChartBodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: zodErrorMessage(parsed.error) }, { status: 422 })
  const b = parsed.data
  try {
    const chart = await createMercadoLivreSizeChart(user.company_id, {
      domainId: b.domain_id, name: b.name, measureType: b.measure_type ?? null, mainAttributeId: b.main_attribute_id,
      attributes: b.attributes, rows: b.rows,
    })
    auditLog({
      userId: user.id, userRole: user.role, action: 'create', resource: 'company_integration', resourceId: chart.id,
      detail: `mercadolivre: tabela de medidas ${chart.id} criada (${b.domain_id}, ${chart.rows.length} tamanhos)`,
    })
    return NextResponse.json({ chart }, { status: 201 })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
