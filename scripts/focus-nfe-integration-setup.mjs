#!/usr/bin/env node
/**
 * Setup operacional seguro da integração Focus NFe — homologação apenas.
 *
 * Mesmo padrão de scripts/chatwoot-integration-setup.mjs: cada bloco de
 * trabalho é opt-in (só roda se a flag correspondente foi passada
 * explicitamente, nunca sobrescreve algo já configurado sem intenção
 * clara), token e senha do certificado SEMPRE pedidos interativamente
 * (prompt mascarado, nunca como argumento de linha de comando — vazaria
 * pro histórico do shell/`ps`), e o script nunca imprime segredo nenhum
 * em nenhuma saída, nem parcialmente, nem em erro.
 *
 * AMBIENTE: este script SÓ opera em homologação — não existe flag pra
 * mudar isso. Emitir em produção não é implementado em nenhum lugar deste
 * projeto ainda (por instrução explícita do responsável pelo produto,
 * repetida em todas as fases fiscais até aqui).
 *
 * Uso (rode os blocos que precisar, na ordem que quiser — tudo idempotente):
 *
 *   # 1. Cadastro fiscal da empresa (company_fiscal_settings) — grava só os
 *   #    campos passados, nunca apaga o que já existia.
 *   node scripts/focus-nfe-integration-setup.mjs --company-id <id> \
 *     --cnpj 61523225000117 --razao-social "61.523.225 FULANO DE TAL" \
 *     --ie 207161780 --crt 4 \
 *     --logradouro "AVENIDA X" --numero 449 --bairro ALECRIM \
 *     --municipio NATAL --municipio-ibge 2408102 --uf RN --cep 59031200
 *
 *   # 2. Token de homologação da Focus (pedido interativamente, nunca como argumento)
 *   node scripts/focus-nfe-integration-setup.mjs --company-id <id> --api-token
 *
 *   # 3. Sincronizar com a Focus (cria/atualiza a empresa lá) — sem certificado
 *   node scripts/focus-nfe-integration-setup.mjs --company-id <id> --sync-empresa
 *
 *   # 3b. Idem, enviando o certificado A1 junto (senha pedida interativamente)
 *   node scripts/focus-nfe-integration-setup.mjs --company-id <id> \
 *     --sync-empresa --certificado /caminho/para/certificado.pfx --senha-certificado
 *
 *   # 4. Ativar a integração (só depois de confirmar que tudo funcionou)
 *   node scripts/focus-nfe-integration-setup.mjs --company-id <id> --activate
 *
 * `--crt` nunca tem default neste script — sempre informado explicitamente
 * pelo operador (nada hardcoded, nem "4" como suposição de MEI).
 *
 * Certificado: se a empresa já tem um certificado válido cadastrado na
 * Focus e você só quer atualizar outro dado (ex.: endereço), rode
 * `--sync-empresa` SEM `--certificado` — o certificado existente na Focus
 * não é tocado (o campo só é enviado quando `--certificado` é passado
 * explicitamente). O arquivo .pfx é lido, convertido pra base64 em
 * memória, enviado à Focus, e a variável é descartada — nunca gravado em
 * lugar nenhum deste projeto (nem log, nem banco, nem arquivo temporário).
 *
 * Requer no .env.local (ou .env):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   INTEGRATION_SECRETS_CURRENT_KEY_VERSION, INTEGRATION_SECRETS_MASTER_KEY_V<n>
 *   (gere a master key com `openssl rand -base64 32` se ainda não existir — ver .env.example)
 *
 * Duplicação deliberada: este script reimplementa em JS puro a cifragem
 * AES-256-GCM de src/lib/security/secretCipher.ts e as chamadas HTTP de
 * src/lib/integrations/focus/httpClient.ts — mesmo motivo já registrado em
 * scripts/chatwoot-integration-setup.mjs (projeto sem tsx/ts-node pra
 * rodar .ts como script standalone). Isto é ferramental operacional, não
 * uma mudança no motor fiscal (congelado — ver docs/fiscal-fase2b-*.md).
 */

