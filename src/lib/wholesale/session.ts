/**
 * Sessão de cliente do site de atacado — Fase 8 (Site de Atacado).
 *
 * Reaproveita `@/lib/supabase/server` (`createClient()`) — o MESMO client
 * de sessão Supabase Auth já usado pelo staff. Auth em si não é "de
 * staff" ou "de cliente": é só um `auth.users.id`. O que diferencia é
 * qual tabela tem uma linha pra esse id — `public.users` (staff, RBAC) ou
 * `public.customers` (cliente do site). Esta função NUNCA consulta
 * `public.users`/`getUserProfile` — se um funcionário estiver logado e
 * visitar o site de atacado, `customers.auth_user_id` simplesmente não
 * bate com nada, e a sessão de cliente é tratada como ausente (correto:
 * staff não é cliente automaticamente).
 *
 * Isolado de propósito de `src/lib/supabase/session.ts`
 * (`requireRole`/`requireSession`, staff-only) — nunca reutilizado aqui,
 * nunca reutilizado lá.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveWholesaleSiteTenant } from './tenant'

export interface WholesaleCustomerSession {
  customerId: number
  companyId: number
  name: string
  email: string | null
  phone: string | null
  cpf: string | null
  cnpj: string | null
}

/**
 * `null` quando: sem sessão Supabase Auth, sem tenant configurado, ou o
 * `auth.users.id` da sessão não corresponde a nenhum `customers` desta
 * empresa (inclusive quando é um funcionário logado — ver nota acima).
 */
export async function getWholesaleCustomerSession(): Promise<WholesaleCustomerSession | null> {
  const tenant = await resolveWholesaleSiteTenant()
  if (!tenant) return null

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('customers')
    .select('id, name, email, phone, cpf, cnpj')
    .eq('auth_user_id', user.id)
    .eq('company_id', tenant.companyId)
    .maybeSingle() as {
      data: { id: number; name: string; email: string | null; phone: string | null; cpf: string | null; cnpj: string | null } | null
    }

  if (!data) return null

  return {
    customerId: data.id,
    companyId: tenant.companyId,
    name: data.name,
    email: data.email,
    phone: data.phone,
    cpf: data.cpf,
    cnpj: data.cnpj,
  }
}
