export const dynamic = 'force-dynamic'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  // Atualização de status de envio — operacional, qualquer usuário autenticado
  const { response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  const body = await req.json()
  const admin = createAdminClient() // admin client: tabela de envios com RLS
  const { error } = await (admin as any)
    .from('shipments')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', Number(params.id))
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
