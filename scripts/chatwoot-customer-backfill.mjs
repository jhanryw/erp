#!/usr/bin/env node
/**
 * FASE MVP CHATWOOT — Backfill de customers do ERP para contatos Chatwoot.
 *
 * Objetivo (seção 5 do pedido): para cada customer real (não-anônimo, com
 * telefone canônico) já cadastrado no ERP, garantir que existe um contato
 * Chatwoot correspondente, vinculado via a MESMA cadeia de identidade
 * canônica já usada no resto do sistema (customer → crm_person →
 * external_entity_link → contato Chatwoot — Fases 1-4/N2B), com os
 * atributos comerciais (`qarvon_*`) já preenchidos.
 *
 * DRY-RUN POR PADRÃO — sem `--execute`, nenhuma escrita acontece no banco
 * nem no Chatwoot; só imprime o que faria. `--execute` roda de verdade.
 *
 * Nunca sincroniza `is_anonymous=true`. Nunca duplica contato (busca por
 * telefone exato antes de criar) nem vínculo (`external_entity_links`,
 * `crm_person_customer_links` — idempotente via unique index, roda de novo
 * sem duplicar nada). Nunca escolhe pessoa/contato ambíguo automaticamente
 * — casos assim são pulados e reportados, nunca decididos sozinhos.
 *
 * Uso:
 *   node scripts/chatwoot-customer-backfill.mjs --company-id <id>
 *     → dry-run: relatório completo, nenhuma escrita.
 *
 *   node scripts/chatwoot-customer-backfill.mjs --company-id <id> --execute
 *     → roda de verdade (cria crm_person/vínculos/contatos Chatwoot/
 *       external_entity_links, atualiza custom_attributes).
 *
 *   [--limit <n>]     → processa no máximo N customers nesta execução
 *                        (recomendado na primeira --execute real).
 *   [--inbox-id <id>] → inbox Chatwoot usada como âncora pra CRIAR contatos
 *                        novos (a API do Chatwoot exige inbox_id em POST
 *                        /contacts). Não é onde o cliente vai necessariamente
 *                        conversar — quando uma mensagem real chegar em
 *                        QUALQUER inbox, o próprio Chatwoot associa o
 *                        contato existente pelo telefone (matching nativo
 *                        dele, independente deste script). Sem esta flag,
 *                        usa `company_integrations.settings.inbox_id`
 *                        (Fase N2B) e, se ausente, o primeiro item de
 *                        `settings.inboxes[]` (Fase MVP Chatwoot).
 *
 * IMPORTANTE — duplicação deliberada de lógica: sem tsx/ts-node neste
 * projeto (mesma dívida técnica já documentada em
 * customer-identity-audit.mjs e chatwoot-integration-setup.mjs), a leitura
 * de secret (`secretCipher.ts`), a chamada HTTP ao Chatwoot (`client.ts`) e
 * o cálculo de atributos comerciais (`computeCustomerCommercialAttributes`/
 * `buildQarvonCustomAttributesPayload`, `reconciliation.ts`) são cópias
 * deliberadas em JS puro. QUALQUER mudança nos originais TS precisa ser
 * replicada aqui.
 *
 * Nunca imprime telefone completo — só contagens, IDs internos e os 2
 * últimos dígitos do telefone quando necessário pra rastrear um caso
 * específico no relatório.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDecipheriv } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ─── Carrega .env.local/.env manualmente (sem dependência de dotenv) ──────────
function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(ROOT, '.env.local'))
loadEnvFile(join(ROOT, '.env'))

// ─── Args ───────────────────────────────────────────────────────────────────
function arg(name) {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 ? process.argv[idx + 1] : undefined
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

const companyIdArg = arg('company-id')
const doExecute = flag('execute')
const limitArg = arg('limit')
const inboxIdOverrideArg = arg('inbox-id')

if (!companyIdArg) {
  console.error('Uso: node scripts/chatwoot-customer-backfill.mjs --company-id <id> [--execute] [--limit <n>] [--inbox-id <id>]')
  process.exit(1)
}
const companyId = Number(companyIdArg)
if (!Number.isFinite(companyId) || companyId <= 0) {
  console.error(`--company-id inválido: "${companyIdArg}".`)
  process.exit(1)
}
const limit = limitArg ? Number(limitArg) : Infinity
if (limitArg && (!Number.isFinite(limit) || limit <= 0)) {
  console.error(`--limit inválido: "${limitArg}".`)
  process.exit(1)
}

console.log(doExecute ? '=== MODO EXECUÇÃO REAL — escreve no banco e no Chatwoot ===' : '=== DRY-RUN — nenhuma escrita, só relatório (use --execute pra rodar de verdade) ===')
console.log(`company_id=${companyId}${limitArg ? `, limit=${limit}` : ''}\n`)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios (.env.local ou .env).')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

// ─── Cópia deliberada de src/lib/security/secretCipher.ts (decrypt only) ──────
function decryptSecret(ciphertextB64, keyVersion) {
  const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
  if (!rawKey) throw new Error(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} ausente — configure antes de rodar (ver .env.example).`)
  const key = Buffer.from(rawKey, 'base64')
  const packed = Buffer.from(ciphertextB64, 'base64')
  const iv = packed.subarray(0, 12)
  const authTag = packed.subarray(12, 28)
  const data = packed.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// ─── Cópia deliberada de src/lib/integrations/chatwoot/client.ts ──────────────
async function chatwootFetch(config, path, init = {}) {
  const url = `${config.baseUrl.replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(config.accountId)}${path}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', api_access_token: config.apiToken },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* corpo não-JSON */ }
    if (!response.ok) throw new Error(`Chatwoot respondeu ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

// Cópia deliberada de src/lib/integrations/chatwoot/customAttributes.ts
const QARVON_CUSTOM_ATTRIBUTES = [
  { key: 'qarvon_customer_id', name: 'Qarvon — ID do Cliente', type: 0, description: 'ID do cliente no ERP Qarvon (customers.id).' },
  { key: 'qarvon_total_orders', name: 'Qarvon — Total de Pedidos', type: 1, description: 'Quantidade de pedidos válidos (exclui cancelados/devolvidos).' },
  { key: 'qarvon_total_spent', name: 'Qarvon — Total Gasto', type: 2, description: 'Soma do valor de pedidos válidos, em BRL.' },
  { key: 'qarvon_average_ticket', name: 'Qarvon — Ticket Médio', type: 2, description: 'total_spent / total_orders, em BRL.' },
  { key: 'qarvon_first_purchase_at', name: 'Qarvon — Primeira Compra', type: 5, description: 'Data da primeira venda válida.' },
  { key: 'qarvon_last_purchase_at', name: 'Qarvon — Última Compra', type: 5, description: 'Data da venda válida mais recente.' },
  { key: 'qarvon_customer_segment', name: 'Qarvon — Segmento (RFM)', type: 0, description: 'Segmento RFM calculado — pode ficar até 1 refresh desatualizado.' },
  { key: 'qarvon_cashback_available', name: 'Qarvon — Cashback Disponível', type: 2, description: 'Saldo de cashback disponível pra uso, em BRL.' },
  { key: 'qarvon_erp_link', name: 'Qarvon — Ver no ERP', type: 4, description: 'Link direto pro histórico completo de compras do cliente no Qarvon.' },
]

async function ensureCustomAttributeDefinitions(config) {
  const existing = await chatwootFetch(config, '/custom_attribute_definitions')
  const existingKeys = new Set((existing ?? []).map((a) => a.attribute_key))
  for (const attr of QARVON_CUSTOM_ATTRIBUTES) {
    if (existingKeys.has(attr.key)) continue
    await chatwootFetch(config, '/custom_attribute_definitions', {
      method: 'POST',
      body: { attribute_key: attr.key, attribute_display_name: attr.name, attribute_display_type: attr.type, attribute_description: attr.description, attribute_model: 1 },
    })
  }
}

// Cópia deliberada de computeCustomerCommercialAttributes (reconciliation.ts)
async function computeCommercialAttributes(customerId) {
  const { data: sales, error: salesError } = await supabase
    .from('sales')
    .select('total, sale_date, status')
    .eq('customer_id', customerId)
    .eq('company_id', companyId)
  if (salesError) throw new Error(salesError.message)

  const valid = (sales ?? []).filter((s) => s.status !== 'cancelled' && s.status !== 'returned')
  const totalOrders = valid.length
  const totalSpent = valid.reduce((sum, s) => sum + Number(s.total), 0)
  const averageTicket = totalOrders > 0 ? Math.round((totalSpent / totalOrders) * 100) / 100 : null
  const dates = valid.map((s) => s.sale_date).sort()
  const firstPurchaseAt = dates[0] ?? null
  const lastPurchaseAt = dates[dates.length - 1] ?? null

  const { data: rfm } = await supabase.from('mv_customer_rfm').select('segment').eq('customer_id', customerId).maybeSingle()
  const { data: cashback } = await supabase.from('v_cashback_balance').select('available_balance').eq('customer_id', customerId).eq('company_id', companyId).maybeSingle()

  return {
    totalOrders,
    totalSpent: Math.round(totalSpent * 100) / 100,
    averageTicket,
    firstPurchaseAt,
    lastPurchaseAt,
    customerSegment: rfm?.segment ?? null,
    cashbackAvailable: Math.round(Number(cashback?.available_balance ?? 0) * 100) / 100,
  }
}

// Cópia deliberada de buildQarvonCustomAttributesPayload (reconciliation.ts)
function buildAttributesPayload(customerId, attrs) {
  const payload = {
    qarvon_customer_id: String(customerId),
    qarvon_total_orders: attrs.totalOrders,
    qarvon_total_spent: attrs.totalSpent,
    qarvon_cashback_available: attrs.cashbackAvailable,
  }
  if (attrs.averageTicket !== null) payload.qarvon_average_ticket = attrs.averageTicket
  if (attrs.firstPurchaseAt) payload.qarvon_first_purchase_at = attrs.firstPurchaseAt
  if (attrs.lastPurchaseAt) payload.qarvon_last_purchase_at = attrs.lastPurchaseAt
  if (attrs.customerSegment) payload.qarvon_customer_segment = attrs.customerSegment
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) payload.qarvon_erp_link = `${appUrl.replace(/\/$/, '')}/clientes/${customerId}`
  return payload
}

function maskPhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length <= 2 ? '**' : `${'*'.repeat(digits.length - 2)}${digits.slice(-2)}`
}

// ─── Contadores do relatório ────────────────────────────────────────────────
const counters = {
  total_candidates: 0,
  already_linked: 0,
  person_created: 0,
  person_reused: 0,
  contact_created: 0,
  contact_reused_by_phone: 0,
  link_created: 0,
  attributes_synced: 0,
  skipped_phone_identity_conflict: 0,
  skipped_customer_multiple_persons_ambiguous: 0,
  skipped_chatwoot_contact_ambiguous: 0,
  errors: 0,
}

async function processCustomer(customer, config, inboxId) {
  counters.total_candidates++

  // ── 1. crm_person já vinculado a este customer? ──────────────────────────
  const { data: existingLinks, error: linksError } = await supabase
    .from('crm_person_customer_links')
    .select('id, person_id, is_primary')
    .eq('customer_id', customer.id)
    .eq('company_id', companyId)
    .eq('active', true)
  if (linksError) throw new Error(linksError.message)

  let personId = null

  if ((existingLinks ?? []).length > 0) {
    // Já vinculado a algum contato Chatwoot via qualquer um dos vínculos existentes? Idempotente — não mexe de novo.
    for (const link of existingLinks) {
      const { data: existingContactLink } = await supabase
        .from('external_entity_links')
        .select('external_id')
        .eq('integration_id', config.integrationId)
        .eq('entity_type', 'crm_person')
        .eq('entity_id', String(link.person_id))
        .eq('external_entity_type', 'contact')
        .eq('active', true)
        .maybeSingle()
      if (existingContactLink) {
        counters.already_linked++
        return { status: 'already_linked', contactId: existingContactLink.external_id }
      }
    }

    if (existingLinks.length === 1) {
      personId = existingLinks[0].person_id
    } else {
      const primary = existingLinks.find((l) => l.is_primary)
      if (primary) {
        personId = primary.person_id
      } else {
        counters.skipped_customer_multiple_persons_ambiguous++
        return { status: 'skipped_customer_multiple_persons_ambiguous' }
      }
    }
    counters.person_reused++
  }

  // ── 2. Sem pessoa vinculada — encontra/cria via identidade de telefone ───
  if (!personId) {
    if (!doExecute) {
      // Dry-run: só reporta a intenção, nunca chama a RPC (que cria de verdade).
      return { status: 'would_create_person_and_contact' }
    }

    const { data: identityResult, error: identityError } = await supabase.rpc('rpc_find_or_create_crm_person_by_identity', {
      p_company_id: companyId,
      p_channel_type: 'whatsapp',
      p_value: customer.phone_e164,
      p_display_name: customer.name,
      p_person_created_source: 'import',
      p_identity_created_source: 'import',
    })
    if (identityError) throw new Error(identityError.message)
    personId = identityResult.person_id

    // O telefone já podia pertencer a uma pessoa vinculada a OUTRO customer
    // (RPC é find-or-create por IDENTIDADE, não por customer) — nunca força
    // um segundo vínculo silenciosamente nesse caso.
    const { data: otherLinks } = await supabase
      .from('crm_person_customer_links')
      .select('id, customer_id')
      .eq('person_id', personId)
      .eq('company_id', companyId)
      .eq('active', true)
    const conflictingLink = (otherLinks ?? []).find((l) => l.customer_id !== customer.id)
    if (conflictingLink) {
      counters.skipped_phone_identity_conflict++
      return { status: 'skipped_phone_identity_conflict' }
    }

    const alreadyLinkedToThis = (otherLinks ?? []).some((l) => l.customer_id === customer.id)
    if (!alreadyLinkedToThis) {
      const { error: linkInsertError } = await supabase.from('crm_person_customer_links').insert({
        company_id: companyId,
        person_id: personId,
        customer_id: customer.id,
        match_source: 'import',
        is_primary: (otherLinks ?? []).length === 0,
      })
      // 23505 = corrida com outra execução — idempotente, ignora.
      if (linkInsertError && linkInsertError.code !== '23505') throw new Error(linkInsertError.message)
    }
    counters.person_created++
  }

  // ── 3. Contato Chatwoot — busca por telefone exato antes de criar ────────
  let contactId = null

  if (!doExecute) {
    return { status: 'would_resolve_contact', personId }
  }

  const searchResult = await chatwootFetch(config, `/contacts/search?q=${encodeURIComponent(customer.phone_e164)}`)
  // Busca do Chatwoot é fuzzy (nome/identifier/email/telefone) — só confia
  // em EQUALDADE exata de dígitos (não `endsWith`, que aceitaria um número
  // maior terminando nos mesmos dígitos por coincidência).
  const exactMatches = (searchResult?.payload ?? []).filter((c) => c.phone_number && c.phone_number.replace(/\D/g, '') === customer.phone_e164)

  if (exactMatches.length > 1) {
    counters.skipped_chatwoot_contact_ambiguous++
    return { status: 'skipped_chatwoot_contact_ambiguous', personId }
  }

  if (exactMatches.length === 1) {
    contactId = String(exactMatches[0].id)
    counters.contact_reused_by_phone++
  } else {
    const createResult = await chatwootFetch(config, '/contacts', {
      method: 'POST',
      body: { inbox_id: inboxId, name: customer.name, phone_number: `+${customer.phone_e164}` },
    })
    contactId = String(createResult?.payload?.contact?.id ?? '')
    if (!contactId) throw new Error('Chatwoot não devolveu o contato criado.')
    counters.contact_created++
  }

  // ── 4. external_entity_link — idempotente (23505 = já existe) ────────────
  const { error: extLinkError } = await supabase.from('external_entity_links').insert({
    company_id: companyId,
    integration_id: config.integrationId,
    provider: 'chatwoot',
    entity_type: 'crm_person',
    entity_id: String(personId),
    external_entity_type: 'contact',
    external_id: contactId,
  })
  if (extLinkError && extLinkError.code !== '23505') throw new Error(extLinkError.message)
  if (!extLinkError) counters.link_created++

  // ── 5. Atributos comerciais — merge, nunca sobrescreve atributo alheio ───
  const currentContact = await chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}`)
  const attrs = await computeCommercialAttributes(customer.id)
  const qarvonPayload = buildAttributesPayload(customer.id, attrs)
  const merged = { ...(currentContact?.custom_attributes ?? {}), ...qarvonPayload }
  await chatwootFetch(config, `/contacts/${encodeURIComponent(contactId)}`, { method: 'PUT', body: { custom_attributes: merged } })
  counters.attributes_synced++

  return { status: 'synced', personId, contactId }
}

