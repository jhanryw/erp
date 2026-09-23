/**
 * Contexto Nuvemshop para rotas autenticadas: sessão (role mínima) →
 * company_id da sessão → integração da empresa. Nunca aceita empresa do
 * payload.
 */

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/supabase/session'
import { resolveNuvemshopContextForCompany, type NuvemshopContext } from './context.service'

type AppRole = Parameters<typeof requireRole>[0]

export async function requireNuvemshopRouteContext(
  minRole: AppRole = 'gerente',
): Promise<{ ctx: NuvemshopContext; response: null } | { ctx: null; response: NextResponse }> {
  const { user, response } = await requireRole(minRole)
  if (response) return { ctx: null, response }
  if (!user.company_id) {
    return { ctx: null, response: NextResponse.json({ error: 'Usuário sem empresa.' }, { status: 403 }) }
  }
  const ctx = await resolveNuvemshopContextForCompany(user.company_id)
  if (!ctx.ok) {
    return { ctx: null, response: NextResponse.json({ error: ctx.error }, { status: ctx.status ?? 500 }) }
  }
  return { ctx: ctx.data, response: null }
}
