/**
 * Motor Fiscal Configurável — CRUD de `fiscal_operation_policies`.
 *
 * GET lista as políticas da empresa (uma linha por `operation_type`); PUT
 * atualiza UMA política por vez (o card da UI salva sozinho, sem depender
 * das outras 6). Admin-only — mesma régua RBAC já usada em todo o módulo
 * fiscal (`requireRole('admin')`, ver `api/fiscal/health/route.ts`,
 * `api/fiscal/empresa/route.ts`).
 *
 * Nunca cria linha nova por engano: PUT só faz UPDATE (a linha precisa
 * existir — vem do seed inicial da migration, ou de uma criação futura
 * dedicada pra novas empresas). Isso evita que um erro de digitação no
 * `operation_type` crie uma política "fantasma" nunca lida por
 * `resolveOperationType`.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireRole } from '@/lib/supabase/session'
import { auditLog } from '@/lib/audit/log'

export const dynamic = 'force-dynamic'

const OPERATION_TYPES = ['pos_retail', 'pos_pickup', 'pos_delivery', 'wholesale', 'website', 'whatsapp', 'manual'] as const

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Empresa não configurada.' }, { status: 403 })

  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('fiscal_operation_policies')
    .select('operation_type, fiscal_enabled, document_mode, auto_issue, auto_print, print_non_fiscal_receipt, manual_issue_allowed, updated_at')
    .eq('company_id', user.company_id)
    .order('operation_type')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policies: data ?? [] })
}

const putSchema = z.object({
  operation_type: z.enum(OPERATION_TYPES),
  fiscal_enabled: z.boolean(),
  document_mode: z.enum(['auto', 'nfce', 'nfe', 'none']),
  auto_issue: z.boolean(),
  auto_print: z.boolean(),
  print_non_fiscal_receipt: z.boolean(),
  manual_issue_allowed: z.boolean(),
})

export async function PUT(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Empresa não configurada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = createAdminClient()

  const { data: before } = await (admin as any)
    .from('fiscal_operation_policies')
    .select('fiscal_enabled, document_mode, auto_issue, auto_print, print_non_fiscal_receipt, manual_issue_allowed')
    .eq('company_id', user.company_id)
    .eq('operation_type', parsed.data.operation_type)
    .maybeSingle()

  const { data, error } = await (admin as any)
    .from('fiscal_operation_policies')
    .update({
      fiscal_enabled: parsed.data.fiscal_enabled,
      document_mode: parsed.data.document_mode,
      auto_issue: parsed.data.auto_issue,
      auto_print: parsed.data.auto_print,
      print_non_fiscal_receipt: parsed.data.print_non_fiscal_receipt,
      manual_issue_allowed: parsed.data.manual_issue_allowed,
      updated_by: user.id,
    })
    .eq('company_id', user.company_id)
    .eq('operation_type', parsed.data.operation_type)
    .select('operation_type, fiscal_enabled, document_mode, auto_issue, auto_print, print_non_fiscal_receipt, manual_issue_allowed, updated_at')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    // Nenhuma linha pra esta empresa+operação ainda — não cria por engano
    // aqui (evita política "fantasma" com nome de operação digitado errado).
    return NextResponse.json({ error: `Nenhuma política existente para "${parsed.data.operation_type}" nesta empresa.` }, { status: 404 })
  }

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'update', resource: 'fiscal_operation_policy',
    resourceId: parsed.data.operation_type,
    before, after: parsed.data,
  })

  return NextResponse.json({ policy: data })
}
