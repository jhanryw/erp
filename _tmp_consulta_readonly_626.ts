/**
 * Script de diagnóstico READ-ONLY — NUNCA emite, NUNCA faz POST.
 * Só consulta a Focus (GET) pela provider_ref da venda 626 e imprime o
 * retorno bruto (exceto token/segredo). Rode com:
 *
 *   npx tsx _tmp_consulta_readonly_626.ts
 *
 * Apague este arquivo depois de usar (mesmo padrão do script de
 * diagnóstico anterior desta fase).
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// Parser manual do .env.local — dotenv/shell quebram com valores contendo
// parênteses (mesmo problema já encontrado nesta fase).
const envPath = join(process.cwd(), '.env.local')
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (!m) continue
  const [, key, rawValue] = m
  const value = rawValue.replace(/^['"]|['"]$/g, '')
  if (!process.env[key]) process.env[key] = value
}

async function main() {
  const { createAdminClient } = await import('./src/lib/supabase/admin')
  const { resolveFocusIntegration } = await import('./src/services/fiscal/resolveFocusIntegration')
  const { consultFocusNfce } = await import('./src/lib/integrations/focus/httpClient')

  const COMPANY_ID = 1
  const PROVIDER_REF = 'qarvon-1-626-nfce'

  const admin = createAdminClient()

  const { data: doc } = await (admin as any)
    .from('fiscal_documents')
    .select('id, status, status_sefaz, status_message, submission_started_at, submission_lease_until, submission_attempts')
    .eq('company_id', COMPANY_ID)
    .eq('sale_id', 626)
    .eq('document_type', 'nfce')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  console.log('--- fiscal_documents ANTES da consulta ---')
  console.log(doc)

  const integrationResult = await resolveFocusIntegration(COMPANY_ID)
  if (!integrationResult.ok || !integrationResult.data.available) {
    console.error('Integração Focus indisponível:', integrationResult)
    return
  }
  const { token, environment } = integrationResult.data.integration

  console.log(`\n--- GET /v2/nfce/${PROVIDER_REF} (ambiente: ${environment}) ---`)
  try {
    const response = await consultFocusNfce(PROVIDER_REF, { token, environment })
    console.log('status Focus:', response.status)
    console.log('status_sefaz:', response.status_sefaz)
    console.log('mensagem_sefaz:', response.mensagem_sefaz)
    console.log('chave_nfe (bruta):', response.chave_nfe)
    console.log('chave_nfe comprimento:', response.chave_nfe?.length ?? null)
    console.log('numero:', response.numero)
    console.log('serie:', response.serie)
    console.log('numero_protocolo:', response.numero_protocolo)
    console.log('caminho_xml_nota_fiscal:', response.caminho_xml_nota_fiscal)
    console.log('caminho_danfe:', response.caminho_danfe)
    console.log('\n--- resposta completa (sem token) ---')
    console.log(JSON.stringify(response, null, 2))
  } catch (err) {
    console.error('Erro na consulta:', err)
  }

  console.log('\n(Nada foi escrito no banco por este script — é 100% leitura.)')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
