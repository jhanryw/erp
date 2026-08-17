#!/usr/bin/env node
/**
 * FASE 4B — Setup operacional seguro da integração Chatwoot real.
 *
 * Configura `company_integrations`/`integration_secrets` pra uma conta
 * Chatwoot real, valida a conexão e garante as definições de custom
 * attribute `qarvon_*` (Fase 4) — tudo numa única execução idempotente.
 *
 * O API token é SEMPRE pedido interativamente (prompt mascarado, nunca
 * eco na tela) — nunca aceito como argumento de linha de comando (vazaria
 * pro histórico do shell/`ps`), nunca lido de arquivo, nunca gravado em
 * lugar nenhum além do `integration_secrets.ciphertext` (cifrado
 * AES-256-GCM). Este script nunca imprime o token, nem parcialmente, em
 * nenhuma saída (stdout/stderr) nem em erro.
 *
 * Uso:
 *   node scripts/chatwoot-integration-setup.mjs \
 *     --company-id <id-real-da-empresa-no-Qarvon> \
 *     --account-id <id-da-conta-no-Chatwoot> \
 *     --base-url https://sua-instancia-chatwoot.example.com
 *
 * Adicione --activate só depois de confirmar que tudo funcionou (o script
 * nunca ativa a integração sozinho por padrão — mesmo princípio de
 * `setupChatwootIntegration()`, src/lib/integrations/chatwoot/setup.ts).
 *
 * Requer no .env.local (ou .env) do ambiente onde este script roda:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   INTEGRATION_SECRETS_CURRENT_KEY_VERSION, INTEGRATION_SECRETS_MASTER_KEY_V<n>
 *   (gere a master key com `openssl rand -base64 32` se ainda não existir —
 *   ver .env.example)
 *
 * Duplicação deliberada: este script reimplementa em JS puro a cifragem
 * AES-256-GCM de src/lib/security/secretCipher.ts e as chamadas HTTP de
 * src/lib/integrations/chatwoot/client.ts — mesmo motivo já registrado em
 * scripts/customer-identity-audit.mjs e
 * scripts/chatwoot-webhook-test-setup.mjs (projeto sem tsx/ts-node pra
 * rodar .ts como script standalone). Qualquer mudança num dos dois lados
 * precisa ser replicada manualmente no outro.
 */

import { createClient } from '@supabase/supabase-js'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
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

const companyId = arg('company-id')
const accountId = arg('account-id')
const baseUrl = arg('base-url')
const shouldActivate = flag('activate')

if (!companyId || !accountId || !baseUrl) {
  console.error('Uso: node scripts/chatwoot-integration-setup.mjs --company-id <id> --account-id <id> --base-url <url> [--activate]')
  process.exit(1)
}

// ─── Validação de base_url (mesma regra de validateChatwootBaseUrl em client.ts) ──
function validateBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'base_url não é uma URL válida.' }
  }
  const isProduction = process.env.NODE_ENV === 'production'
  const allowed = isProduction ? ['https:'] : ['https:', 'http:']
  if (!allowed.includes(url.protocol)) {
    return { ok: false, reason: `Esquema não permitido: ${url.protocol}` }
  }
  return { ok: true, url }
}

const baseUrlCheck = validateBaseUrl(baseUrl)
if (!baseUrlCheck.ok) {
  console.error(`base_url inválida: ${baseUrlCheck.reason}`)
  process.exit(1)
}

// ─── Prompt mascarado (sem dependência externa) ────────────────────────────────
// Códigos de controle sempre via String.fromCharCode (nunca byte literal no
// arquivo-fonte) pra evitar corrupção silenciosa de encoding.
const KEY_ENTER_LF = String.fromCharCode(10) // \n
const KEY_ENTER_CR = String.fromCharCode(13) // \r
const KEY_EOF = String.fromCharCode(4) // Ctrl+D
const KEY_CTRL_C = String.fromCharCode(3)
const KEY_BACKSPACE_DEL = String.fromCharCode(127) // Delete/Backspace na maioria dos terminais
const KEY_BACKSPACE_BS = String.fromCharCode(8) // Backspace (\b) em alguns terminais

