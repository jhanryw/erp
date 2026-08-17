#!/usr/bin/env node
/**
 * FASE 1 (Customer Identity) — auditoria de telefones/duplicidade e,
 * opcionalmente, backfill de `customers.phone_e164` + linking retroativo de
 * alta confiança em `crm_person_customer_links`.
 *
 * Por padrão roda 100% READ-ONLY (só SELECT) e imprime um relatório —
 * nenhuma flag = dry-run/auditoria, seguro em produção.
 *
 * Uso:
 *   node scripts/customer-identity-audit.mjs
 *     → só relatório (seções A/B do relatório da Fase 1), nenhuma escrita.
 *
 *   node scripts/customer-identity-audit.mjs --backfill-phone
 *     → além do relatório, preenche customers.phone_e164 SÓ onde está NULL
 *       hoje e o valor de customers.phone normaliza sem ambiguidade.
 *       Nunca sobrescreve um phone_e164 já preenchido. Nunca toca
 *       is_anonymous=true. Idempotente (rodar de novo não muda nada que já
 *       foi preenchido).
 *
 *   node scripts/customer-identity-audit.mjs --link-high-confidence
 *     → além do relatório, cria vínculos em crm_person_customer_links SÓ
 *       para crm_persons cujo telefone/e-mail bate com EXATAMENTE 1
 *       customer real (não-anônimo) da mesma empresa. Casos ambíguos ou em
 *       conflito NUNCA são vinculados automaticamente — ficam só no
 *       relatório. Idempotente (usa o mesmo unique constraint que o service
 *       de produção usa).
 *
 *   node scripts/customer-identity-audit.mjs --backfill-phone --link-high-confidence
 *     → os dois acima, nessa ordem (link se beneficia do backfill de phone
 *       feito na mesma execução).
 *
 * IMPORTANTE — duplicação deliberada de lógica: este projeto não tem
 * ferramenta de execução de TypeScript para scripts standalone (sem
 * ts-node/tsx instalado, scripts/ é sempre .js/.mjs puro — mesmo padrão dos
 * scripts já existentes). Por isso a normalização de telefone abaixo
 * (`normalizePhoneBR`) é uma cópia deliberada, em JS puro, do algoritmo
 * canônico em `src/lib/utils/phone.ts` — QUALQUER mudança num dos dois
 * precisa ser replicada no outro. A classificação EXACT/HIGH_CONFIDENCE/
 * AMBIGUOUS/CONFLICT/NO_MATCH abaixo espelha (não importa diretamente)
 * `src/services/crm/customer-identity.service.ts:classify()`, pela mesma
 * razão. Ver relatório da Fase 1, seção K, para essa dívida técnica
 * registrada explicitamente.
 *
 * Nunca imprime telefone/CPF/e-mail em texto puro — só contagens e IDs
 * internos, para investigação sem expor dado sensível desnecessariamente.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(ROOT, '.env.local'))
loadEnvFile(join(ROOT, '.env'))

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios (.env.local ou .env).')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const FLAGS = new Set(process.argv.slice(2))
const DO_BACKFILL_PHONE = FLAGS.has('--backfill-phone')
const DO_LINK = FLAGS.has('--link-high-confidence')
const ANONYMOUS_CPF_PLACEHOLDER = '11111111111'

// ─── Cópia deliberada de src/lib/utils/phone.ts — ver comentário no topo ──────
function normalizePhoneBR(raw) {
  if (!raw || !String(raw).trim()) return { ok: false, reason: 'empty' }
  let digits = String(raw).replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'empty' }
  if (digits.startsWith('00') && (digits.length === 14 || digits.length === 15)) digits = digits.slice(2)

  let national
  if (digits.length === 12 || digits.length === 13) {
    if (!digits.startsWith('55')) return { ok: false, reason: 'invalid_length' }
    national = digits.slice(2)
  } else if (digits.length === 10 || digits.length === 11) {
    national = digits
  } else {
    return { ok: false, reason: 'invalid_length' }
  }

  const ddd = national.slice(0, 2)
  const subscriber = national.slice(2)
  if (!/^[1-9][0-9]$/.test(ddd)) return { ok: false, reason: 'invalid_ddd' }
  if (subscriber.length === 9) {
    if (subscriber[0] !== '9') return { ok: false, reason: 'ambiguous' }
  } else if (subscriber.length !== 8) {
    return { ok: false, reason: 'invalid_length' }
  }
  return { ok: true, e164: `+55${ddd}${subscriber}`, e164NoPlus: `55${ddd}${subscriber}` }
}

// ─── Classificador de FORMATO BRUTO (só pro relatório, seção A) ───────────────
function classifyRawFormat(raw) {
  if (raw === null || raw === undefined) return 'NULL'
  const str = String(raw)
  if (!str.trim()) return 'vazio'
  const digits = str.replace(/\D/g, '')
  if (!digits) return 'com caracteres (sem nenhum dígito)'
  const hasMask = /[()\-.]/.test(str)
  const hasSpaces = /\s/.test(str.trim())
  const hasLetters = /[a-zA-Z]/.test(str)
  const result = normalizePhoneBR(str)
  if (result.ok) {
    if (str.trim() === result.e164) return 'E164 válido (já no formato canônico)'
    if (digits.length === 13 || digits.length === 12) return '55 + DDD + número'
    if (digits.length === 11 || digits.length === 10) return 'DDD + número (sem DDI)'
    return 'normalizável (outro formato)'
  }
  if (hasLetters) return 'com caracteres'
  if (hasMask) return 'com máscara'
  if (hasSpaces) return 'com espaços'
  if (digits.length < 10) return 'número sem DDD / curto demais'
  if (result.reason === 'ambiguous') return 'ambíguo'
  return 'inválido'
}

// ─── Paginação genérica ────────────────────────────────────────────────────────
async function fetchAll(table, columns, pageSize = 1000) {
  const rows = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1)
    if (error) throw new Error(`Erro lendo ${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return rows
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`)
  console.table(rows)
}

// ─── SEÇÃO A — distribuição de formatos de telefone ────────────────────────────
async function auditPhoneFormats(customers) {
  const byFormat = new Map()
  const byReason = new Map()
  for (const c of customers) {
    const fmt = classifyRawFormat(c.phone)
    byFormat.set(fmt, (byFormat.get(fmt) ?? 0) + 1)
    const result = normalizePhoneBR(c.phone)
    const reasonKey = result.ok ? 'normalizável (ok)' : `falha: ${result.reason}`
    byReason.set(reasonKey, (byReason.get(reasonKey) ?? 0) + 1)
  }
  printTable('A. Distribuição de formato bruto (customers.phone)', [...byFormat.entries()].map(([formato, quantidade]) => ({ formato, quantidade })))
  printTable('A. Resultado da normalização (se aplicada hoje)', [...byReason.entries()].map(([resultado, quantidade]) => ({ resultado, quantidade })))
}

// ─── SEÇÃO B — duplicidades ─────────────────────────────────────────────────────
function groupDuplicates(customers, keyFn) {
  const groups = new Map()
  for (const c of customers) {
    if (c.is_anonymous) continue
    const key = keyFn(c)
    if (key === null) continue
    const scoped = `${c.company_id}::${key}`
    if (!groups.has(scoped)) groups.set(scoped, [])
    groups.get(scoped).push(c.id)
  }
  return [...groups.entries()].filter(([, ids]) => ids.length > 1)
}

async function auditDuplicates(customers) {
  const phoneDupes = groupDuplicates(customers, (c) => {
    const r = normalizePhoneBR(c.phone)
    return r.ok ? r.e164NoPlus : null
  })
  const cpfDupes = groupDuplicates(customers, (c) => {
    const cpf = c.cpf ? String(c.cpf).replace(/\D/g, '') : null
    return cpf && cpf !== ANONYMOUS_CPF_PLACEHOLDER ? cpf : null
  })
  const emailDupes = groupDuplicates(customers, (c) => {
    const email = c.email ? String(c.email).trim().toLowerCase() : null
    return email || null
  })
  const semTelefone = customers.filter((c) => !c.is_anonymous && (!c.phone || !String(c.phone).trim())).length
  const invalidos = customers.filter((c) => !c.is_anonymous && c.phone && normalizePhoneBR(c.phone).reason === 'invalid_length').length
  const ambiguos = customers.filter((c) => !c.is_anonymous && c.phone && normalizePhoneBR(c.phone).reason === 'ambiguous').length

  printTable('B. Resumo de duplicidade/qualidade (escopado por company_id, exclui is_anonymous)', [
    { tipo: 'Telefones duplicados após normalização (grupos)', quantidade: phoneDupes.length },
    { tipo: 'CPFs duplicados (grupos)', quantidade: cpfDupes.length },
    { tipo: 'Emails duplicados (grupos)', quantidade: emailDupes.length },
    { tipo: 'Clientes sem telefone', quantidade: semTelefone },
    { tipo: 'Telefones inválidos (invalid_length)', quantidade: invalidos },
    { tipo: 'Telefones ambíguos (ambiguous)', quantidade: ambiguos },
  ])

  if (phoneDupes.length) printTable('B. Grupos de telefone duplicado — IDs internos (nunca o valor)', phoneDupes.map(([key, ids]) => ({ company_scoped_key: key.split('::')[0], customer_ids: ids.join(', ') })))
  if (cpfDupes.length) printTable('B. Grupos de CPF duplicado — IDs internos (nunca o valor)', cpfDupes.map(([key, ids]) => ({ company_id: key.split('::')[0], customer_ids: ids.join(', ') })))
  if (emailDupes.length) printTable('B. Grupos de email duplicado — IDs internos (nunca o valor)', emailDupes.map(([key, ids]) => ({ company_id: key.split('::')[0], customer_ids: ids.join(', ') })))
}

// ─── Backfill de phone_e164 (opcional, --backfill-phone) ──────────────────────
async function backfillPhoneE164(customers) {
  const toUpdate = customers.filter((c) => {
    if (c.is_anonymous) return false
    if (c.phone_e164) return false // nunca sobrescreve valor já preenchido
    const r = normalizePhoneBR(c.phone)
    return r.ok
  })

  console.log(`\n=== BACKFILL phone_e164 — ${toUpdate.length} cliente(s) a atualizar ===`)
  let ok = 0
  let failed = 0
  for (const c of toUpdate) {
    const r = normalizePhoneBR(c.phone)
    const { error } = await supabase.from('customers').update({ phone_e164: r.e164NoPlus }).eq('id', c.id).eq('company_id', c.company_id)
    if (error) {
      failed++
      console.error(`  falha ao atualizar customer #${c.id}: ${error.message}`)
    } else {
      ok++
    }
  }
  console.log(`Backfill concluído: ${ok} atualizados, ${failed} falharam.`)
  return { updated: ok, failed }
}

// ─── Linking retroativo de alta confiança (opcional, --link-high-confidence) ──
async function linkHighConfidence() {
  const identities = await fetchAll('crm_channel_identities', 'person_id, company_id, channel_type, value, active')
  const activeIdentities = identities.filter((i) => i.active && (i.channel_type === 'whatsapp' || i.channel_type === 'telegram' || i.channel_type === 'email'))
  const customers = await fetchAll('customers', 'id, company_id, phone_e164, email, is_anonymous').then((rows) => rows.filter((r) => !r.is_anonymous))
  const existingLinks = await fetchAll('crm_person_customer_links', 'person_id, customer_id, company_id, active').then((rows) => rows.filter((r) => r.active))

  const identitiesByPerson = new Map()
  for (const i of activeIdentities) {
    if (!identitiesByPerson.has(i.person_id)) identitiesByPerson.set(i.person_id, [])
    identitiesByPerson.get(i.person_id).push(i)
  }

  const customersByPhone = new Map() // `${companyId}::${phoneE164NoPlus}` -> [customerId,...]
  const customersByEmail = new Map()
  for (const c of customers) {
    if (c.phone_e164) {
      const key = `${c.company_id}::${c.phone_e164}`
      if (!customersByPhone.has(key)) customersByPhone.set(key, [])
      customersByPhone.get(key).push(c.id)
    }
    if (c.email) {
      const key = `${c.company_id}::${c.email.trim().toLowerCase()}`
      if (!customersByEmail.has(key)) customersByEmail.set(key, [])
      customersByEmail.get(key).push(c.id)
    }
  }

  const existingLinkKeys = new Set(existingLinks.map((l) => `${l.person_id}::${l.customer_id}`))

  const tiers = { EXACT: 0, HIGH_CONFIDENCE: 0, AMBIGUOUS: 0, CONFLICT: 0, NO_MATCH: 0 }
  const toLink = [] // { personId, companyId, customerId, matchSource }

  for (const [personId, personIdentities] of identitiesByPerson.entries()) {
    const companyId = personIdentities[0].company_id
    const candidates = []
    for (const idn of personIdentities) {
      if (idn.channel_type === 'email') {
        const key = `${companyId}::${idn.value.trim().toLowerCase()}`
        for (const customerId of customersByEmail.get(key) ?? []) candidates.push({ customerId, matchedBy: 'email' })
      } else {
        const key = `${companyId}::${idn.value}`
        for (const customerId of customersByPhone.get(key) ?? []) candidates.push({ customerId, matchedBy: 'phone' })
      }
    }
    const distinctCustomers = [...new Set(candidates.map((c) => c.customerId))]
    let tier
    if (distinctCustomers.length === 0) tier = 'NO_MATCH'
    else if (distinctCustomers.length === 1) tier = 'HIGH_CONFIDENCE'
    else {
      const types = new Set(candidates.map((c) => c.matchedBy))
      tier = types.size > 1 ? 'CONFLICT' : 'AMBIGUOUS'
    }
    tiers[tier]++

    if (tier === 'HIGH_CONFIDENCE') {
      const customerId = distinctCustomers[0]
      if (existingLinkKeys.has(`${personId}::${customerId}`)) continue // idempotente: já linkado
      const matchedBy = candidates.find((c) => c.customerId === customerId).matchedBy
      toLink.push({ personId, companyId, customerId, matchSource: matchedBy === 'email' ? 'email_match' : 'phone_match' })
    }
  }

  printTable('Classificação de matching crm_person → customer (todas as pessoas com identidade de canal ativa)', Object.entries(tiers).map(([tier, quantidade]) => ({ tier, quantidade })))

  if (!DO_LINK) {
    console.log(`\n(dry-run — ${toLink.length} vínculo(s) HIGH_CONFIDENCE seriam criados com --link-high-confidence; nenhuma escrita feita)`)
    return
  }

  console.log(`\n=== LINKING — ${toLink.length} vínculo(s) a criar ===`)
  let created = 0
  let alreadyLinked = 0
  let failed = 0
  const primaryAlreadySet = new Set(existingLinks.filter((l) => l.active).map((l) => l.person_id)) // aproximação: se a pessoa já tem QUALQUER link ativo, não é primary

  for (const item of toLink) {
    const isPrimary = !primaryAlreadySet.has(item.personId)
    const { error } = await supabase.from('crm_person_customer_links').insert({
      company_id: item.companyId,
      person_id: item.personId,
      customer_id: item.customerId,
      match_source: item.matchSource,
      is_primary: isPrimary,
    })
    if (error) {
      if (error.code === '23505') {
        alreadyLinked++ // corrida ou já existia — idempotente
      } else {
        failed++
        console.error(`  falha ao vincular person #${item.personId} → customer #${item.customerId}: ${error.message}`)
      }
    } else {
      created++
      primaryAlreadySet.add(item.personId)
    }
  }
  console.log(`Linking concluído: ${created} criados, ${alreadyLinked} já existiam (idempotente), ${failed} falharam.`)
}

// ─── main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('FASE 1 (Customer Identity) — auditoria de telefones/duplicidade')
  console.log(`Modo: ${DO_BACKFILL_PHONE ? 'BACKFILL phone_e164 ATIVO' : 'backfill phone_e164 desligado (dry-run)'} | ${DO_LINK ? 'LINKING ATIVO' : 'linking desligado (dry-run)'}\n`)

  const customers = await fetchAll('customers', 'id, company_id, phone, phone_e164, cpf, email, is_anonymous')
  console.log(`Total de customers lidos: ${customers.length}`)

  await auditPhoneFormats(customers)
  await auditDuplicates(customers)

  if (DO_BACKFILL_PHONE) {
    const result = await backfillPhoneE164(customers)
    // recarrega pra refletir os phone_e164 recém-preenchidos antes do linking
    if (DO_LINK && result.updated > 0) {
      const refreshed = await fetchAll('customers', 'id, company_id, phone, phone_e164, cpf, email, is_anonymous')
      customers.length = 0
      customers.push(...refreshed)
    }
  }

  await linkHighConfidence()

  console.log('\nConcluído.')
}

main().catch((err) => {
  console.error('Erro fatal:', err)
  process.exit(1)
})
