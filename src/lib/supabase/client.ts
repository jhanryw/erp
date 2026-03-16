/**
 * Supabase Browser Client
 * Use em Client Components ('use client')
 * Responde RLS com a sessão do usuário logado.
 */
import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database.types'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co'
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-key'
  return createBrowserClient<Database>(url, key)
}