async function main() {
  // ── Integração + inbox âncora ───────────────────────────────────────────
  const { data: integration, error: integrationError } = await supabase
    .from('company_integrations')
    .select('id, status, external_account_id, settings')
    .eq('company_id', companyId)
    .eq('provider', 'chatwoot')
    .maybeSingle()
  if (integrationError) { console.error('Erro ao consultar company_integrations:', integrationError.message); process.exit(1) }
  if (!integration) { console.error('Nenhuma integração Chatwoot configurada para esta empresa — rode chatwoot-integration-setup.mjs primeiro.'); process.exit(1) }

  const baseUrl = integration.settings?.base_url
  if (!baseUrl) { console.error('settings.base_url não configurado.'); process.exit(1) }

  let inboxId = inboxIdOverrideArg ? Number(inboxIdOverrideArg) : (integration.settings?.inbox_id ?? integration.settings?.inboxes?.[0]?.id)
  if (!inboxId || !Number.isFinite(Number(inboxId))) {
    console.error('Nenhuma inbox configurada (settings.inbox_id/settings.inboxes[] vazios) — rode chatwoot-integration-setup.mjs --inbox-id ou --register-inbox primeiro, ou passe --inbox-id aqui.')
    process.exit(1)
  }
  inboxId = Number(inboxId)

  const { data: secretRow, error: secretError } = await supabase
    .from('integration_secrets')
    .select('ciphertext, key_version')
    .eq('integration_id', integration.id)
    .eq('company_id', companyId)
    .eq('key', 'api_token')
    .maybeSingle()
  if (secretError) { console.error('Erro ao consultar integration_secrets:', secretError.message); process.exit(1) }
  if (!secretRow) { console.error('api_token não configurado para esta integração.'); process.exit(1) }

  const apiToken = decryptSecret(secretRow.ciphertext, secretRow.key_version)
  const config = { baseUrl, accountId: integration.external_account_id, apiToken, integrationId: integration.id }

  console.log(`Integração: id=${integration.id}, status="${integration.status}", inbox âncora=${inboxId}\n`)

  if (doExecute) {
    console.log('Garantindo definições de custom attribute qarvon_*...')
    await ensureCustomAttributeDefinitions(config)
  }

  // ── Customers elegíveis: não-anônimos, com phone_e164 ───────────────────
  const { data: customers, error: customersError } = await supabase
    .from('customers')
    .select('id, name, phone_e164, is_anonymous')
    .eq('company_id', companyId)
    .eq('is_anonymous', false)
    .not('phone_e164', 'is', null)
    .order('id')
  if (customersError) { console.error('Erro ao consultar customers:', customersError.message); process.exit(1) }

  const { count: totalCustomersCount } = await supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)

  const { count: anonymousCount } = await supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_anonymous', true)

  const { count: noPhoneCount } = await supabase
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_anonymous', false)
    .is('phone_e164', null)

  console.log(`Customers na empresa: ${totalCustomersCount ?? 0} (anônimos excluídos: ${anonymousCount ?? 0}, sem phone_e164 excluídos: ${noPhoneCount ?? 0}, elegíveis: ${(customers ?? []).length})\n`)

  const candidates = (customers ?? []).slice(0, limit)

  for (const customer of candidates) {
    try {
      const result = await processCustomer(customer, config, inboxId)
      console.log(`customer_id=${customer.id} phone=***${maskPhone(customer.phone_e164)} → ${result.status}`)
    } catch (err) {
      counters.errors++
      console.error(`customer_id=${customer.id} → ERRO: ${err.message}`)
    }
  }

  console.log('\n=== Resumo ===')
  for (const [key, value] of Object.entries(counters)) {
    console.log(`${key}: ${value}`)
  }
  if (!doExecute) {
    console.log('\nDRY-RUN — nada foi escrito. Rode de novo com --execute (recomendado com --limit na primeira vez) pra aplicar de verdade.')
  }
}

main().catch((err) => {
  console.error('Erro fatal:', err.message)
  process.exit(1)
})
