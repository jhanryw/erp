export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { validateAuthorizationToken } from '@/lib/auth/validateAuthorizationToken'
import { auditLog } from '@/lib/audit/log'
import { logError } from '@/lib/errors/log'
import { validateStockForSale, validateProductsActive, checkSalePrices, createSale, resolveAuthoritativeItemCosts, assertResponsibleSellerAllowed } from '@/services/vendas.service'
import { createAdminClient } from '@/lib/supabase/admin'
import { pushMultipleVariantStocksToNuvemshop } from '@/lib/services/nuvemshopSyncService'
import { sendPushNotification } from '@/lib/push/send'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateCPF } from '@/lib/utils/cpf'
import { validateCNPJ } from '@/lib/utils/cnpj'
import { resolveAutomaticFiscalEmission } from '@/lib/fiscal/resolveAutomaticFiscalEmission'
import { upsertSaleRecipient } from '@/services/fiscal/upsertSaleRecipient'
import { buildFiscalRecipientInput } from '@/services/fiscal/buildFiscalRecipientInput'
import { submitNfeHomologacao } from '@/services/fiscal/submitNfeHomologacao'
import { submitNfceHomologacao } from '@/services/fiscal/submitNfceHomologacao'

// ─── Webhook v2 (pós-venda N8N v2) ──────────────────────────────────────────
// Fire-and-forget, paralelo ao v1. Não altera webhook_log nem sendSaleWebhook.
async function sendSaleWebhookV2(
  admin: SupabaseClient,
  saleId: number,
  companyId: number,
): Promise<void> {
  const v2Url = process.env.N8N_WEBHOOK_URL_V2
  if (!v2Url) return

  // Idempotência via post_sale_automation_events
  const { data: existing } = await (admin as any)
    .from('post_sale_automation_events')
    .select('id')
    .eq('sale_id', saleId)
    .eq('event_type', 'webhook_received')
    .maybeSingle() as { data: { id: number } | null }

  if (existing) return

  const { data: customer } = await (admin as any)
    .from('sales')
    .select('customer_id, sale_date, customers:customer_id(phone, is_anonymous)')
    .eq('id', saleId)
    .maybeSingle() as { data: { customer_id: number; sale_date: string; customers: { phone: string | null; is_anonymous: boolean } | null } | null }

  const payload = {
    sale_id:        saleId,
    customer_phone: customer?.customers?.phone      ?? null,
    is_anonymous:   customer?.customers?.is_anonymous ?? true,
    sale_date:      customer?.sale_date             ?? null,
  }

  // Registra o evento independente do status HTTP do N8N
  await (admin as any)
    .from('post_sale_automation_events')
    .insert({
      sale_id: saleId,
      customer_id: customer?.customer_id ?? null,
      company_id:  companyId,
      event_type:  'webhook_received',
    })
    .throwOnError()
    .catch((err: unknown) => console.error('[sendSaleWebhookV2] Erro ao inserir evento:', err))

  fetch(v2Url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch((err) => console.error('[sendSaleWebhookV2] Erro ao disparar webhook:', err))
}

// ─── Push notification — nova venda para admins ───────────────────────────────
async function sendNewSalePushNotification(
  admin: SupabaseClient,
  saleId: number,
  total: number,
  sellerId: number | null | undefined,
  companyId: number,
): Promise<void> {
  // Busca nome do vendedor responsável
  let sellerName = 'vendedor(a)'
  if (sellerId) {
    const { data: seller } = await (admin as any)
      .from('sellers')
      .select('name')
      .eq('id', sellerId)
      .maybeSingle() as { data: { name: string } | null }
    if (seller?.name) sellerName = seller.name
  }

  const formatted = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  await sendPushNotification({
    companyId,
    roles:  ['admin'],
    title:  'Nova venda na Santtorini',
    body:   `Venda de ${formatted} realizada por ${sellerName}`,
    url:    `/vendas/${saleId}`,
  })
}

// ─── Webhook v1 (legado) ─────────────────────────────────────────────────────
async function sendSaleWebhook(
  admin: SupabaseClient,
  saleId: number,
  customerId: number,
  companyId: number,
  webhookUrl: string,
): Promise<void> {
  const { data: existing } = await admin
    .from('webhook_log')
    .select('id')
    .eq('sale_id', saleId)
    .eq('event_type', 'sale_confirmed')
    .eq('status', 'sent')
    .maybeSingle()

  if (existing) return

  const [{ data: saleRow }, { data: customer }] = await Promise.all([
    admin.from('sales').select('id, total, sale_date').eq('id', saleId).single(),
    (admin as any).from('customers').select('name, phone, is_anonymous').eq('id', customerId).single() as Promise<{ data: { name: string; phone: string; is_anonymous: boolean } | null }>,
  ])

  const payload = {
    sale_id:        saleId,
    customer_name:  customer?.name ?? null,
    customer_phone: customer?.phone ?? null,
    total:          saleRow?.total ?? null,
    sale_date:      saleRow?.sale_date ?? null,
    is_anonymous:   (customer as any)?.is_anonymous ?? false,
  }

  let status: 'sent' | 'failed' = 'failed'
  let httpStatus: number | null = null
  let errorMessage: string | null = null

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    httpStatus = res.status
    status = res.ok ? 'sent' : 'failed'
    if (!res.ok) errorMessage = `HTTP ${res.status}`
  } catch (err) {
    errorMessage = String(err)
  }

  await admin.from('webhook_log').insert({
    event_type:    'sale_confirmed',
    sale_id:       saleId,
    company_id:    companyId,
    payload,
    webhook_url:   webhookUrl,
    status,
    http_status:   httpStatus,
    error_message: errorMessage,
  })
}

