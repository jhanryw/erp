import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeRole } from '@/types/roles'
import type { AppRole } from '@/types/roles'

export interface UserProfile {
  id: string
  name: string
  email?: string
  role: AppRole
  company_id: number | null
}

/**
 * Busca o perfil completo do usuário pela tabela public.users.
 * Usa o client admin (service role) para garantir leitura independente de RLS.
 *
 * ⚠️  Para uso exclusivo em Server Components e API Routes.
 *     Nunca importe este módulo em Client Components.
 */
export async function getUserProfile(userId: string, email?: string): Promise<UserProfile> {
  const admin = createAdminClient()
  const { data, error } = (await admin
    .from('users')
    .select('name, role, company_id')
    .eq('id', userId)
    .single()) as unknown as {
    data: { name: string | null; role: string | null; company_id: number | null } | null
    error: { message: string } | null
  }

  if (error || !data) {
    console.error('[getUserProfile] Falha ao buscar perfil do usuário', { userId, error: error?.message })
    throw new Error(`getUserProfile falhou para userId=${userId}: ${error?.message ?? 'registro não encontrado'}`)
  }

  return {
    id: userId,
    name: data.name ?? email?.split('@')[0] ?? 'Usuário',
    email,
    role: normalizeRole(data.role),
    company_id: data.company_id ?? null,
  }
}

/**
 * Retorna apenas o role do usuário — otimizado para uso em requirePageRole().
 * Evita buscar campos desnecessários quando só o role é relevante.
 */
export async function getUserRole(userId: string): Promise<AppRole> {
  const admin = createAdminClient()
  const { data, error } = (await admin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()) as unknown as {
    data: { role: string | null } | null
    error: { message: string } | null
  }

  if (error || !data) {
    console.error('[getUserRole] Falha ao buscar role do usuário', { userId, error: error?.message })
    throw new Error(`getUserRole falhou para userId=${userId}: ${error?.message ?? 'registro não encontrado'}`)
  }

  return normalizeRole(data.role)
}
