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

export async function getUserProfile(userId: string, email?: string): Promise<UserProfile> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('users')
    .select('name, role, company_id')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('Erro ao buscar perfil em public.users:', {
      userId,
      email,
      error,
    })
    throw error
  }

  return {
    id: userId,
    name: data?.name ?? email?.split('@')[0] ?? 'Usuário',
    email,
    role: normalizeRole(data?.role),
    company_id: data?.company_id ?? null,
  }
}

export async function getUserRole(userId: string): Promise<AppRole> {
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('Erro ao buscar role em public.users:', { userId, error })
    throw error
  }

  return normalizeRole(data?.role)
}