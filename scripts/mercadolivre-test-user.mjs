#!/usr/bin/env node
/**
 * Ferramenta OPERACIONAL (restrita) — cria um usuário TEST do Mercado Livre.
 *
 * Não existe na UI do SaaS de propósito: só quem tem acesso ao servidor
 * (service role + master key de segredos) consegue rodar.
 *
 * Doc oficial "Realização de testes" (atualizada 30/12/2025):
 *   - o Mercado Livre NÃO tem sandbox: usuários TEST operam no ambiente real
 *     e só negociam com outros usuários TEST;
 *   - POST https://api.mercadolibre.com/users/test_user  {"site_id":"MLB"}
 *     com o token de uma conta que autorizou o app;
 *   - até 10 usuários TEST por conta; a SENHA vem uma única vez e não é
 *     recuperável; usuários sem atividade por 60 dias são removidos;
 *   - crie pelo menos um VENDEDOR e um COMPRADOR.
 *
 * O token usado é o da integração Mercado Livre JÁ CONECTADA na empresa
 * indicada (ex.: a conta autorizadora da equipe Qarvon numa empresa de teste).
 * Este script NÃO renova token (para nunca disputar o refresh_token de uso
 * único fora do lease do app): se estiver expirado, use "Renovar token" em
 * Configurações → Mercado Livre e rode de novo.
 *
 * As credenciais do usuário TEST são impressas UMA vez no terminal e NUNCA
 * gravadas pelo script. Guarde-as no cofre de senhas da equipe.
 *
 * Uso:
 *   node scripts/mercadolivre-test-user.mjs --company-id <id> --role seller|buyer [--site MLB] --confirm
 */

import { createClient } from '@supabase/supabase-js'
import { createDecipheriv } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : undefined }
const flag = (name) => process.argv.includes(`--${name}`)

const companyId = Number(arg('company-id'))
const role = arg('role')
const siteId = (arg('site') ?? process.env.MERCADOLIVRE_DEFAULT_SITE_ID ?? 'MLB').toUpperCase()
const apiUrl = (process.env.MERCADOLIVRE_API_URL ?? 'https://api.mercadolibre.com').replace(/\/+$/, '')

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!Number.isInteger(companyId) || companyId <= 0) fail('Informe --company-id <id da empresa (de TESTE) com Mercado Livre conectado>.')
if (role !== 'seller' && role !== 'buyer') fail('Informe --role seller|buyer (rótulo para você organizar as credenciais).')
if (!/^[A-Z]{3}$/.test(siteId)) fail('--site inválido (ex.: MLB).')
if (!flag('confirm')) fail('Adicione --confirm: cada execução consome 1 dos 10 usuários TEST permitidos por conta.')

// Cópia deliberada de src/lib/security/secretCipher.ts (decrypt), só nesta execução.
function decrypt(ciphertextB64, keyVersion) {
  const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
  if (!rawKey) fail(`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion} ausente no ambiente.`)
  const key = Buffer.from(rawKey, 'base64')
  const packed = Buffer.from(ciphertextB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(12, 28))
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) fail('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes.')
const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

const { data: integration, error: intErr } = await supabase
  .from('company_integrations')
  .select('id, status, external_account_id, credential_expires_at, settings')
  .eq('company_id', companyId)
  .eq('provider', 'mercadolivre')
  .order('id', { ascending: true })
  .limit(1)
  .maybeSingle()
if (intErr) fail('Falha ao ler a integração.')
if (!integration || integration.status !== 'active') fail(`Empresa ${companyId} sem Mercado Livre conectado (status: ${integration?.status ?? 'nenhum'}).`)
if (!integration.credential_expires_at || new Date(integration.credential_expires_at).getTime() < Date.now() + 60_000) {
  fail('Token expirado ou perto de expirar. Use "Renovar token" em Configurações → Mercado Livre e rode de novo.')
}

const { data: secret, error: secErr } = await supabase
  .from('integration_secrets')
  .select('ciphertext, key_version')
  .eq('integration_id', integration.id)
  .eq('company_id', companyId)
  .eq('key', 'access_token')
  .maybeSingle()
if (secErr || !secret) fail('access_token da integração não encontrado.')

const accessToken = decrypt(secret.ciphertext, secret.key_version)

const res = await fetch(`${apiUrl}/users/test_user`, {
  method: 'POST',
  headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ site_id: siteId }),
})
const body = await res.json().catch(() => ({}))
if (!res.ok) fail(`Mercado Livre respondeu ${res.status}${body?.error ? ` (${body.error})` : ''}${body?.message ? `: ${body.message}` : ''}.`)

console.log('')
console.log(`✓ Usuário TEST (${role}) criado a partir da conta ${integration.external_account_id} — site ${siteId}`)
console.log('  GUARDE AGORA no cofre de senhas — a senha não pode ser recuperada:')
console.log(`    user_id : ${body.id}`)
console.log(`    nickname: ${body.nickname}`)
console.log(`    password: ${body.password}`)
console.log(`    status  : ${body.site_status}`)
console.log('  Código de verificação de e-mail = últimos dígitos do user_id (4 ou 6).')
console.log('')
