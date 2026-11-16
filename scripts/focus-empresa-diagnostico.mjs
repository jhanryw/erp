#!/usr/bin/env node
/**
 * Diagnóstico SOMENTE LEITURA/SIMULAÇÃO do cadastro da empresa na Focus NFe.
 * Não existe neste script nenhum caminho de PUT real: o único PUT possível é
 * com `?dry_run=1` (a Focus simula sem gravar) e só roda com --dry-run
 * E --confirmar-dry-run.
 *
 * Autenticação (doc.focusnfe.com.br, "Atualizar empresa"): HTTP Basic com o
 * TOKEN PRINCIPAL (master) como usuário e senha vazia, host de PRODUÇÃO
 * (api.focusnfe.com.br) — a API de empresas só opera em produção.
 *
 * O token é pedido de forma interativa (entrada oculta) — nunca por argumento,
 * nunca impresso. A saída mostra só campos permitidos (lista branca).
 *
 * Uso:
 *   node scripts/focus-empresa-diagnostico.mjs --plan                       # mostra os payloads; sem rede
 *   node scripts/focus-empresa-diagnostico.mjs --consultar [--focus-id N]   # GET /v2/empresas/{id}
 *   node scripts/focus-empresa-diagnostico.mjs --consultar --token-do-banco # idem, token decifrado do banco (container)
 *   node scripts/focus-empresa-diagnostico.mjs --dry-run --confirmar-dry-run --proximo-numero N   # PUT ?dry_run=1
 *   node scripts/focus-empresa-diagnostico.mjs --dry-run --confirmar-dry-run --razao-social       # PUT ?dry_run=1
 */
import { readFileSync } from 'node:fs'
import readline from 'node:readline'
import { loadMasterToken } from './focus-empresa-consulta-container.mjs'

const HOST = 'https://api.focusnfe.com.br'
const RAZAO_SOCIAL = 'SANTTORINI LINGERIE LTDA'
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }

function buildDryRunPayload() {
  const payload = {}
  const n = val('--proximo-numero')
  if (n !== undefined) {
    if (!/^[1-9]\d{0,8}$/.test(n)) throw new Error('--proximo-numero deve ser um inteiro positivo (até 9 dígitos).')
    payload.proximo_numero_nfe_producao = n // string, conforme a doc
  }
  if (has('--razao-social')) payload.nome = RAZAO_SOCIAL
  if (Object.keys(payload).length === 0) throw new Error('Informe --proximo-numero N e/ou --razao-social. Nenhum número é escolhido automaticamente.')
  return payload
}

function loadEnv() {
  const env = {}
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* sem .env.local */ }
  return env
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a.trim()) })
  })
}

async function resolveFocusId() {
  const given = val('--focus-id')
  if (given) return given
  const env = loadEnv()
  const url = env.NEXT_PUBLIC_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Sem --focus-id e sem credenciais Supabase em .env.local.')
  const r = await fetch(`${url}/rest/v1/company_integrations?select=external_account_id&company_id=eq.1&provider=eq.focus_nfe`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  const rows = await r.json()
  const id = Array.isArray(rows) && rows[0]?.external_account_id
  if (!id) throw new Error('external_account_id da Focus não encontrado — informe --focus-id.')
  return String(id)
}

const maskCnpj = (c) => (c ? `${String(c).slice(0, 2)}.***.***/${String(c).replace(/\D/g, '').slice(-6)}` : null)

function pick(e) {
  return {
    id: e.id, cnpj: maskCnpj(e.cnpj),
    razao_social: e.razao_social ?? e.nome ?? null, nome_fantasia: e.nome_fantasia ?? null,
    regime_tributario: e.regime_tributario ?? null, habilita_nfe: e.habilita_nfe ?? null,
    serie_nfe_producao: e.serie_nfe_producao ?? null,
    proximo_numero_nfe_producao: e.proximo_numero_nfe_producao ?? null,
    // campos de numeração presentes na resposta (nomes apenas, p/ conferência):
    chaves_de_numeracao_presentes: Object.keys(e).filter((k) => /proximo_numero|^serie_/.test(k)),
  }
}

async function focus(method, path, token, body) {
  const res = await fetch(`${HOST}${path}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: res.status, json }
}

async function main() {
  if (has('--plan')) {
    const payloadNumero = { proximo_numero_nfe_producao: '<N — A DEFINIR; só após identificar o maior número usado na série 1>' }
    console.log('PUT /v2/empresas/{id}?dry_run=1 — payload (numeração):\n' + JSON.stringify(payloadNumero, null, 2))
    console.log('\nPUT /v2/empresas/{id}?dry_run=1 — payload (razão social, separado):\n' + JSON.stringify({ nome: RAZAO_SOCIAL }, null, 2))
    console.log('\nNão são enviados: regime_tributario, campos de NFC-e, série, endereço, IE, certificado.')
    return
  }
  if (!has('--consultar') && !has('--dry-run')) { console.log('Use --plan, --consultar ou --dry-run (veja o cabeçalho do arquivo).'); return }
  if (has('--dry-run') && !has('--confirmar-dry-run')) throw new Error('--dry-run exige --confirmar-dry-run (simulação não grava, mas só roda após aprovação).')

  // --token-do-banco: lê e decifra o token já guardado no ERP (rodar dentro do container, que tem as
  // variáveis de ambiente). Sem a flag, o token é pedido de forma interativa (entrada oculta).
  let focusId, token
  if (has('--token-do-banco')) ({ focusId, token } = await loadMasterToken())
  else {
    focusId = await resolveFocusId()
    token = await promptHidden('Token PRINCIPAL da Focus (entrada oculta): ')
  }
  if (!token) throw new Error('Token vazio.')

  if (has('--consultar')) {
    const { status, json } = await focus('GET', `/v2/empresas/${encodeURIComponent(focusId)}`, token)
    console.log('HTTP', status)
    console.log(status === 200 ? JSON.stringify(pick(json), null, 2) : JSON.stringify(json).slice(0, 400))
    if (status === 200) console.log(`\nRazão social já é "${RAZAO_SOCIAL}"? ${String(json.razao_social ?? json.nome ?? '').toUpperCase() === RAZAO_SOCIAL}`)
    return
  }

  const payload = buildDryRunPayload()
  console.log('Enviando PUT ?dry_run=1 (simulação, nada é gravado) com:\n' + JSON.stringify(payload, null, 2))
  const { status, json } = await focus('PUT', `/v2/empresas/${encodeURIComponent(focusId)}?dry_run=1`, token, payload)
  console.log('HTTP', status)
  console.log(JSON.stringify(typeof json === 'object' && json && 'id' in json ? pick(json) : json).slice(0, 600))
}

main().catch((e) => { console.error('Erro:', e.message); process.exit(1) })
