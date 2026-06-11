import { requireRole } from '@/lib/supabase/session'
import { logError } from '@/lib/errors/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  name:     z.string().min(2).max(80).optional(),
  active:   z.boolean().optional(),
  priority: z.coerce.number().int().min(1).optional(),
})

/** Atualiza nome, active ou priority de um local (nunca promove/rebaixa is_main_store via API) */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth

  const { id } = await params
  const locationId = parseInt(id)
  if (isNaN(locationId)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  try {
    const admin = createAdminClient()

    // Verificar que o local pertence à empresa
    const { data: existing } = await (admin as any)
      .from('stock_locations')
      .select('id, is_main_store, active')
      .eq('id', locationId)
      .eq('company_id', user.company_id)
      .maybeSingle() as { data: { id: number; is_main_store: boolean; active: boolean } | null }

    if (!existing) return NextResponse.json({ error: 'Local não encontrado.' }, { status: 404 })

    // Não permitir desativar o estoque principal
    if (existing.is_main_store && parsed.data.active === false) {
      return NextResponse.json({ error: 'Não é possível desativar o Estoque Loja principal.' }, { status: 422 })
    }

    const { data, error } = await (admin as any)
      .from('stock_locations')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', locationId)
      .eq('company_id', user.company_id)
      .select('id, name, slug, is_main_store, active, priority')
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data)
  } catch (err) {
    logError({ route: `PATCH /api/estoque/localizacoes/${locationId}`, err })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
