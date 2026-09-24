export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { getMercadoLivreSizeChart } from '@/services/channels/mercadolivreChannel'
import { channelErrorResponse, requireChannelUser } from '@/app/api/channels/_shared'

/** GET — linhas de uma tabela de medidas (para casar SIZE da variação → SIZE_GRID_ROW_ID). */
export async function GET(_request: Request, { params }: { params: { chartId: string } }) {
  const { user, response } = await requireChannelUser()
  if (response) return response
  const chartId = params.chartId?.trim()
  if (!chartId || !/^\d{1,20}$/.test(chartId)) return NextResponse.json({ error: 'Tabela inválida.' }, { status: 400 })
  try {
    return NextResponse.json({ chart: await getMercadoLivreSizeChart(user.company_id, chartId) })
  } catch (err) {
    return channelErrorResponse(err)
  }
}
