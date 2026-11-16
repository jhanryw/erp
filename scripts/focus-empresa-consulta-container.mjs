#!/usr/bin/env node
/**
 * CONSULTA SOMENTE LEITURA do cadastro da empresa 1 na Focus NFe — pensada para rodar
 * DENTRO do container do ERP (usa as variáveis de ambiente que ele já tem).
 *
 *   - Lê a integração e o `master_token` CIFRADO de company_integrations / integration_secrets
 *     (REST do Supabase, chave de serviço do container).
 *   - Decifra em memória (AES-256-GCM, mesmo formato de src/lib/security/secretCipher.ts:
 *     base64(iv[12] || authTag[16] || dados)). O token nunca é impresso nem gravado.
 *   - Faz UM `GET /v2/empresas/{id}` e imprime só: razão social, CRT, série e próximo número
 *     de NF-e em produção. Nenhuma outra chamada; não existe PUT/POST neste arquivo.
 */
import { createDecipheriv } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const COMPANY_ID = 1
const EXPECTED_NAME = 'SANTTORINI LINGERIE LTDA'

/** Mesmo formato de secretCipher.decryptSecret (chave: INTEGRATION_SECRETS_MASTER_KEY_V<versão>). */
export function decryptSecret(ciphertext, keyVersion, env = process.env) {
  const raw = env[`INTEGRATION_SECRETS_MASTER_KEY_V${keyVersion}`]
  if (!raw) throw new Error(`chave mestra V${keyVersion} ausente no ambiente`)
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('chave mestra com tamanho inválido')
  const packed = Buffer.from(ciphertext, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(12, 28))
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
}

export function summarizeEmpresa(e) {
  const nome = e.razao_social ?? e.nome ?? null
  return {
    razao_social: nome,
    razao_social_confere: String(nome ?? '').toUpperCase() === EXPECTED_NAME,
    crt: e.regime_tributario ?? null,
    serie_nfe_producao: e.serie_nfe_producao ?? null,
    proximo_numero_nfe_producao: e.proximo_numero_nfe_producao ?? null,
  }
}

const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().toUpperCase())
/** Compara, campo a campo, o que o ERP enviaria (company_fiscal_settings) com o cadastro atual da Focus. Só dados cadastrais da empresa. */
export function diffCadastro(erp, focus) {
  const pares = [
    ['razao_social', erp.razao_social, focus.razao_social ?? focus.nome],
    ['nome_fantasia', erp.nome_fantasia, focus.nome_fantasia],
    ['inscricao_estadual', erp.inscricao_estadual, focus.inscricao_estadual],
    ['regime_tributario(crt)', erp.crt, focus.regime_tributario],
    ['logradouro', erp.logradouro, focus.logradouro],
    ['numero', erp.numero_endereco, focus.numero],
    ['complemento', erp.complemento, focus.complemento],
    ['bairro', erp.bairro, focus.bairro],
    ['municipio', erp.municipio, focus.municipio],
    ['uf', erp.uf, focus.uf],
    ['cep', erp.cep, focus.cep],
    ['email', erp.email, focus.email],
    ['telefone', erp.telefone, focus.telefone],
  ]
  return pares.filter(([, a, b]) => norm(a).replace(/\D/g, '') !== norm(b).replace(/\D/g, '') || (isNaN(Number(norm(a))) && norm(a) !== norm(b)))
    .map(([campo, erp_valor, focus_valor]) => ({ campo, erp: erp_valor ?? null, focus: focus_valor ?? null }))
}

async function rest(env, path) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  })
  if (!res.ok) throw new Error(`falha ao ler o banco (HTTP ${res.status})`)
  return res.json()
}

/** Lê a integração da empresa 1 e devolve { focusId, token } — token só em memória. */
export async function loadMasterToken(env = process.env) {
  for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[k]) throw new Error(`variável ${k} ausente — rode dentro do container do ERP`)
  }
  const [integ] = await rest(env, `company_integrations?select=id,external_account_id&company_id=eq.${COMPANY_ID}&provider=eq.focus_nfe`)
  if (!integ?.external_account_id) throw new Error('integração Focus (external_account_id) não encontrada')
  const [sec] = await rest(env, `integration_secrets?select=ciphertext,key_version&integration_id=eq.${integ.id}&company_id=eq.${COMPANY_ID}&key=eq.master_token`)
  if (!sec) throw new Error('master_token não encontrado')
  return { focusId: String(integ.external_account_id), token: decryptSecret(sec.ciphertext, sec.key_version, env) }
}

async function main(env = process.env) {
  const { focusId, token } = await loadMasterToken(env)

  const res = await fetch(`https://api.focusnfe.com.br/v2/empresas/${encodeURIComponent(focusId)}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}` },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`Focus respondeu HTTP ${res.status}${typeof body?.codigo === 'string' ? ` (${body.codigo})` : ''}`)
  }
  const empresa = await res.json()
  console.log(JSON.stringify(summarizeEmpresa(empresa), null, 2))
  if (process.argv.includes('--comparar')) {
    const [erp] = await rest(env, `company_fiscal_settings?select=razao_social,nome_fantasia,inscricao_estadual,crt,logradouro,numero_endereco,complemento,bairro,municipio,uf,cep,email,telefone&company_id=eq.${COMPANY_ID}`)
    console.log('Diferenças ERP x Focus (o que a sincronização alteraria):')
    console.log(JSON.stringify(diffCadastro(erp ?? {}, empresa), null, 2))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Erro:', e.message); process.exit(1) })
}
