/**
 * FASE N1 — primeiro contrato novo Qarvon → n8n: lookup de customer por
 * telefone. Só leitura — nunca cria/edita customer (seção 1/regras finais
 * do pedido).
 *
 * `GET /api/automations/customers/lookup?phone=<telefone em qualquer
 * formato>` — autenticado por `QARVON_AUTOMATION_SECRET`
 * (`requireAutomationSecret`, Fase N0), tenant resolvido só server-side
 * (`resolveAutomationCompanyId`, Fase N1 — nunca de query/body).
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeE164BR } from '@/lib/utils/phone'
import { requireAutomationSecret, resolveAutomationCompanyId } from '@/lib/auth/requireAutomationSecret'
import { classifyLookupMatches, type LookupNotFoundReason } from './classifyLookupMatches'

// Mascara pra log — nunca o telefone completo (seção 14 do pedido). Mostra
// só os 2 últimos dígitos, o bastante pra correlacionar um ticket de
// suporte sem expor o número.
function maskPhoneForLog(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length <= 2) return '**'
  return `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`
}

export async function GET(request: Request) {
  const start = Date.now()

  if (!requireAutomationSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenant = resolveAutomationCompanyId()
  if (!tenant.ok) {
    console.error('[automations/customers/lookup] tenant não configurado', { reason: tenant.reason })
    return NextResponse.json({ error: 'Configuração do servidor incompleta.' }, { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const rawPhone = searchParams.get('phone')
  if (!rawPhone || !rawPhone.trim()) {
    return NextResponse.json({ error: 'Parâmetro "phone" é obrigatório.' }, { status: 422 })
  }

  // Reaproveita o normalizador canônico da Fase 1 — nunca um paralelo aqui
  // (seção 4 do pedido). '' = não normalizável com segurança.
  const phoneE164 = normalizeE164BR(rawPhone)

  const logResult = (found: boolean, reason?: LookupNotFoundReason) => {
    console.log('[automations/customers/lookup]', {
      company_id: tenant.companyId,
      phone_masked: maskPhoneForLog(rawPhone),
      found,
      reason: reason ?? null,
      latency_ms: Date.now() - start,
    })
  }

  if (!phoneE164) {
    logResult(false, 'invalid_phone')
    return NextResponse.json({ found: false, reason: 'invalid_phone' satisfies LookupNotFoundReason }, { status: 200 })
  }

  const admin = createAdminClient()
  // is_anonymous=false sempre — cliente avulso nunca é match de telefone
  // real (seção 8 do pedido). company_id sempre do tenant resolvido
  // server-side, nunca do request (seção 13).
  const { data, error } = await (admin as any)
    .from('customers')
    .select('id, name, phone_e164')
    .eq('company_id', tenant.companyId)
    .eq('phone_e164', phoneE164)
    .eq('is_anonymous', false) as { data: { id: number; name: string; phone_e164: string }[] | null; error: { message: string } | null }

  if (error) {
    console.error('[automations/customers/lookup] erro de consulta', { company_id: tenant.companyId, error: error.message })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  // Duplicidade real conhecida na base (seção 7 do pedido) — classifyLookupMatches
  // nunca escolhe um customer arbitrariamente entre duplicados, nunca
  // devolve a lista pro n8n.
  const result = classifyLookupMatches(data ?? [])
  logResult(result.found, result.found ? undefined : result.reason)
  return NextResponse.json(result, { status: 200 })
}
