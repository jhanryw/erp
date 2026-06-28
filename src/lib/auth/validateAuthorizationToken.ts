import { createAdminClient } from '@/lib/supabase/admin'

interface ValidateOptions {
  tokenId:     string
  action:      string
  requestedBy: string
  companyId:   number
}

interface ValidateResult {
  ok:                       boolean
  authorizedBy?:            string
  reason?:                  string
  authorizedDiscountPct?:   number
  authorizedDiscountAmount?: number
  error?:                   string
}

/**
 * Valida e consome um token de autorização de forma ATÔMICA.
 *
 * O UPDATE com todas as condições no WHERE é executado como uma única instrução SQL.
 * Se dois requests tentarem usar o mesmo token simultaneamente, apenas um receberá
 * a linha no RETURNING — o outro receberá 0 linhas e será rejeitado.
 * Não há race condition possível.
 */
export async function validateAuthorizationToken(opts: ValidateOptions): Promise<ValidateResult> {
  const admin = createAdminClient()
  const now   = new Date().toISOString()

  // UPDATE atômico: marca used_at e retorna dados do token em uma única instrução
  const { data: claimed } = (await (admin as any)
    .from('authorization_tokens')
    .update({ used_at: now })
    .eq('id',           opts.tokenId)
    .eq('action',       opts.action)
    .eq('requested_by', opts.requestedBy)
    .eq('company_id',   opts.companyId)
    .is('used_at', null)
    .gt('expires_at', now)
    .select('authorized_by, reason, authorized_discount_pct, authorized_discount_amount')
  ) as unknown as {
    data: {
      authorized_by:              string
      reason:                     string | null
      authorized_discount_pct:    number | null
      authorized_discount_amount: number | null
    }[] | null
  }

  if (!claimed || claimed.length === 0) {
    return { ok: false, error: 'Token de autorização inválido, expirado ou já utilizado.' }
  }

  const t = claimed[0]
  return {
    ok:                       true,
    authorizedBy:             t.authorized_by,
    reason:                   t.reason ?? undefined,
    authorizedDiscountPct:    t.authorized_discount_pct  ?? undefined,
    authorizedDiscountAmount: t.authorized_discount_amount ?? undefined,
  }
}
