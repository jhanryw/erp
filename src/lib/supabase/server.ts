/**
 * ⚠️ DEV BYPASS — usa service_role_key em vez da anon key.
 * Ignora RLS em todas as tabelas. NÃO use em produção.
 *
 * Para reativar: troque de volta para createServerClient com
 * NEXT_PUBLIC_SUPABASE_ANON_KEY e o handler de cookies original.
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.types'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  // Usa service_role → bypassa RLS. Fallback para anon se a key não estiver definida.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

  return createSupabaseClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
