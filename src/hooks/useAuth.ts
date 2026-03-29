'use client'

/**
 * Hook de autenticação para Client Components.
 *
 * Responsabilidade: gerenciar estado de sessão e sign-out.
 *
 * NOTA: nome e role do usuário NÃO são retornados por este hook.
 * Esses dados vêm do Server Component (layout) via UserRoleProvider
 * e são consumidos com useUserContext(). Isso mantém toda a
 * autorização no servidor e evita queries client-side ao banco.
 */

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'

export interface UseAuthReturn {
  user: User | null
  loading: boolean
  signOut: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()

    // Carrega sessão já existente sem esperar refresh do servidor
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    // Mantém estado sincronizado com mudanças de sessão (logout em outra aba, expiração, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setLoading(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signOut = useCallback(async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }, [])

  return { user, loading, signOut }
}
