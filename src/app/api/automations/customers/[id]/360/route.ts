/**
 * FASE N1 — Customer 360 pra automação n8n. Só leitura (regras finais do
 * pedido: não criar/editar customer, não criar vínculo Chatwoot nesta
 * consulta).
 *
 * `GET /api/automations/customers/:id/360` — mesma autenticação/tenant da
 * rota de lookup (seção 2/3 do pedido).
 *
 * Contrato de erro DIFERENTE do lookup, de propósito (documentado —
 * seção 6/21.C-D do pedido): o lookup é uma BUSCA (múltiplos desfechos
 * válidos, todos 200) — este endpoint é um RECURSO (`/customers/:id/360`),
 * então segue a mesma convenção REST já usada no resto do projeto pra
 * "recurso não existe" (ex.: `/api/clientes/[id]` → 404), não um envelope
 * `found:false`.
 */

export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAutomationSecret, resolveAutomationCompanyId } from '@/lib/auth/requireAutomationSecret'
import { computeCustomerCommercialAttributes } from '@/lib/integrations/chatwoot/reconciliation'
import { resolveChatwootLink } from './resolveChatwootLink'

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const start = Date.now()

  if (!requireAutomationSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tenant = resolveAutomationCompanyId()
  if (!tenant.ok) {
    console.error('[automations/customers/360] tenant não configurado', { reason: tenant.reason })
    return NextResponse.json({ error: 'Configuração do servidor incompleta.' }, { status: 500 })
  }

  const customerId = Number(params.id)
  if (!Number.isFinite(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'ID inválido.' }, { status: 422 })
  }

  const admin = createAdminClient()

  // company_id sempre do tenant resolvido server-side (seção 13 do pedido)
  // — um customer_id de outra empresa nunca é encontrado por esta query,
  // mesmo que o n8n "adivinhe" um ID real de outro tenant. is_anonymous
  // excluído (mesma política do lookup — cliente avulso não tem "360"
  // individual que faça sentido reportar).
  const { data: customer, error: customerError } = await (admin as any)
    .from('customers')
    .select('id, name, phone_e164, is_anonymous')
    .eq('id', customerId)
    .eq('company_id', tenant.companyId)
    .maybeSingle() as { data: { id: number; name: string; phone_e164: string | null; is_anonymous: boolean } | null; error: { message: string } | null }

  if (customerError) {
    console.error('[automations/customers/360] erro de consulta', { company_id: tenant.companyId, customer_id: customerId, error: customerError.message })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  if (!customer || customer.is_anonymous) {
    console.log('[automations/customers/360]', { company_id: tenant.companyId, customer_id: customerId, found: false, latency_ms: Date.now() - start })
    return NextResponse.json({ error: 'Cliente não encontrado.' }, { status: 404 })
  }

  // Reaproveita o MESMO cálculo já usado pra sincronizar com o Chatwoot
  // (Fase 4) — nunca duplica total_orders/total_spent/average_ticket/
  // last_purchase_at/customer_segment (seção 9 do pedido).
  const attrsResult = await computeCustomerCommercialAttributes(customerId, tenant.companyId)
  if (!attrsResult.ok) {
    console.error('[automations/customers/360] erro ao calcular atributos', { company_id: tenant.companyId, customer_id: customerId, error: attrsResult.error })
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }

  const chatwoot = await resolveChatwootLink(tenant.companyId, customerId)

  console.log('[automations/customers/360]', {
    company_id: tenant.companyId,
    customer_id: customerId,
    found: true,
    chatwoot_linked: chatwoot.linked,
    latency_ms: Date.now() - start,
  })

  // Nunca CPF/endereço/margem/custo/dado financeiro interno/secrets (seção
  // 11 do pedido) — só o que o service de comércio já expõe + nome +
  // telefone canônico + estado do vínculo Chatwoot.
  return NextResponse.json({
    customer_id: customer.id,
    name: customer.name,
    phone_e164: customer.phone_e164,
    total_orders: attrsResult.data.totalOrders,
    total_spent: attrsResult.data.totalSpent,
    average_ticket: attrsResult.data.averageTicket,
    first_purchase_at: attrsResult.data.firstPurchaseAt,
    last_purchase_at: attrsResult.data.lastPurchaseAt,
    customer_segment: attrsResult.data.customerSegment,
    chatwoot,
  })
}
