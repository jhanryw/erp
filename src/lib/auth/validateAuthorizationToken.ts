import { createAdminClient } from '@/lib/supabase/admin'

interface ValidateOptions {
  tokenId:     string
  action:      string
  requestedBy: string
  companyId:   number
}

interface ValidateResult {
  ok:            boolean
  authorizedBy?: string
  reason?:       string
  error?:        string
}

export async function validateAuthorizationToken(opts: ValidateOptions): Promise<ValidateResult> {
  const admin = createAdminClient()

  const { data: token } = await (admin as any)
    .from('authorization_tokens')
    .select('id, authorized_by, reason, expires_at, used_at')
    .eq('id', opts.tokenId)
    .eq('action', opts.action)
    .eq('requested_by', opts.requestedBy)
    .eq('company_id', opts.companyId)
    .maybeSingle() as unknown as {
      data: {
        id: string
        authorized_by: string
        reason: string | null
        expires_at: string
        used_at: string | null
      } | null
    }

  if (!token) return { ok: false, error: 'Token de autorização inválido ou não encontrado.' }
  if (token.used_at) return { ok: false, error: 'Token de autorização já foi utilizado.' }
  if (new Date(token.expires_at) < new Date()) return { ok: false, error: 'Token de autorização expirado.' }

  await (admin as any)
    .from('authorization_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', opts.tokenId)

  return {
    ok:           true,
    authorizedBy: token.authorized_by,
    reason:       token.reason ?? undefined,
  }
}