const itemSchema = z.object({
  product_variation_id: z.number().int().positive(),
  quantity:             z.number().int().positive(),
  unit_price:           z.number().positive(),
  unit_cost:            z.number().min(0),
  discount_amount:      z.number().min(0).default(0),
  // Fase Fiscal 5C — acréscimo individual do item, simétrico a discount_amount.
  surcharge_amount:     z.number().min(0).default(0),
  // Preço de tabela no momento da venda — informativo, nunca usado em cálculo.
  list_price_snapshot:  z.number().min(0).nullable().optional(),
})

const deliveryRecipientSchema = z.object({
  nome:       z.string().min(2),
  cpf:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cnpj:       z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  telefone:   z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cep:        z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  logradouro: z.string().min(1),
  numero:     z.string().min(1),
  complemento: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  bairro:     z.string().min(1),
  municipio:  z.string().min(1),
  uf:         z.string().length(2),
  municipio_ibge: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().regex(/^\d{7}$/).nullable().optional()),
  ibge_source: z.preprocess((v) => (v === '' || v == null ? null : v), z.enum(['viacep', 'resolve_municipio_ibge']).nullable().optional()),
  customer_address_id: z.preprocess((v) => (v === '' || v == null ? null : v), z.number().int().positive().nullable().optional()),
  save_as_customer_address: z.boolean().default(false),
})

// ─── Destinatário fiscal (Fase Fiscal 6) ────────────────────────────────────
// Diferente de `deliveryRecipientSchema`: TUDO opcional. Um destinatário
// fiscal pode ser só um CPF (NFC-e de balcão, sem endereço nenhum) ou um
// bloco PJ completo (NF-e). Quem decide o que é OBRIGATÓRIO pra emitir de
// verdade é `validateNfeReadiness`/`validateNfceReadiness` (na tentativa de
// emissão, depois da venda já criada) — nunca este schema, e nunca esta
// rota bloqueia a CRIAÇÃO da venda por causa de dado fiscal incompleto
// (seção 16 do pedido: "a venda já pode ter sido concluída... emissão fica
// pendente").
const fiscalRecipientSchema = z.object({
  nome:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cpf:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cnpj:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  inscricao_estadual: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  indicador_ie:       z.preprocess((v) => (v === '' || v == null ? null : v), z.union([z.literal(1), z.literal(2), z.literal(9)]).nullable().optional()),
  telefone:           z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cep:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  logradouro:         z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  numero:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  complemento:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  bairro:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  municipio:          z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  uf:                 z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  municipio_ibge:     z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  ibge_source:        z.preprocess((v) => (v === '' || v == null ? null : v), z.enum(['viacep', 'resolve_municipio_ibge', 'manual_confirmado']).nullable().optional()),
})

const paymentEntrySchema = z.object({
  method:          z.enum(['pix', 'cash', 'credit_card', 'debit_card']),
  amount_tendered: z.number().positive(),
  change_amount:   z.number().min(0).default(0),
  change_method:   z.enum(['cash', 'pix']).optional(),
  net_amount:      z.number().positive(),
  installments:    z.number().int().min(1).max(12).default(1),
  card_brand:      z.string().optional(),
  acquirer:        z.string().optional(),
  metadata:        z.record(z.unknown()).default({}),
})

