export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { requireRole } from '@/lib/supabase/session'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const schema = z.object({
  cash_movement_id: z.number().int().positive(),
  finance_entry_id: z.number().int().positive().optional().nullable(),
  category: z.enum([
    'sale', 'cashback_used', 'other_income',
    'stock_purchase', 'freight_cost', 'marketing',
    'rent', 'salaries', 'operational', 'taxes', 'other_expense',
  ]).optional().nullable(),
  reference_date: z.string().optional().nullable(),
  notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
})

// POST /api/admin/financeiro/regularizacao-caixa
//
// Regulariza uma despesa histórica do Caixa. Chama a RPC através do client
// de SESSÃO (createClient(), não createAdminClient()) — a RPC identifica o
// executor via auth.uid(), que só resolve corretamente quando a requisição
// carrega o JWT do próprio usuário autenticado. Não existe service dedicado
// aqui de propósito: a rota chama a RPC diretamente, mesmo padrão de
// /api/admin/refresh-views.
export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const supabase = createClient()
  const { data, error } = await (supabase as any).rpc('rpc_regularizar_despesa_caixa', {
    p_cash_movement_id: parsed.data.cash_movement_id,
    p_finance_entry_id: parsed.data.finance_entry_id ?? null,
    p_category:         parsed.data.category ?? null,
    p_reference_date:   parsed.data.reference_date ?? null,
    p_notes:            parsed.data.notes ?? null,
  }) as unknown as { data: Record<string, unknown> | null; error: { code: string; message: string } | null }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.code === 'P0001' ? 400 : 500 })
  }

  return NextResponse.json({ result: data }, { status: 200 })
}