function promptHidden(query) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Este script precisa rodar num terminal interativo (TTY) para pedir o token com segurança — não rode via pipe/CI sem um terminal real.'))
      return
    }
    process.stdout.write(query)
    const stdin = process.stdin
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const onData = (char) => {
      char = char.toString()
      if (char === KEY_ENTER_LF || char === KEY_ENTER_CR || char === KEY_EOF) {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.removeListener('data', onData)
        process.stdout.write('\n')
        resolve(value)
      } else if (char === KEY_CTRL_C) {
        stdin.setRawMode(false)
        process.stdout.write('\n')
        process.exit(1)
      } else if (char === KEY_BACKSPACE_DEL || char === KEY_BACKSPACE_BS) {
        value = value.slice(0, -1)
      } else {
        value += char
      }
    }
    stdin.on('data', onData)
  })
}

// ─── Cópia deliberada de src/lib/security/secretCipher.ts ─────────────────────
function encryptSecret(plaintext) {
  const keyVersion = parseInt(process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION ?? '', 10)
  if (!Number.isFinite(keyVersion)) throw new Error('INTEGRATION_SECRETS_CURRENT_KEY_VERSION ausente/inválida no .env.local — configure antes de rodar (ver .env.example).')
  const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
  if (!rawKey) throw new Error(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} ausente — gere com "openssl rand -base64 32" e configure no ambiente antes de rodar.`)
  const key = Buffer.from(rawKey, 'base64')
  if (key.length !== 32) throw new Error(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} deve ter 32 bytes em base64.`)

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([iv, authTag, encrypted]).toString('base64'), keyVersion }
}