import { createClient } from '@supabase/supabase-js'
import { randomBytes, createCipheriv } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const FOCUS_HOMOLOGACAO_BASE_URL = 'https://homologacao.focusnfe.com.br'

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
if (!companyId) {
  console.error('Uso: node scripts/focus-nfe-integration-setup.mjs --company-id <id> [...] — ver o comentário no topo do arquivo pra exemplos completos.')
  process.exit(1)
}

const fiscalSettingsFields = {
  cnpj: arg('cnpj'),
  razao_social: arg('razao-social'),
  nome_fantasia: arg('nome-fantasia'),
  inscricao_estadual: arg('ie'),
  crt: arg('crt') !== undefined ? Number(arg('crt')) : undefined,
  logradouro: arg('logradouro'),
  numero_endereco: arg('numero'),
  complemento: arg('complemento'),
  bairro: arg('bairro'),
  municipio: arg('municipio'),
  municipio_ibge: arg('municipio-ibge'),
  uf: arg('uf'),
  cep: arg('cep'),
  telefone: arg('telefone'),
  email: arg('email'),
}
const hasFiscalSettingsFields = Object.values(fiscalSettingsFields).some((v) => v !== undefined)

const doApiToken = flag('api-token')
const doSyncEmpresa = flag('sync-empresa')
const doActivate = flag('activate')
const certificadoPath = arg('certificado')
const doSenhaCertificado = flag('senha-certificado')

if (fiscalSettingsFields.crt !== undefined && ![1, 2, 3, 4].includes(fiscalSettingsFields.crt)) {
  console.error(`--crt inválido: "${arg('crt')}" — valores aceitos: 1 (Simples Nacional), 2 (excesso de sublimite), 3 (Regime Normal), 4 (MEI).`)
  process.exit(1)
}

if (certificadoPath && !doSyncEmpresa) {
  console.error('--certificado só tem efeito junto de --sync-empresa (o certificado é enviado NA MESMA chamada que sincroniza os dados da empresa com a Focus).')
  process.exit(1)
}
if (certificadoPath && !doSenhaCertificado) {
  console.error('--senha-certificado é obrigatória (pedida interativamente) quando --certificado é passado.')
  process.exit(1)
}
if (certificadoPath && !existsSync(certificadoPath)) {
  console.error(`Arquivo de certificado não encontrado: ${certificadoPath}`)
  process.exit(1)
}

if (!hasFiscalSettingsFields && !doApiToken && !doSyncEmpresa && !doActivate) {
  console.error('Nada a fazer — passe algum campo de cadastro fiscal, e/ou --api-token, e/ou --sync-empresa, e/ou --activate. Nada é tocado por padrão.')
  process.exit(1)
}

// ─── Prompt mascarado (cópia deliberada de chatwoot-integration-setup.mjs) ────
const KEY_ENTER_LF = String.fromCharCode(10)
const KEY_ENTER_CR = String.fromCharCode(13)
const KEY_EOF = String.fromCharCode(4)
const KEY_CTRL_C = String.fromCharCode(3)
const KEY_BACKSPACE_DEL = String.fromCharCode(127)
const KEY_BACKSPACE_BS = String.fromCharCode(8)

function promptHidden(query) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Este script precisa rodar num terminal interativo (TTY) para pedir segredo com segurança — não rode via pipe/CI sem um terminal real.'))
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

// ─── Cópia deliberada de src/lib/integrations/focus/httpClient.ts ─────────────
async function focusFetch(token, path, init = {}) {
  const url = `${FOCUS_HOMOLOGACAO_BASE_URL}${path}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* corpo não-JSON */ }
    if (!response.ok) {
      // NUNCA loga o header Authorization (contém o token) — só status/corpo de erro da Focus.
      throw new Error(`Focus respondeu ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
    }
    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

