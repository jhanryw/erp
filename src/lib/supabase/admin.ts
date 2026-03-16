/**
 * Supabase Admin Client (Service Role)
 * ⚠️  NUNCA importar em componentes Client ou expor ao browser.
 * Use APENAS em API Routes e Server Actions para operações privilegiadas:
 * - Jobs de cron (refresh views, cashback release, RFM)
 * - Operações que precisam bypassar RLS
 * - Criação de usuários (admin provisioning)
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database.types'

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY devem estar definidos no servidor.'
    )
  }

  return createSupabaseClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
