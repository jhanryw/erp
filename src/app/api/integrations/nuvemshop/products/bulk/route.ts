import { NextResponse } from 'next/server'
import { requireNuvemshopRouteContext } from '@/services/nuvemshop/routeContext'
import { publishProductToNuvemshop } from '@/services/nuvemshop/publish.service'
import { getNuvemshopPublicationOverview } from '@/services/nuvemshop/publicationStatus.service'

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * "Enviar todos para Nuvemshop" (/produtos). Antes criava produto de 1
 * variante e mapeava só a primeira; agora delega ao service canônico
 * (todas as variações ativas, pareadas por SKU). Resposta mantém o formato.
 */
export async function POST(_request: Request) {
  const { ctx, response } = await requireNuvemshopRouteContext('gerente')
  if (response) return response

  const overview = await getNuvemshopPublicationOverview(ctx.companyId)
  if (!overview.ok) return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })

  const total = overview.data.items.length
  let enviados = 0
  let pulados = 0
  const erros: { id: number; name: string; error: string }[] = []

  for (const item of overview.data.items) {
    if (item.state === 'published') { pulados++; continue }
    const r = await publishProductToNuvemshop(ctx, item.id)
    if (r.status === 'published' || r.status === 'relinked') enviados++
    else if (r.status === 'already_published') pulados++
    else erros.push({ id: item.id, name: item.name, error: r.message ?? 'Erro desconhecido' })
    await sleep(DELAY_MS)
  }

  return NextResponse.json({ total, enviados, pulados, erros })
}
