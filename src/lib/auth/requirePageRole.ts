import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

/**
 * Proteção de role para Server Components (páginas).
 * Redireciona para /login se não autenticado, /403 se role insuficiente.
 *
 * @example
 * export default async function FinanceiroPage() {
 *   await requirePageRole('gerente')
 *   // ...
 * }
 */
export async function requirePageRole(minRole: AppRole): Promise<void> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const role = await getUserRole(user.id)

  if (!hasMinRole(role, minRole)) redirect('/403')
}
