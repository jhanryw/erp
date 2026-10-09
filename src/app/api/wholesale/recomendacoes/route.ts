export const dynamic = 'force-dynamic'
// Catálogo/estoque NUNCA podem sair do cache de dados do Next.
export const fetchCache = 'force-no-store'

import { NextResponse } from 'next/server'
import { publicRouteError, resolveWholesalePublicContext } from '@/lib/wholesale/publicContext'
import { getWholesaleRecommendations } from '@/services/wholesale/catalog'

const MAX_EXCLUDED = 200
const SEED_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * GET /api/wholesale/recomendacoes?exclude=1,2,3&seed=abc&limit=6
 * Pública e somente-leitura. O tenant é SEMPRE resolvido no servidor (nunca por parâmetro) e o
 * resultado passa pelas mesmas regras da vitrine — nada de outra empresa nem de produto oculto.
 */
export async function GET(request: Request) {
  const ctx = await resolveWholesalePublicContext()
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const { searchParams } = new URL(request.url)

  const excludeRaw = (searchParams.get('exclude') ?? '').split(',').filter(Boolean)
  const excludeProductIds = excludeRaw.slice(0, MAX_EXCLUDED).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  if (excludeRaw.length > 0 && excludeProductIds.length === 0) return NextResponse.json({ error: 'exclude inválido.' }, { status: 400 })

  const seedParam = searchParams.get('seed') ?? ''
  if (seedParam && !SEED_RE.test(seedParam)) return NextResponse.json({ error: 'seed inválida.' }, { status: 400 })
  const seed = seedParam || Math.random().toString(36).slice(2, 12)

  const limit = Number(searchParams.get('limit') ?? '6')

  try {
    const products = await getWholesaleRecommendations(ctx.companyId, { excludeProductIds, seed, limit: Number.isFinite(limit) ? limit : 6 })
    return NextResponse.json({ products })
  } catch (err) {
    return publicRouteError('GET /api/wholesale/recomendacoes', err, { company_id: ctx.companyId })
  }
}
