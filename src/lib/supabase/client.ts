/**
 * Supabase Browser Client
 * Use em Client Components ('use client')
 *
 * Dev bypass: usa a service_role key (NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY)
 * quando disponível, pois o Supabase self-hosted pode rejeitar a anon key
 * se o JWT_SECRET não estiver sincronizado.
 * Em produção com auth real, trocar pela anon key + RLS policies.
 */
import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database.types'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co'
  // Usa service_role (dev bypass) se disponível, senão cai na anon key
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    'placeholder-key'
  return createBrowserClient<Database>(url, key)
}