async function main() {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios (.env.local ou .env).')
    process.exit(1)
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

  console.log(`Setup Focus NFe — company_id=${companyId} — AMBIENTE: homologação (fixo, sem opção de produção neste script)\n`)

  // ── 1. company_fiscal_settings — upsert só dos campos passados ────────────
  if (hasFiscalSettingsFields) {
    const patch = Object.fromEntries(Object.entries(fiscalSettingsFields).filter(([, v]) => v !== undefined))

    const { data: existing } = await supabase.from('company_fiscal_settings').select('id').eq('company_id', companyId).maybeSingle()
    if (existing) {
      const { error } = await supabase.from('company_fiscal_settings').update(patch).eq('id', existing.id)
      if (error) { console.error('Erro ao atualizar company_fiscal_settings:', error.message); process.exit(1) }
      console.log(`company_fiscal_settings atualizado (id=${existing.id}). Campos: ${Object.keys(patch).join(', ')}.`)
    } else {
      const { data: created, error } = await supabase
        .from('company_fiscal_settings')
        .insert({ company_id: companyId, nfe_enabled: true, nfe_environment: 'homologacao', ...patch })
        .select('id')
        .single()
      if (error) { console.error('Erro ao criar company_fiscal_settings:', error.message); process.exit(1) }
      console.log(`company_fiscal_settings criado (id=${created.id}, nfe_enabled=true, nfe_environment=homologacao). Campos: ${Object.keys(patch).join(', ')}.`)
    }
    console.log()
  }

  // ── 2. company_integrations (provider=focus_nfe) — cria ou reaproveita ────
  let integrationId
  {
    const { data: existing, error: findError } = await supabase
      .from('company_integrations')
      .select('id, status, settings')
      .eq('company_id', companyId)
      .eq('provider', 'focus_nfe')
      .maybeSingle()
    if (findError) { console.error('Erro ao consultar company_integrations:', findError.message); process.exit(1) }

    if (existing) {
      integrationId = existing.id
      // Ambiente sempre 'homologacao' — nunca sobrescrito com outra coisa por este script.
      const mergedSettings = { ...(existing.settings ?? {}), environment: 'homologacao' }
      await supabase.from('company_integrations').update({ settings: mergedSettings }).eq('id', integrationId)
      console.log(`Integração focus_nfe já existia (id=${integrationId}, status atual="${existing.status}") — settings.environment confirmado como homologacao.`)
    } else {
      const { data: created, error } = await supabase
        .from('company_integrations')
        .insert({ company_id: companyId, provider: 'focus_nfe', settings: { environment: 'homologacao' }, status: 'pending' })
        .select('id')
        .single()
      if (error) { console.error('Erro ao criar company_integrations:', error.message); process.exit(1) }
      integrationId = created.id
      console.log(`Integração focus_nfe criada (id=${integrationId}, status="pending", environment=homologacao).`)
    }
    console.log()
  }

  // ── 3. api_token — só se --api-token foi passado ──────────────────────────
  if (doApiToken) {
    let token = await promptHidden('Token de HOMOLOGAÇÃO da Focus NFe (não será exibido): ')
    if (!token.trim()) { console.error('Token vazio — abortando.'); process.exit(1) }

    const { ciphertext, keyVersion } = encryptSecret(token)
    token = null // limpa a referência em memória assim que possível

    const { error } = await supabase
      .from('integration_secrets')
      .upsert({ integration_id: integrationId, company_id: companyId, key: 'api_token', ciphertext, key_version: keyVersion }, { onConflict: 'integration_id,key' })
    if (error) { console.error('Erro ao gravar api_token:', error.message); process.exit(1) }
    console.log('api_token cifrado e gravado em integration_secrets.\n')
  }

  // ── 4. sync-empresa — cria/atualiza a empresa na Focus, opcionalmente com certificado ──
  if (doSyncEmpresa) {
    const { data: settings } = await supabase
      .from('company_fiscal_settings')
      .select('cnpj, razao_social, nome_fantasia, inscricao_estadual, crt, logradouro, numero_endereco, complemento, bairro, municipio, uf, cep, telefone, email')
      .eq('company_id', companyId)
      .maybeSingle()

    if (!settings) { console.error('company_fiscal_settings não encontrado — rode este script com os campos de cadastro fiscal primeiro (ver bloco 1 do comentário de uso).'); process.exit(1) }
    if (!settings.cnpj || !settings.razao_social || !settings.crt) { console.error('company_fiscal_settings incompleto — cnpj, razao_social e crt são obrigatórios pra sincronizar com a Focus.'); process.exit(1) }

    const { data: secretRow } = await supabase
      .from('integration_secrets')
      .select('ciphertext, key_version')
      .eq('integration_id', integrationId)
      .eq('key', 'api_token')
      .maybeSingle()
    if (!secretRow) { console.error('Nenhum api_token configurado — rode este script com --api-token primeiro.'); process.exit(1) }

    // Decifra só pra esta execução, nunca impresso.
    const { createDecipheriv } = await import('node:crypto')
    const rawKey = process.env[`INTEGRATION_SECRETS_MASTER_KEY_V${secretRow.key_version}`]
    const packed = Buffer.from(secretRow.ciphertext, 'base64')
    const iv = packed.subarray(0, 12)
    const authTag = packed.subarray(12, 28)
    const data = packed.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(rawKey, 'base64'), iv)
    decipher.setAuthTag(authTag)
    const token = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')

    const input = {
      nome: settings.razao_social,
      nome_fantasia: settings.nome_fantasia ?? undefined,
      cnpj: settings.cnpj,
      inscricao_estadual: settings.inscricao_estadual ?? undefined,
      regime_tributario: settings.crt,
      logradouro: settings.logradouro ?? undefined,
      numero: settings.numero_endereco ?? undefined,
      complemento: settings.complemento ?? undefined,
      bairro: settings.bairro ?? undefined,
      municipio: settings.municipio ?? undefined,
      uf: settings.uf ?? undefined,
      cep: settings.cep ?? undefined,
      telefone: settings.telefone ?? undefined,
      email: settings.email ?? undefined,
      habilita_nfe: true,
    }

    if (certificadoPath) {
      let senha = await promptHidden('Senha do certificado A1 (não será exibida): ')
      if (!senha) { console.error('Senha vazia — abortando.'); process.exit(1) }
      const fileBuffer = readFileSync(certificadoPath)
      input.arquivo_certificado_base64 = fileBuffer.toString('base64')
      input.senha_certificado = senha
      senha = null // limpa a referência em memória assim que possível
      console.log(`Certificado ${certificadoPath} (${fileBuffer.length} bytes) será enviado junto — nunca gravado neste projeto.`)
    }

    console.log(`Sincronizando empresa (CNPJ ${settings.cnpj}, CRT ${settings.crt}) com a Focus (homologação)...`)
    const cnpjDigits = settings.cnpj.replace(/\D/g, '')
    const existingList = await focusFetch(token, `/v2/empresas?cnpj=${cnpjDigits}`)
    const match = (existingList ?? []).find((e) => (e.cnpj ?? '').replace(/\D/g, '') === cnpjDigits)

    let result
    if (match) {
      result = await focusFetch(token, `/v2/empresas/${match.id}`, { method: 'PUT', body: input })
      console.log(`Empresa ATUALIZADA na Focus (id=${match.id}).`)
    } else {
      result = await focusFetch(token, '/v2/empresas', { method: 'POST', body: input })
      console.log(`Empresa CRIADA na Focus (id=${result.id}).`)
    }
    console.log(`habilita_nfe=${result.habilita_nfe ?? '(não informado na resposta)'}, certificado_valido_ate=${result.certificado_valido_ate ?? '(nenhum certificado válido registrado)'}.\n`)
  }

  // ── 5. Ativação — só se --activate foi passado explicitamente ─────────────
  if (doActivate) {
    const { error } = await supabase.from('company_integrations').update({ status: 'active' }).eq('id', integrationId)
    if (error) { console.error('Erro ao ativar:', error.message); process.exit(1) }
    console.log('Integração focus_nfe marcada como ACTIVE.')
  } else if (doApiToken || doSyncEmpresa) {
    console.log('Integração NÃO foi ativada (padrão — rode de novo com --activate quando confirmar tudo).')
  }

  console.log('\nConcluído. Nenhuma NF-e foi emitida por este script — emissão é uma ação manual separada (botão "Emitir NF-e de homologação" na página da venda).')
}

main().catch((err) => {
  console.error('Erro fatal:', err.message)
  process.exit(1)
})
