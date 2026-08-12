export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'

export interface Seller {
  id: number
  name: string
}

export interface SellersResponse {
  sellers: Seller[]
  my_seller: Seller | null
  locked: boolean
}

export async function GET(): Promise<NextResponse> {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  const admin = createAdminClient()

  const { data: sellers, error } = await admin
    .from('sellers')
    .select('id, name, user_id')
    .eq('company_id', user.company_id)
    .eq('active', true)
    .order('name') as unknown as {
      data: { id: number; name: string; user_id: string | null }[] | null
      error: { message: string } | null
    }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const list = sellers ?? []

  const mySeller = list.find((s) => s.user_id === user.id) ?? null

  // usuario só pode registrar vendas em seu próprio nome — reforçado
  // server-side em POST /api/vendas (assertResponsibleSellerAllowed).
  // Esta flag só controla a UI (SellerPicker); a autorização real está lá.
  const locked = user.role === 'usuario'

  const response: SellersResponse = {
    sellers: list.map(({ id, name }) => ({ id, name })),
    my_seller: mySeller ? { id: mySeller.id, name: mySeller.name } : null,
    locked,
  }

  return NextResponse.json(response)
}
