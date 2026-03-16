'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { User } from '@supabase/supabase-js'
import type { UserRole } from '@/types/database.types'

interface AuthUser {
  id: string
  email: string | undefined
  name: string
  role: UserRole
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function loadUser(authUser: User | null) {
      if (!authUser) {
        setUser(null)
        setLoading(false)
        return
      }

      const { data: profile } = await supabase
        .from('users')
        .select('name, role')
        .eq('id', authUser.id)
        .single()

      setUser({
        id: authUser.id,
        email: authUser.email,
        name: profile?.name ?? authUser.email ?? '',
        role: profile?.role ?? 'seller',
      })
      setLoading(false)
    }

    supabase.auth.getUser().then(({ data: { user } }) => loadUser(user))

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      loadUser(session?.user ?? null)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signOut = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  const isAdmin = user?.role === 'admin'
  const isSeller = user?.role === 'seller'

  return { user, loading, signOut, isAdmin, isSeller }
}