// Decifra só dentro desta execução — necessário pra testar a conexão sem
// pedir o token duas vezes ao operador. Mesmo algoritmo de secretCipher.ts.
function decryptForThisRunOnly(ciphertextB64, keyVersion) {
  const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
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
async function chatwootFetch(token, path, init = {}) {
  const url = `${baseUrlCheck.url.origin}/api/v1/accounts/${encodeURIComponent(accountId)}${path}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', api_access_token: token },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* corpo não-JSON, segue sem */ }
    if (!response.ok) {
      // NUNCA loga o header enviado (que contém o token) — só status/corpo de erro do Chatwoot.
      throw new Error(`Chatwoot respondeu ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

const QARVON_CUSTOM_ATTRIBUTES = [
  { key: 'qarvon_customer_id', name: 'Qarvon — ID do Cliente', type: 0, description: 'ID do cliente no ERP Qarvon (customers.id).' },
  { key: 'qarvon_total_orders', name: 'Qarvon — Total de Pedidos', type: 1, description: 'Quantidade de pedidos válidos (exclui cancelados/devolvidos).' },
  { key: 'qarvon_total_spent', name: 'Qarvon — Total Gasto', type: 2, description: 'Soma do valor de pedidos válidos, em BRL.' },
  { key: 'qarvon_average_ticket', name: 'Qarvon — Ticket Médio', type: 2, description: 'total_spent / total_orders, em BRL.' },
  { key: 'qarvon_first_purchase_at', name: 'Qarvon — Primeira Compra', type: 5, description: 'Data da primeira venda válida.' },
  { key: 'qarvon_last_purchase_at', name: 'Qarvon — Última Compra', type: 5, description: 'Data da venda válida mais recente.' },
  { key: 'qarvon_customer_segment', name: 'Qarvon — Segmento (RFM)', type: 0, description: 'Segmento RFM calculado — pode ficar até 1 refresh desatualizado.' },
]

async function main() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios (.env.local ou .env).')
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`Configurando integração Chatwoot — company_id=${companyId}, account_id=${accountId}, base_url=${baseUrl}\n`)

  // ── 1. company_integrations — cria ou atualiza (idempotente) ──────────────
  const { data: existing, error: findError } = await supabase
    .from('company_integrations')
    .select('id, status')
    .eq('company_id', companyId)
    .eq('provider', 'chatwoot')
    .maybeSingle()
  if (findError) { console.error('Erro ao consultar company_integrations:', findError.message); process.exit(1) }

  let integrationId
  if (existing) {
    integrationId = existing.id
    const { error } = await supabase
      .from('company_integrations')
      .update({ external_account_id: String(accountId), settings: { base_url: baseUrl } })
      .eq('id', integrationId)
    if (error) { console.error('Erro ao atualizar company_integrations:', error.message); process.exit(1) }
    console.log(`Integração existente atualizada (id=${integrationId}, status atual="${existing.status}").`)
  } else {
    const { data: created, error } = await supabase
      .from('company_integrations')
      .insert({ company_id: companyId, provider: 'chatwoot', external_account_id: String(accountId), settings: { base_url: baseUrl }, status: 'pending' })
      .select('id')
      .single()
    if (error) { console.error('Erro ao criar company_integrations:', error.message); process.exit(1) }
    integrationId = created.id
    console.log(`Integração criada (id=${integrationId}, status="pending").`)
  }

  // ── 2. Token — SEMPRE interativo, nunca logado ─────────────────────────────
  let token = await promptHidden('API access token do Chatwoot (não será exibido): ')
  if (!token.trim()) { console.error('Token vazio — abortando.'); process.exit(1) }

  const { ciphertext, keyVersion } = encryptSecret(token)
  token = null // limpa a referência em memória assim que possível

  const { error: secretError } = await supabase
    .from('integration_secrets')
    .upsert(
      { integration_id: integrationId, company_id: companyId, key: 'api_token', ciphertext, key_version: keyVersion },
      { onConflict: 'integration_id,key' },
    )
  if (secretError) { console.error('Erro ao gravar secret:', secretError.message); process.exit(1) }
  console.log('api_token cifrado e gravado em integration_secrets.\n')

  // ── 3. Teste de conexão + custom attributes ────────────────────────────────
  const tokenForTest = decryptForThisRunOnly(ciphertext, keyVersion)

  console.log('Testando conexão com o Chatwoot...')
  let existingAttrs
  try {
    existingAttrs = await chatwootFetch(tokenForTest, '/custom_attribute_definitions')
  } catch (err) {
    console.error(`Falha ao conectar: ${err.message}`)
    await supabase.from('company_integrations').update({ last_error: err.message }).eq('id', integrationId)
    process.exit(1)
  }
  console.log('Conexão OK — token válido, account acessível, base_url correta.\n')

  console.log('Garantindo definições de custom attribute qarvon_*...')
  const existingKeys = new Set((existingAttrs ?? []).map((a) => a.attribute_key))
  let created = 0
  let alreadyExisted = 0
  for (const attr of QARVON_CUSTOM_ATTRIBUTES) {
    if (existingKeys.has(attr.key)) { alreadyExisted++; continue }
    await chatwootFetch(tokenForTest, '/custom_attribute_definitions', {
      method: 'POST',
      body: { attribute_key: attr.key, attribute_display_name: attr.name, attribute_display_type: attr.type, attribute_description: attr.description, attribute_model: 1 },
    })
    created++
  }
  console.log(`Custom attributes: ${created} criados, ${alreadyExisted} já existiam.\n`)

  await supabase.from('company_integrations').update({ last_error: null }).eq('id', integrationId)

  // ── 4. Ativação — só se --activate foi passado explicitamente ─────────────
  if (shouldActivate) {
    const { error } = await supabase.from('company_integrations').update({ status: 'active' }).eq('id', integrationId)
    if (error) { console.error('Erro ao ativar:', error.message); process.exit(1) }
    console.log('Integração marcada como ACTIVE — outbound liberado.')
  } else {
    console.log('Integração NÃO foi ativada (padrão — rode de novo com --activate quando confirmar tudo, ou rode manualmente:')
    console.log(`  UPDATE company_integrations SET status = 'active' WHERE id = ${integrationId};`)
  }

  console.log('\nConcluído.')
}

main().catch((err) => {
  console.error('Erro fatal:', err.message)
  process.exit(1)
})
