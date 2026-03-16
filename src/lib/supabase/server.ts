/**
 * Supabase Server Client
 * Use em Server Components, Server Actions e API Routes.
 * Lê cookies para manter a sessão do usuário.
 * Respeita RLS — acesso limitado ao que o usuário pode ver.
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database.types'

export function createClient() {
  const cookieStore = cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component — cookies não podem ser setados neste contexto.
            // O middleware tratará o refresh da sessão.
          }
        },
      },
    }
  )
}
