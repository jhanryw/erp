export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { logError } from '@/lib/errors/log'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const createSchema = z.object({
  name:     z.string().min(2, 'Nome obrigatório').max(80),
  slug:     z.string().min(2).max(80).regex(/^[a-z0-9-]+$/, 'Slug: só letras minúsculas, números e hífens'),
  priority: z.coerce.number().int().min(1).default(100),
})

const updateSchema = createSchema.partial().extend({
  active: z.boolean().optional(),
})

/** Lista todos os locais de estoque da empresa */
export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  try {
    const admin = createAdminClient()
    const { data, error } = await (admin as any)
      .from('stock_locations')
      .select('id, name, slug, is_main_store, active, priority, created_at')
      .eq('company_id', user.company_id)
      .order('priority', { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ locations: data ?? [] })
  } catch (err) {
    logError({ route: 'GET /api/estoque/localizacoes', err })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}

/** Cria um novo local de estoque */
export async function POST(request: Request) {
  // Fase 2: local de estoque não tem dado financeiro — reativado para usuario.
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    const flat = parsed.error.flatten()
    const fieldMsg = Object.values(flat.fieldErrors as Record<string, string[]>)[0]?.[0]
    return NextResponse.json({ error: fieldMsg ?? 'Dados inválidos' }, { status: 400 })
  }

  try {
    const admin = createAdminClient()
    const { data, error } = await (admin as any)
      .from('stock_locations')
      .insert({
        company_id:    user.company_id,
        name:          parsed.data.name,
        slug:          parsed.data.slug,
        is_main_store: false,   // novos locais nunca são o principal
        priority:      parsed.data.priority,
        active:        true,
      })
      .select('id, name, slug, is_main_store, active, priority')
      .single()

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Slug já existe para esta empresa.' }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    logError({ route: 'POST /api/estoque/localizacoes', err })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
