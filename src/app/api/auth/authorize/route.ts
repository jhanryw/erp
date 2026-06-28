import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { getUserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'

// Ações destrutivas exigem motivo preenchido
const REASON_REQUIRED_ACTIONS = new Set(['cancel_sale', 'return_sale', 'exchange_sale'])

const schema = z.object({
  email:           z.string().email(),
  password:        z.string().min(1),
  action:          z.string().min(1),
  resource_type:   z.string().optional(),
  resource_id:     z.string().optional(),
  reason:          z.string().max(500).optional(),
  // Apenas para approve_discount: percentual e valor no momento da autorização
  discount_pct:    z.number().min(0).max(100).optional(),
  discount_amount: z.number().min(0).optional(),
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

  const { email, password, action, resource_type, resource_id, reason, discount_pct, discount_amount } = parsed.data

  // Validar motivo para ações destrutivas antes de qualquer verificação de credencial
  if (REASON_REQUIRED_ACTIONS.has(action) && !reason?.trim()) {
    return NextResponse.json({ error: 'Motivo é obrigatório para esta ação.' }, { status: 422 })
  }

  const admin = createAdminClient()

  // Verificar credenciais via função SECURITY DEFINER — sem criar sessão no Supabase
  const { data: verifyRows, error: verifyError } = await (admin as any)
    .rpc('fn_verify_user_password', { p_email: email, p_password: password }) as unknown as {
      data: { user_id: string; is_valid: boolean }[] | null
      error: { message: string } | null
    }

  if (verifyError) {
    console.error('[authorize] fn_verify_user_password error:', verifyError.message)
    return NextResponse.json({ error: 'Erro ao verificar credenciais.' }, { status: 500 })
  }

  const verifyRow = verifyRows?.[0]
  if (!verifyRow || !verifyRow.is_valid) {
    return NextResponse.json({ error: 'Credenciais inválidas.' }, { status: 401 })
  }

  const authorizedUserId = verifyRow.user_id

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

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  const { data: token, error: tokenError } = await (admin as any)
    .from('authorization_tokens')
    .insert({
      company_id:               requestingUser.company_id,
      requested_by:             requestingUser.id,
      authorized_by:            authorizedUserId,
      action,
      resource_type:            resource_type ?? null,
      resource_id:              resource_id ?? null,
      reason:                   reason?.trim() ?? null,
      expires_at:               expiresAt,
      authorized_discount_pct:  discount_pct ?? null,
      authorized_discount_amount: discount_amount ?? null,
    })
    .select('id')
    .single() as unknown as { data: { id: string } | null; error: unknown }

  if (tokenError || !token) {
    return NextResponse.json({ error: 'Erro ao criar token de autorização.' }, { status: 500 })
  }

  return NextResponse.json({ token_id: token.id })
}
