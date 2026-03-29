import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

export interface UserProfile {
  id: string
  name: string
  email?: string
  role: AppRole
}

/**
 * Busca o perfil completo do usuário pela tabela public.users.
 * Usa o client admin (service role) para garantir leitura independente de RLS.
 *
 * ⚠️  Para uso exclusivo em Server Components e API Routes.
 *     Nunca importe este módulo em Client Components.
 */
export async function getUserProfile(userId: string, email?: string): Promise<UserProfile> {
  try {
    const admin = createAdminClient()
    const { data } = (await admin
      .from('users')
      .select('name, role')
      .eq('id', userId)
      .single()) as unknown as { data: { name: string | null; role: string | null } | null }

    return {
      id: userId,
      name: data?.name ?? email?.split('@')[0] ?? 'Usuário',
      email,
      role: normalizeRole(data?.role),
    }
  } catch {
    // Fallback seguro: retorna role mínimo para evitar escalada indevida de privilégios
    return {
      id: userId,
      name: email?.split('@')[0] ?? 'Usuário',
      email,
      role: 'usuario',
    }
  }
}

/**
 * Retorna apenas o role do usuário — otimizado para uso em requireRole().
 * Evita buscar campos desnecessários quando só o role é relevante.
 */
export async function getUserRole(userId: string): Promise<AppRole> {
  try {
    const admin = createAdminClient()
    const { data } = (await admin
      .from('users')
      .select('role')
      .eq('id', userId)
      .single()) as unknown as { data: { role: string | null } | null }
    return normalizeRole(data?.role)
  } catch {
    return 'usuario' // fallback seguro
  }
}
