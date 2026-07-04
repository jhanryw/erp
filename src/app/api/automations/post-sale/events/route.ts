import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const SENT_EVENT_TYPES = new Set([
  'cashback_message_sent',
  'csat_sent',
  'expiry_reminder_sent',
])

const schema = z.object({
  sale_id:          z.number().int().positive(),
  customer_id:      z.number().int().positive().optional(),
  event_type:       z.enum([
    'webhook_received',
    'cashback_message_sent',
    'csat_sent',
    'expiry_reminder_sent',
    'skipped_cashback_message',
    'skipped_csat',
    'skipped_expiry_reminder',
    'flow_ended_no_expiry',
    'error',
  ]),
  skip_reason:      z.string().optional(),
  n8n_execution_id: z.string().optional(),
  message:          z.string().optional(),
  context_snapshot: z.record(z.unknown()).optional(),
})

function isAuthorized(request: Request): boolean {
  const secret = process.env.N8N_AUTOMATION_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }

  const { sale_id, customer_id, event_type, skip_reason, n8n_execution_id, message, context_snapshot } = parsed.data

  const admin = createAdminClient()

  // Resolver company_id via sale_id — obrigatório, não pode ser null
  const { data: sale } = await (admin as any)
    .from('sales')
    .select('company_id, customer_id')
    .eq('id', sale_id)
    .maybeSingle() as { data: { company_id: number; customer_id: number } | null }

  if (!sale) {
    return NextResponse.json({ error: `Venda ${sale_id} não encontrada.` }, { status: 404 })
  }

  // sent_at preenchido automaticamente para eventos de mensagem enviada
  const sentAt = SENT_EVENT_TYPES.has(event_type) ? new Date().toISOString() : null

  const { data: inserted, error } = await (admin as any)
    .from('post_sale_automation_events')
    .insert({
      sale_id,
      customer_id:      customer_id ?? sale.customer_id,
      company_id:       sale.company_id,
      event_type,
      skip_reason:      skip_reason      ?? null,
      n8n_execution_id: n8n_execution_id ?? null,
      message:          message          ?? null,
      context_snapshot: context_snapshot ?? null,
      sent_at:          sentAt,
    })
    .select('id')
    .single() as { data: { id: number } | null; error: unknown }

  if (error) {
    console.error('[POST /api/automations/post-sale/events]', error)
    return NextResponse.json({ error: 'Erro ao registrar evento.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: inserted?.id })
}
