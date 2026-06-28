import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { getUserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'

const schema = z.object({
  email:         z.string().email(),
  password:      z.string().min(1),
  action:        z.string().min(1),
  resource_type: z.string().optional(),
  resource_id:   z.string().optional(),
  reason:        z.string().max(500).optional(),
})

export async function POST(request: Request) {
  const { user: requestingUser, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!requestingUser.company_id) {
    return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { email, password, action, resource_type, resource_id, reason } = parsed.data

  // Verificar credenciais com cliente standalone (sem cookie/sessão persistida)
  const verifyClient = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  const { data: signInData, error: signInError } = await verifyClient.auth.signInWithPassword({
    email,
    password,
  })

  if (signInError || !signInData.user) {
    return NextResponse.json({ error: 'Credenciais inválidas.' }, { status: 401 })
  }

  const authorizedUserId = signInData.user.id

  const authorizedProfile = await getUserProfile(authorizedUserId, email)

  if (!hasMinRole(authorizedProfile.role, 'gerente')) {
    return NextResponse.json(
      { error: 'Esta ação requer autorização de gerente ou administrador.' },
      { status: 403 }
    )
  }

  if (authorizedProfile.company_id !== requestingUser.company_id) {
    return NextResponse.json({ error: 'Gerente não pertence à mesma empresa.' }, { status: 403 })
  }

  const admin = createAdminClient()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { data: token, error: tokenError } = await (admin as any)
    .from('authorization_tokens')
    .insert({
      company_id:    requestingUser.company_id,
      requested_by:  requestingUser.id,
      authorized_by: authorizedUserId,
      action,
      resource_type: resource_type ?? null,
      resource_id:   resource_id ?? null,
      reason:        reason ?? null,
      expires_at:    expiresAt,
    })
    .select('id')
    .single() as unknown as { data: { id: string } | null; error: unknown }

  if (tokenError || !token) {
    return NextResponse.json({ error: 'Erro ao criar token de autorização.' }, { status: 500 })
  }

  return NextResponse.json({ token_id: token.id })
}
