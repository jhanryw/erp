import { createAdminClient } from '@/lib/supabase/admin'

export interface CashSession {
  id: number
  opened_at: string
  opening_amount_cash: number
}

export interface CashMovementResult {
  id: number
  type: string
  method: string
  amount: number
  created_at: string
}

export interface CloseSessionResult {
  id: number
  status: string
  closed_at: string
  total_sales: number
  total_cash: number
  total_pix: number
  total_credit_card: number
  total_debit_card: number
  total_card_fees: number
  total_cash_change: number
  total_pix_change: number
  total_sangria: number
  total_suprimento: number
  total_expenses: number
  expected_cash: number
  counted_cash: number
  cash_difference: number
}

type Ok<T> = { ok: true; data: T; error?: never }
type Err = { ok: false; error: string; status: number; data?: never }
type Outcome<T = undefined> = Ok<T> | Err

function success<T>(data: T): Ok<T> { return { ok: true, data } }
function failure(error: string, status = 500): Err { return { ok: false, error, status } }

export async function getOpenSession(userId: string): Promise<Outcome<CashSession | null>> {
  const admin = createAdminClient()

  const { data: user } = await admin
    .from('users')
    .select('company_id')
    .eq('id', userId)
    .single() as unknown as { data: { company_id: number } | null }

  if (!user?.company_id) return failure('Usuário não associado a uma empresa.', 400)

  const { data: session, error } = await admin
    .from('cash_register_sessions')
    .select('id, opened_at, opening_amount_cash')
    .eq('company_id', user.company_id)
    .eq('status', 'open')
    .maybeSingle() as unknown as {
      data: CashSession | null
      error: { message: string } | null
    }

  if (error) return failure(error.message)
  return success(session)
}

export async function openCashSession(
  userId: string,
  openingAmountCash: number,
  notes?: string | null
): Promise<Outcome<CashSession>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_open_cash_session', {
      p_user_id:             userId,
      p_opening_amount_cash: openingAmountCash,
      p_notes:               notes ?? null,
    }) as unknown as { data: CashSession | null; error: { code: string; message: string } | null }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }
  return success(data!)
}

export async function addCashMovement(params: {
  sessionId: number
  userId: string
  type: 'sangria' | 'suprimento'
  amount: number
  description: string
  method?: 'cash' | 'pix' | 'credit_card' | 'debit_card'
  referenceSaleId?: number | null
  metadata?: Record<string, unknown>
}): Promise<Outcome<CashMovementResult>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_add_cash_movement', {
      p_session_id:        params.sessionId,
      p_user_id:           params.userId,
      p_type:              params.type,
      p_amount:            params.amount,
      p_description:       params.description,
      p_method:            params.method ?? 'cash',
      p_reference_sale_id: params.referenceSaleId ?? null,
      p_metadata:          params.metadata ?? {},
    }) as unknown as { data: CashMovementResult | null; error: { code: string; message: string } | null }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }
  return success(data!)
}

export async function cancelCashMovement(
  movementId: number,
  userId: string,
  cancellationReason: string
): Promise<Outcome<{ id: number; cancelled_at: string }>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_cancel_cash_movement', {
      p_movement_id:         movementId,
      p_user_id:             userId,
      p_cancellation_reason: cancellationReason,
    }) as unknown as {
      data: { id: number; cancelled_at: string } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }
  return success(data!)
}

export async function reopenCashSession(
  sessionId: number,
  userId: string,
  reason: string
): Promise<Outcome<{ id: number; status: string; reopened_at: string }>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_reopen_cash_session', {
      p_session_id: sessionId,
      p_user_id:    userId,
      p_reason:     reason,
    }) as unknown as {
      data: { id: number; status: string; reopened_at: string } | null
      error: { code: string; message: string } | null
    }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }
  return success(data!)
}

export async function closeCashSession(
  sessionId: number,
  userId: string,
  countedCash: number,
  notes?: string | null
): Promise<Outcome<CloseSessionResult>> {
  const admin = createAdminClient()

  const { data, error } = await (admin as any)
    .rpc('rpc_close_cash_session', {
      p_session_id:   sessionId,
      p_user_id:      userId,
      p_counted_cash: countedCash,
      p_notes:        notes ?? null,
    }) as unknown as { data: CloseSessionResult | null; error: { code: string; message: string } | null }

  if (error) {
    return failure(error.message, error.code === 'P0001' ? 400 : 500)
  }
  return success(data!)
}
