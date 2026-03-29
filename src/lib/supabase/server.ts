import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database.types'

export function createClient() {
  const cookieStore = cookies()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL não definida.')
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY não definida.')

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options as never)
          )
        } catch {
          // Falhas silenciosas em Server Components são esperadas.
          // Cookies de sessão são atualizados pelo middleware.
        }
      },
    },
  })
}
