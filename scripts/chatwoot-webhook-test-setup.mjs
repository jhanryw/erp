#!/usr/bin/env node
/**
 * FASE 3 (Chatwoot Inbound) — gera o SQL de fixture (company_integrations +
 * integration_secrets já cifrado) e um comando `curl` pronto, com assinatura
 * HMAC válida, pra testar `POST /api/integrations/chatwoot/webhook` de
 * ponta a ponta contra um banco de TESTE.
 *
 * Por que este script existe: `integration_secrets.ciphertext` só pode ser
 * produzido pelo mesmo algoritmo de `src/lib/security/secretCipher.ts`
 * (AES-256-GCM com a master key real) — não dá pra fabricar isso à mão em
 * SQL puro. Mesma razão de duplicação deliberada já registrada em
 * `scripts/customer-identity-audit.mjs` (projeto sem tsx/ts-node pra rodar
 * o .ts original como script standalone): a lógica de cifragem abaixo é
 * uma cópia do algoritmo de `secretCipher.ts`, mantida em sincronia
 * manualmente.
 *
 * Uso:
 *   node scripts/chatwoot-webhook-test-setup.mjs \
 *     --company-id 1 \
 *     --account-id 123 \
 *     --webhook-secret "o-secret-mostrado-no-chatwoot" \
 *     --base-url http://localhost:3000
 *
 * Requer as mesmas env vars de produção (.env.local):
 *   INTEGRATION_SECRETS_CURRENT_KEY_VERSION
 *   INTEGRATION_SECRETS_MASTER_KEY_V<n>
 *
 * Não escreve no banco — só IMPRIME o SQL pra você revisar e rodar você
 * mesmo contra o banco de teste (mesmo espírito de todo script desta
 * sessão: nunca escrever em produção sem confirmação explícita).
 */

import { randomBytes, createCipheriv, createHmac } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

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

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  return idx !== -1 ? process.argv[idx + 1] : fallback
}

const companyId = arg('company-id')
const accountId = arg('account-id')
const webhookSecret = arg('webhook-secret')
const baseUrl = arg('base-url', 'http://localhost:3000')

if (!companyId || !accountId || !webhookSecret) {
  console.error('Uso: node scripts/chatwoot-webhook-test-setup.mjs --company-id <id> --account-id <chatwoot_account_id> --webhook-secret "<secret>" [--base-url http://localhost:3000]')
  process.exit(1)
}

// ─── Cópia deliberada do algoritmo de src/lib/security/secretCipher.ts ────────
function encryptSecret(plaintext) {
  const keyVersion = parseInt(process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION ?? '', 10)
  if (!Number.isFinite(keyVersion)) throw new Error('INTEGRATION_SECRETS_CURRENT_KEY_VERSION ausente/inválida no .env.local')
  const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
  if (!rawKey) throw new Error(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} ausente no .env.local`)
  const key = Buffer.from(rawKey, 'base64')
  if (key.length !== 32) throw new Error(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} deve ter 32 bytes em base64`)

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return { ciphertext: Buffer.concat([iv, authTag, encrypted]).toString('base64'), keyVersion }
}

const { ciphertext, keyVersion } = encryptSecret(webhookSecret)

console.log('-- ═══════════════════════════════════════════════════════════════')
console.log('-- 1. Rode este SQL contra o banco de TESTE (nunca produção):')
console.log('-- ═══════════════════════════════════════════════════════════════\n')
console.log(`INSERT INTO public.company_integrations (company_id, provider, external_account_id, status, settings)
VALUES (${companyId}, 'chatwoot', '${accountId}', 'active', '{}'::jsonb)
RETURNING id;  -- anote o id retornado como <INTEGRATION_ID> abaixo\n`)
console.log(`-- Troque <INTEGRATION_ID> pelo id retornado acima antes de rodar:
INSERT INTO public.integration_secrets (integration_id, company_id, key, ciphertext, key_version)
VALUES (<INTEGRATION_ID>, ${companyId}, 'webhook_secret', '${ciphertext}', ${keyVersion});\n`)

// ─── Payload de exemplo + assinatura válida ────────────────────────────────
const samplePayload = JSON.stringify({
  event: 'contact_created',
  id: 999001,
  name: 'Contato Teste E2E',
  email: 'teste.e2e@example.com',
  phone_number: '+5584999990001',
  account: { id: Number(accountId) || accountId },
})
const timestamp = Math.floor(Date.now() / 1000)
const signature = `sha256=${createHmac('sha256', webhookSecret).update(`${timestamp}.${samplePayload}`, 'utf8').digest('hex')}`

console.log('-- ═══════════════════════════════════════════════════════════════')
console.log('-- 2. curl pronto (assinatura válida, timestamp de agora):')
console.log('-- ═══════════════════════════════════════════════════════════════\n')
console.log(`curl -i -X POST '${baseUrl}/api/integrations/chatwoot/webhook' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Chatwoot-Timestamp: ${timestamp}' \\
  -H 'X-Chatwoot-Signature: ${signature}' \\
  -d '${samplePayload}'`)

console.log('\n-- Esperado: 200 {"ok":true}. Rode 2x seguidas pra testar idempotência')
console.log('-- (mesmo contact.id -> mesmo crm_person, sem duplicar).')
console.log('-- Pra testar assinatura inválida, troque 1 caractere do valor de --webhook-secret')
console.log('-- ao gerar o curl (não ao inserir o SQL) e confirme 401.')
