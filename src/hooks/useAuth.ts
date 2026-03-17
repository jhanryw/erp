'use client'

// ⚠️ DEV BYPASS — retorna usuário admin fixo sem consultar o Supabase Auth.
// Para reativar: restaure a versão original com supabase.auth.getUser() e
// a query em public.users para buscar name/role.

import type { UserRole } from '@/types/database.types'

interface AuthUser {
  id: string
  email: string | undefined
  name: string
  role: UserRole
}

const DEV_ADMIN: AuthUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'dev@santtorini.local',
  name: 'Dev Admin',
  role: 'admin',
}

export function useAuth() {
  return {
    user: DEV_ADMIN,
    loading: false,
    signOut: async () => { window.location.href = '/' },
    isAdmin: true,
    isSeller: false,
  }
}