const schema = z.object({
  customer_id:             z.number().int().positive(),
  responsible_seller_id:   z.number().int().positive({ message: 'Vendedor responsável obrigatório.' }),
  // Legado (campo único) — pode estar presente mesmo no novo fluxo como método dominante derivado
  payment_method:          z.enum(['pix', 'card', 'cash', 'credit_card', 'debit_card']).optional(),
  // Novo fluxo multi-pagamento ([] = total zerado por cashback, sem pagamento em dinheiro)
  payments:                z.array(paymentEntrySchema).optional(),
  delivery_mode:           z.enum(['pickup', 'delivery']).default('delivery'),
  sale_origin:             z.preprocess((v) => (v === '' || v == null ? undefined : v), z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other'], { required_error: 'Origem obrigatória' })),
  // Fundação varejo/atacado (2026-08-31) — modalidade COMERCIAL da venda,
  // distinta de sale_origin (canal de marketing). Escolhida explicitamente
  // no PDV (Passo 0, antes de buscar produtos) — Zod aqui é a segunda
  // camada de defesa (a RPC também rejeita qualquer valor fora de
  // retail/wholesale): backend nunca confia só no que o navegador validou.
  sale_type:               z.enum(['retail', 'wholesale']).default('retail'),
  // PDV atacado/varejo (2026-09-02) — sales_channel NUNCA vem do cliente
  // nesta rota. Esta API só tem um chamador (o PDV, confirmado por
  // auditoria — grep de "fetch('/api/vendas'" em todo src/), então o canal
  // é sempre 'pos', fixado no servidor logo abaixo (mesmo padrão do
  // webhook Nuvemshop, que fixa 'nuvemshop' sem nunca ler o payload
  // externo). Removido do schema de propósito: um campo que não existe não
  // pode ser manipulado pelo frontend, nem por engano.
  // 'use' → aplica saldo existente, não gera novo cashback
  // 'accumulate' → não usa saldo, gera cashback normalmente
  cashback_action:         z.enum(['use', 'accumulate']).default('accumulate'),
  discount_amount:         z.number().min(0).default(0),
  surcharge_amount:        z.number().min(0).default(0),
  cashback_used:           z.number().min(0).default(0),
  shipping_charged:        z.number().min(0).default(0),
  notes:                   z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  items:                   z.array(itemSchema).min(1),
  cash_session_id:                  z.number().int().positive().nullable().optional(),
  discount_authorization_token_id:  z.string().uuid().optional(),
  // Fase Fiscal 5C — obrigatório quando delivery_mode === 'delivery' (ver refine abaixo).
  delivery_recipient: deliveryRecipientSchema.nullable().optional(),
  // Fase Fiscal 7 — 'auto' (novo default) deixa a decisão automática pra
  // `resolveAutomaticFiscalEmission` (venda comum do ERP não pode mais
  // depender do vendedor lembrar de clicar em "Emitir NFC-e" — seção 4 do
  // pedido). 'none'/'nfce'/'nfe' continuam existindo como OVERRIDE
  // explícito do operador. Nunca confundir com `sales_channel`: aqui é o
  // DOCUMENTO fiscal pretendido, não o canal da venda.
  fiscal_document_type: z.enum(['auto', 'none', 'nfce', 'nfe']).default('auto'),
  fiscal_recipient:     fiscalRecipientSchema.nullable().optional(),
}).refine(
  (d) => d.payments != null || d.payment_method != null,
  { message: 'Informe payment_method ou payments[].' }
).refine(
  (d) => d.delivery_mode !== 'delivery' || d.delivery_recipient != null,
  { message: 'Endereço de entrega obrigatório para venda com entrega.', path: ['delivery_recipient'] }
)

export async function POST(request: Request) {
  try {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth

  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  try {
    // Regra 0: responsible_seller_id precisa existir, estar ativo e
    // pertencer à mesma empresa do usuário autenticado — vale para
    // qualquer role (usuario/gerente/admin). Não é uma checagem de
    // identidade de quem está operando (isso vem de user.id/requireRole).
    const sellerCheck = await assertResponsibleSellerAllowed(
      parsed.data.responsible_seller_id, user.company_id
    )
    if (!sellerCheck.ok) return NextResponse.json({ error: sellerCheck.error }, { status: sellerCheck.status })

    // Regra 1: produtos/variações devem estar ativos (hard block para qualquer role)
    const activeCheck = await validateProductsActive(parsed.data.items, user.company_id)
    if (!activeCheck.ok) return NextResponse.json({ error: activeCheck.error }, { status: activeCheck.status })

    // Regra 2: validar estoque disponível
    const stockCheck = await validateStockForSale(parsed.data.items, user.company_id)
    if (!stockCheck.ok) return NextResponse.json({ error: stockCheck.error }, { status: stockCheck.status })

    // Resolver custo REAL de cada item no servidor — nunca confiar no
    // unit_cost do payload (ver comentário em resolveAuthoritativeItemCosts).
    const costResult = await resolveAuthoritativeItemCosts(parsed.data.items, user.company_id)
    if (!costResult.ok) return NextResponse.json({ error: costResult.error }, { status: costResult.status })
    parsed.data.items = costResult.data

    // Regra 3: preço abaixo do custo — bloqueia usuario, avisa gerente/admin
    const priceCheck = checkSalePrices(parsed.data.items)
    if (priceCheck.warnings.length > 0 && user.role === 'usuario') {
      return NextResponse.json(
        { error: `Venda com margem negativa requer aprovação de gerente. ${priceCheck.warnings[0]}` },
        { status: 403 }
      )
    }

    const discountAuditFields: {
      authorized_by?: string
      authorization_token_id?: string
      authorization_action?: string
      discount_percent?: number
      discount_amount_audit?: number
    } = {}

    // Se um token de autorização de desconto foi enviado no payload, ele
    // precisa ser validado de verdade — antes, o campo era aceito e
    // simplesmente ignorado (nunca chamava validateAuthorizationToken),
    // ao contrário de cancelamento/devolução/troca, que sempre validam.
    // Não existe hoje um limiar de desconto que TORNE o token obrigatório
    // (nenhuma UI/config define isso — ver relatório de entrega); esta
    // checagem fecha a lacuna de "campo sensível aceito sem validação" sem
    // inventar uma regra de negócio nova.
    if (parsed.data.discount_authorization_token_id) {
      const tokenResult = await validateAuthorizationToken({
        tokenId:     parsed.data.discount_authorization_token_id,
        action:      'apply_discount',
        requestedBy: user.id,
        companyId:   user.company_id,
      })
      if (!tokenResult.ok) {
        return NextResponse.json(
          { error: tokenResult.error ?? 'Token de autorização de desconto inválido.' },
          { status: 403 }
        )
      }
      discountAuditFields.authorized_by = tokenResult.authorizedBy
      discountAuditFields.authorization_token_id = parsed.data.discount_authorization_token_id
      discountAuditFields.authorization_action = 'apply_discount'
      if (tokenResult.authorizedDiscountPct != null) {
        discountAuditFields.discount_percent = tokenResult.authorizedDiscountPct
      }
      if (tokenResult.authorizedDiscountAmount != null) {
        discountAuditFields.discount_amount_audit = tokenResult.authorizedDiscountAmount
      }
    }

    // Fase Fiscal 6 — CPF/CNPJ do destinatário fiscal, validados por
    // dígito verificador ANTES de persistir (nunca confia no formato só
    // porque o cliente mandou algo parecido). Dado inválido é DESCARTADO
    // (não bloqueia a venda — seção 16 do pedido) e vira um warning na
    // resposta, mesmo padrão já usado por `priceCheck.warnings` abaixo.
    const fiscalRecipientWarnings: string[] = []
    if (parsed.data.fiscal_recipient) {
      const fr = parsed.data.fiscal_recipient
      if (fr.cpf && !validateCPF(fr.cpf)) {
        fiscalRecipientWarnings.push('CPF do destinatário fiscal com dígito verificador inválido — não foi salvo.')
        fr.cpf = null
      }
      if (fr.cnpj && !validateCNPJ(fr.cnpj)) {
        fiscalRecipientWarnings.push('CNPJ do destinatário fiscal com dígito verificador inválido — não foi salvo.')
        fr.cnpj = null
      }
    }

    // Derivar payment_method do método dominante (maior net_amount) quando payments[] fornecido
    let effectivePaymentMethod = parsed.data.payment_method ?? 'pix'
    if (parsed.data.payments && parsed.data.payments.length > 0) {
      const dominant = parsed.data.payments.reduce((a, b) => b.net_amount > a.net_amount ? b : a)
      effectivePaymentMethod = dominant.method
    }

    // Garantir coerência: se cashback_action === 'use', cashback_used pode ser > 0;
    // se 'accumulate', forçar cashback_used = 0 independente do que foi enviado.
    const saleData = {
      ...parsed.data,
      payment_method:  effectivePaymentMethod as 'pix' | 'card' | 'cash' | 'credit_card' | 'debit_card',
      cashback_used:   parsed.data.cashback_action === 'accumulate' ? 0 : parsed.data.cashback_used,
    }

    // Criar venda via service (sale + itens + estoque + finance + snapshot
    // de destinatário, tudo na mesma transação — Fase Fiscal 5C, Blocker 1)
    const result = await createSale({
      ...saleData,
      systemUserId:          user.id,
      cashSessionId:         parsed.data.cash_session_id ?? null,
      responsible_seller_id: parsed.data.responsible_seller_id,
      deliveryRecipient:     parsed.data.delivery_mode === 'delivery' ? (parsed.data.delivery_recipient ?? null) : null,
      // PDV atacado/varejo (2026-09-02) — canal fixo do PDV, nunca lido do
      // payload (o campo nem existe no schema Zod acima).
      sales_channel:          'pos',
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

    const sale = result.data
    auditLog({
      userId: user.id, userRole: user.role,
      action: 'create', resource: 'sale',
      resourceId: sale.id, detail: sale.sale_number,
      ...discountAuditFields,
    })

    // Sincronizar estoque para Nuvemshop (não-fatal, fire-and-forget)
    const soldVariationIds = saleData.items.map((i) => i.product_variation_id)
    pushMultipleVariantStocksToNuvemshop(soldVariationIds, { eventType: 'stock_push_erp' }).catch(
      (err) => console.error('[POST /api/vendas] Erro na sincronização Nuvemshop', err)
    )

    const admin = createAdminClient()

    // Webhook n8n pós-venda — pula para clientes avulsos (is_anonymous = true)
    const n8nUrl = process.env.N8N_WEBHOOK_URL
    if (n8nUrl) {
      const { data: custRow } = await (admin as any)
        .from('customers')
        .select('is_anonymous')
        .eq('id', saleData.customer_id)
        .maybeSingle() as { data: { is_anonymous: boolean } | null }
      if (!custRow?.is_anonymous) {
        sendSaleWebhook(admin, sale.id, saleData.customer_id, user.company_id, n8nUrl).catch(
          (err) => console.error('[POST /api/vendas] Webhook n8n error', err)
        )
      }
    }

    // Webhook n8n pós-venda v2 (paralelo ao v1, fire-and-forget)
    sendSaleWebhookV2(admin, sale.id, user.company_id).catch(
      (err) => console.error('[POST /api/vendas] Webhook n8n v2 error', err)
    )

    // Push notification para admins da empresa (fire-and-forget — não bloqueia resposta)
    sendNewSalePushNotification(
      admin,
      sale.id,
      Number((sale as any).total ?? 0),
      saleData.responsible_seller_id ?? null,
      user.company_id,
    ).catch((err) => console.error('[POST /api/vendas] Push notification error', err))

    // Criar envio automaticamente após a venda. Nota (Fase Fiscal 5C):
    // ainda não-atômico em relação à venda — diferente do snapshot de
    // destinatário (sale_recipients), que agora é gravado dentro da mesma
    // transação do rpc_create_sale (ver createSale/deliveryRecipient
    // acima). shipments continua com o mesmo padrão pré-existente
    // ("erro no shipment é não-fatal"); permanece um débito conhecido,
    // fora do escopo deste blocker (que era especificamente sobre o
    // snapshot fiscal do destinatário).
    const { delivery_mode } = saleData
    const shipmentStatus = delivery_mode === 'pickup' ? 'aguardando_retirada' : 'aguardando_confirmacao'
    await (admin as any)
      .from('shipments')
      .insert({
        order_id:      sale.id,
        customer_id:   saleData.customer_id,
        delivery_mode,
        status:        shipmentStatus,
        notes:         saleData.notes ?? null,
        company_id:    user.company_id,
      })
    // Erro no shipment é não-fatal: a venda já foi criada

    // ─── Fase Fiscal 7 — emissão automática a partir do fechamento do PDV ──
    // SEMPRE depois da venda/pagamento/estoque já persistidos (seção 17 do
    // pedido, passos 1-5 em ordem) — nada aqui pode fazer a venda falhar.
    // Decisão de negócio (2026-08-27): venda comum do ERP/PDV não pode mais
    // depender do vendedor lembrar de clicar em "Emitir NFC-e" (seção 4 do
    // pedido) — `resolveAutomaticFiscalEmission` decide automaticamente
    // (default `fiscal_document_type: 'auto'`), já embutindo a exceção
    // legal de atacado (NFC-e nunca é emitida automaticamente pra
    // sale_type='wholesale' — ver comentário no próprio arquivo).
    // 'none'/'nfce'/'nfe' continuam disponíveis como override explícito.
    let fiscalResult: {
      requested: 'nfce' | 'nfe'
      status: string
      reason: string | null
      fiscal_document_id: number | null
      validation_errors: { code: string; message: string }[]
    } | null = null

    const fiscalDecision = resolveAutomaticFiscalEmission({
      deliveryMode: saleData.delivery_mode,
      saleOrigin: saleData.sale_origin,
      saleType: saleData.sale_type,
      operatorChoice: parsed.data.fiscal_document_type,
    })

    if (fiscalDecision.attempt) {
      const requested = fiscalDecision.attempt
      try {
        const recipientInput = buildFiscalRecipientInput(parsed.data.fiscal_recipient, parsed.data.delivery_recipient)
        if (recipientInput) {
          const recipientResult = await upsertSaleRecipient(sale.id, user.company_id, recipientInput)
          if (!recipientResult.ok) {
            logError({ route: 'POST /api/vendas (fiscal recipient)', err: new Error(recipientResult.error), context: { sale_id: sale.id } })
          }
        }

        // NF-e não tem gate de elegibilidade prévio — mesmo comportamento
        // da rota manual (`/api/fiscal/nfe/emitir-homologacao`), que sempre
        // tenta e deixa `validateNfeReadiness` reportar o que faltar (ex.:
        // destinatário incompleto — completável depois na tela da venda,
        // seção 19 do pedido). NFC-e só chega aqui já elegível — o gate
        // roda dentro de `resolveAutomaticFiscalEmission`.
        const emission = requested === 'nfce'
          ? await submitNfceHomologacao(sale.id, user.company_id)
          : await submitNfeHomologacao(sale.id, user.company_id)
        fiscalResult = emission.ok
          ? { requested, status: emission.data.status, reason: null, fiscal_document_id: emission.data.fiscalDocumentId, validation_errors: emission.data.validationErrors }
          : { requested, status: 'error', reason: emission.error, fiscal_document_id: null, validation_errors: [] }
      } catch (fiscalErr) {
        // Nunca deixa uma falha fiscal inesperada derrubar a resposta da
        // venda — ela já foi criada com sucesso. Fica pendente, o
        // operador tenta de novo na tela da venda.
        logError({ route: 'POST /api/vendas (fiscal emission)', err: fiscalErr, context: { sale_id: sale.id, requested } })
        fiscalResult = { requested, status: 'error', reason: 'Erro inesperado ao tentar emitir — tente novamente na tela da venda.', fiscal_document_id: null, validation_errors: [] }
      }
    } else if (fiscalDecision.skipReason) {
      // Só reporta quando havia intenção real de emitir algo (auto ou
      // override) e ela foi barrada — nunca quando o operador pediu
      // 'none' de propósito (nesse caso fiscalDecision.skipReason é null).
      fiscalResult = {
        requested: 'nfce', status: 'not_eligible', reason: fiscalDecision.skipReason,
        fiscal_document_id: null, validation_errors: [],
      }
    }

    return NextResponse.json({
      sale,
      ...(priceCheck.warnings.length > 0 || fiscalRecipientWarnings.length > 0
        ? { warnings: [...priceCheck.warnings, ...fiscalRecipientWarnings] }
        : {}),
      ...(fiscalResult ? { fiscal: fiscalResult } : {}),
    })
  } catch (err) {
    logError({
      route: 'POST /api/vendas',
      err,
      context: {
        user_id:     user.id,
        company_id:  user.company_id,
        items_count: parsed.data.items.length,
        customer_id: parsed.data.customer_id,
      },
    })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
  } catch (err) {
    logError({ route: 'POST /api/vendas', err, context: {} })
    return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
  }
}
