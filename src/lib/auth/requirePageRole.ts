import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile, type UserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

/**
 * Proteção de role para Server Components (páginas).
 * Redireciona para /login se não autenticado, /403 se role insuficiente.
 * Retorna o UserProfile (id, role, company_id, ...) da sessão autenticada —
 * chamadores que só precisam do gate de permissão podem seguir ignorando o
 * retorno (`await requirePageRole('gerente')`), sem nenhuma alteração.
 *
 * @example
 * // Só o gate, sem usar o perfil:
 * export default async function AlgumaPagina() {
 *   await requirePageRole('gerente')
 *   // ...
 * }
 *
 * @example
 * // Gate + company_id da sessão, nunca de parâmetro confiado do cliente:
 * export default async function FinanceiroPage() {
 *   const profile = await requirePageRole('gerente')
 *   const entries = await getEntries(profile.company_id)
 *   // ...
 * }
 */
export async function requirePageRole(minRole: AppRole): Promise<UserProfile> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const profile = await getUserProfile(user.id, user.email)

  if (!hasMinRole(profile.role, minRole)) redirect('/403')

  return profile
}
