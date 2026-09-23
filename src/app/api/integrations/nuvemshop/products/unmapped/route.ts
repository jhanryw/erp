import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { getNuvemshopPublicationOverview } from '@/services/nuvemshop/publicationStatus.service'

/**
 * Situação de publicação dos produtos ativos da empresa.
 *   products: não publicados (compatibilidade com a resposta antiga)
 *   items:    todos, com state 'not_published' | 'published' | 'inconsistent'
 * Estoque NÃO esconde produto — só vem como `stock_total`.
 */
export async function GET() {
  const { user, response } = await requireRole('gerente')
  if (response) return response
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa.' }, { status: 403 })

  const overview = await getNuvemshopPublicationOverview(user.company_id)
  if (!overview.ok) return NextResponse.json({ error: 'Erro ao buscar produtos.' }, { status: 500 })

  return NextResponse.json({
    products: overview.data.items.filter((i) => i.state === 'not_published').map(({ id, name }) => ({ id, name })),
    items:    overview.data.items,
    counts:   overview.data.counts,
  })
}
