/**
 * Conta de cliente do site de atacado — Fase 8, seção 16 do pedido.
 *
 * Reaproveita `public.customers` (nenhuma tabela paralela) — só ADICIONA
 * a ligação com uma identidade de login (`auth_user_id`, ver migration
 * `202609040900_wholesale_site_foundation.sql`). Signup faz merge-or-
 * create: se já existe um cliente desta empresa com o mesmo email/
 * telefone/CPF/CNPJ (cadastro anterior via balcão, por exemplo), a conta
 * nova se LIGA a esse cliente existente em vez de duplicar — item 25/26
 * do pedido ("cliente existente"/"cliente novo").
 *
 * Cria a identidade em `auth.users` via Admin API (mesma tecnologia já
 * usada pro staff — `email_confirm: true` pula verificação de e-mail
 * nesta primeira versão, já que não há infraestrutura de envio de e-mail
 * transacional auditada neste projeto) e então autentica de verdade
 * (grava cookie de sessão) — as duas etapas juntas.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/errors/log'

export interface SignupInput {
  companyId: number
  email: string
  password: string
  name: string
  phone: string
  cpf?: string | null
  cnpj?: string | null
}

export type AuthOutcome =
  | { ok: true; customerId: number }
  | { ok: false; status: number; error: string }

export async function signupWholesaleCustomer(input: SignupInput): Promise<AuthOutcome> {
  const admin = createAdminClient()

  // ── Merge-or-create: busca cliente existente desta empresa ──────────────
  const orFilters = [
    `email.eq.${input.email}`,
    `phone.eq.${input.phone}`,
    ...(input.cpf ? [`cpf.eq.${input.cpf}`] : []),
    ...(input.cnpj ? [`cnpj.eq.${input.cnpj}`] : []),
  ].join(',')

  const { data: existing } = await (admin as any)
    .from('customers')
    .select('id, auth_user_id')
    .eq('company_id', input.companyId)
    .or(orFilters)
    .limit(1)
    .maybeSingle() as { data: { id: number; auth_user_id: string | null } | null }

  if (existing?.auth_user_id) {
    return { ok: false, status: 409, error: 'Já existe uma conta com estes dados. Faça login.' }
  }

  // ── Cria a identidade de login (Admin API — mesma tecnologia do staff) ──
  const { data: authUser, error: authError } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  })
  if (authError || !authUser.user) {
    const msg = authError?.message?.includes('already been registered')
      ? 'Este e-mail já está cadastrado. Faça login.'
      : (authError?.message ?? 'Falha ao criar conta.')
    return { ok: false, status: 422, error: msg }
  }

  let customerId: number
  if (existing) {
    // Liga a conta nova a um cadastro já existente (ex.: cliente atendido
    // antes no balcão) — nunca duplica a identidade CRM.
    const { error: linkError } = await (admin as any)
      .from('customers')
      .update({ auth_user_id: authUser.user.id, cnpj: input.cnpj ?? undefined })
      .eq('id', existing.id)
    if (linkError) {
      await admin.auth.admin.deleteUser(authUser.user.id)
      return { ok: false, status: 500, error: 'Falha ao vincular conta ao cadastro existente.' }
    }
    customerId = existing.id
  } else {
    const { data: created, error: createError } = await (admin as any)
      .from('customers')
      .insert({
        company_id: input.companyId,
        auth_user_id: authUser.user.id,
        name: input.name,
        email: input.email,
        phone: input.phone,
        cpf: input.cpf ?? null,
        cnpj: input.cnpj ?? null,
        is_anonymous: false,
      })
      .select('id')
      .single() as { data: { id: number } | null; error: { message: string } | null }

    if (createError || !created) {
      // Fase 8, seção 33 do pedido — API pública nunca repassa mensagem
      // crua do Postgres (poderia vazar nome de constraint/coluna). Log
      // técnico fica só no servidor; cliente recebe mensagem operacional.
      logError({ route: 'signupWholesaleCustomer', err: new Error(createError?.message ?? 'insert customers falhou'), context: { companyId: input.companyId } })
      await admin.auth.admin.deleteUser(authUser.user.id)
      return { ok: false, status: 500, error: 'Falha ao criar cadastro de cliente. Tente novamente.' }
    }
    customerId = created.id
  }

  // ── Estabelece a sessão de verdade (grava cookie) ────────────────────────
  const sessionClient = createClient()
  const { error: signInError } = await sessionClient.auth.signInWithPassword({ email: input.email, password: input.password })
  if (signInError) {
    return { ok: false, status: 500, error: 'Conta criada, mas não foi possível iniciar a sessão. Tente fazer login.' }
  }

  return { ok: true, customerId }
}

export async function loginWholesaleCustomer(email: string, password: string): Promise<AuthOutcome & { customerId?: number }> {
  const sessionClient = createClient()
  const { data, error } = await sessionClient.auth.signInWithPassword({ email, password })
  if (error || !data.user) {
    return { ok: false, status: 401, error: 'E-mail ou senha inválidos.' }
  }

  const admin = createAdminClient()
  const { data: customer } = await (admin as any)
    .from('customers')
    .select('id')
    .eq('auth_user_id', data.user.id)
    .maybeSingle() as { data: { id: number } | null }

  if (!customer) {
    // Sessão Supabase válida, mas sem customers vinculado nesta empresa —
    // nunca trata como logado no site de atacado (evita, por exemplo, um
    // funcionário autenticado ser tratado como cliente).
    await sessionClient.auth.signOut()
    return { ok: false, status: 403, error: 'Esta conta não é uma conta de cliente do site de atacado.' }
  }

  return { ok: true, customerId: customer.id }
}

export async function logoutWholesaleCustomer(): Promise<void> {
  const sessionClient = createClient()
  await sessionClient.auth.signOut()
}
