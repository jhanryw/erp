/**
 * Motor Fiscal Configurável — Fase 2: certificado digital (A1) + CSC.
 *
 * Reaproveita 100% da infra de secrets já existente e auditada
 * (`company_integrations` + `integration_secrets` + AES-256-GCM em
 * `secretCipher.ts`) sob o provider `'fiscal_certificate'` — não é uma
 * integração externa de verdade, é o "cofre" desta empresa pra PFX+senha+
 * CSC Token. Zero tabela nova pra segredos (migration 202609051100 só
 * ampliou o CHECK de `provider` e adicionou METADADOS não-secretos em
 * `company_fiscal_settings`).
 *
 * REGRA CRÍTICA (seção 22 do pedido): o PFX bruto e a senha NUNCA saem
 * cifrados só em base64 — sempre passam por `encryptSecret`/
 * `decryptSecret` (AES-256-GCM, chave mestra só em env var). Este service
 * nunca retorna o PFX/senha/CSC Token pra quem chama fora de
 * `validateStoredCertificate` (que precisa decifrar pra reabrir o PKCS#12,
 * mas nunca repassa o valor decifrado adiante — só usa e descarta).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  getCompanyIntegration,
  createCompanyIntegration,
  updateCompanyIntegration,
} from '@/services/integrations/company-integrations.service'
import { setIntegrationSecret, getIntegrationSecret } from '@/services/integrations/secrets.service'
import { parsePkcs12, Pkcs12ParseError, type ParsedCertificateMetadata } from '@/lib/fiscal/certificate/parsePkcs12'
import { syncFocusEmpresa } from './focusEmpresa.service'
import type { ServiceOutcome } from '@/services/produtos.service'

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

const CERT_PROVIDER = 'fiscal_certificate' as const

/** Máximo aceito pro upload — certificados A1 reais têm poucos KB; generoso o bastante sem permitir abuso. */
export const MAX_CERTIFICATE_FILE_SIZE_BYTES = 16 * 1024

export interface CertificateMetadataResult {
  status: 'not_configured' | 'valid' | 'expired' | 'invalid' | 'replaced'
  subject: string | null
  cnpj: string | null
  issuer: string | null
  serial: string | null
  validFrom: string | null
  validUntil: string | null
  fingerprint: string | null
  uploadedAt: string | null
  /** `true` quando o CNPJ extraído do certificado diverge do CNPJ cadastrado da empresa — nunca bloqueia, só avisa (item 53). */
  cnpjMismatch: boolean
}

/**
 * Resultado da tentativa de `syncFocusEmpresa` — NUNCA colapsado com o
 * resultado local. `error`/`lastError` refletem qualquer motivo (integração
 * Focus inexistente, master_token ausente, CNPJ/CRT faltando, erro HTTP da
 * Focus) — quem chama decide como exibir, mas o contrato nunca finge que
 * "salvou localmente" equivale a "sincronizado com a Focus".
 */
export interface FocusSyncOutcome {
  status: 'success' | 'error'
  lastError: string | null
}

function toFocusSyncOutcome(result: ServiceOutcome<unknown>): FocusSyncOutcome {
  return result.ok ? { status: 'success', lastError: null } : { status: 'error', lastError: result.error }
}

/**
 * Get-or-create da linha `company_integrations` que serve de cofre pra
 * esta empresa. Sem `UNIQUE(company_id, provider)` no banco (decisão de
 * schema documentada em `20260817_integration_foundation_schema.sql` —
 * uma empresa PODE ter várias integrações do mesmo provider, ex. 2 lojas
 * Nuvemshop), então esta função busca a mais recente e reaproveita — nunca
 * cria uma segunda linha pra "fiscal_certificate" por engano num re-upload.
 */
async function getOrCreateCertificateVault(companyId: number, userId: string): Promise<ServiceOutcome<number>> {
  const existing = await getCompanyIntegration(companyId, CERT_PROVIDER)
  if (!existing.ok) return failure(existing.error, existing.status)
  if (existing.data) return success(existing.data.id)

  const created = await createCompanyIntegration({ companyId, provider: CERT_PROVIDER, settings: {}, createdBy: userId })
  if (!created.ok) return failure(created.error, created.status)
  return success(created.data.id)
}

function toCertificateStatus(metadata: ParsedCertificateMetadata): 'valid' | 'expired' {
  return new Date(metadata.validUntil).getTime() < Date.now() ? 'expired' : 'valid'
}

async function persistCertificateMetadata(
  companyId: number,
  status: CertificateMetadataResult['status'],
  metadata: ParsedCertificateMetadata | null,
): Promise<ServiceOutcome<void>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('company_fiscal_settings')
    .update({
      certificate_status: status,
      certificate_subject: metadata?.subject ?? null,
      certificate_cnpj: metadata?.cnpj ?? null,
      certificate_issuer: metadata?.issuer ?? null,
      certificate_serial: metadata?.serialNumber ?? null,
      certificate_fingerprint: metadata?.fingerprint ?? null,
      certificate_valid_from: metadata?.validFrom ?? null,
      certificate_valid_until: metadata?.validUntil ?? null,
      certificate_uploaded_at: metadata ? new Date().toISOString() : null,
    })
    .eq('company_id', companyId)
    .select('company_id')
    .maybeSingle()

  if (error) return failure(error.message)
  if (!data) return failure('Nenhum registro em company_fiscal_settings para esta empresa — cadastre os dados fiscais básicos antes de enviar o certificado.', 422)
  return success(undefined)
}

/**
 * Fluxo completo de upload (seções 21-24, 51 do pedido):
 * valida formato/senha → extrai metadata → REJEITA se não houver chave
 * privada (inútil pra assinar) → cifra e persiste PFX+senha → grava
 * metadata não-secreta. Nunca apaga um certificado anterior ANTES de
 * confirmar que o novo é válido (a validação acontece primeiro; só then
 * o UPDATE roda) — mas como o schema atual é 1-linha-por-empresa (sem
 * histórico de certificados substituídos), "substituição" aqui significa
 * sobrescrever a metadata/segredo atual, nunca dois certificados
 * coexistindo. Se histórico de certificados vier a ser necessário no
 * futuro, isso exige uma tabela nova — meta 'replaced' documentado hoje
 * só como valor possível de `certificate_status`, sem uso real ainda.
 */
export interface UploadCertificateResult {
  local: CertificateMetadataResult
  focus: FocusSyncOutcome
}

export async function uploadCertificate(params: {
  companyId: number
  userId: string
  pfxBuffer: Buffer
  password: string
}): Promise<ServiceOutcome<UploadCertificateResult>> {
  let metadata: ParsedCertificateMetadata
  try {
    metadata = parsePkcs12(params.pfxBuffer, params.password)
  } catch (err) {
    if (err instanceof Pkcs12ParseError) return failure(err.message, 422)
    throw err
  }

  if (!metadata.hasPrivateKey) {
    return failure('O arquivo contém um certificado, mas nenhuma chave privada — não pode ser usado para assinar documentos fiscais.', 422)
  }

  const vault = await getOrCreateCertificateVault(params.companyId, params.userId)
  if (!vault.ok) return failure(vault.error, vault.status)
  const integrationId = vault.data

  const pfxSaved = await setIntegrationSecret(integrationId, params.companyId, 'certificate_pfx_b64', params.pfxBuffer.toString('base64'))
  if (!pfxSaved.ok) return failure(pfxSaved.error, pfxSaved.status)

  const passwordSaved = await setIntegrationSecret(integrationId, params.companyId, 'certificate_password', params.password)
  if (!passwordSaved.ok) return failure(passwordSaved.error, passwordSaved.status)

  await updateCompanyIntegration(integrationId, params.companyId, { status: 'active' })

  const status = toCertificateStatus(metadata)
  const persisted = await persistCertificateMetadata(params.companyId, status, metadata)
  if (!persisted.ok) return failure(persisted.error, persisted.status)

  const admin = createAdminClient()
  const { data: settings } = await (admin as any)
    .from('company_fiscal_settings')
    .select('cnpj')
    .eq('company_id', params.companyId)
    .maybeSingle() as { data: { cnpj: string | null } | null }

  const cnpjMismatch = !!(metadata.cnpj && settings?.cnpj && metadata.cnpj !== settings.cnpj.replace(/\D/g, ''))

  const local: CertificateMetadataResult = {
    status, subject: metadata.subject, cnpj: metadata.cnpj, issuer: metadata.issuer,
    serial: metadata.serialNumber, validFrom: metadata.validFrom, validUntil: metadata.validUntil,
    fingerprint: metadata.fingerprint, uploadedAt: new Date().toISOString(), cnpjMismatch,
  }

  // O certificado já está salvo localmente (cifrado) a esta altura —
  // qualquer falha daqui pra frente é só de SINCRONIZAÇÃO com a Focus,
  // nunca desfaz o salvamento local nem é reportada como se fosse.
  const focusResult = await syncFocusEmpresa(params.companyId, {
    certificate: { arquivoBase64: params.pfxBuffer.toString('base64'), senha: params.password },
  })

  return success({ local, focus: toFocusSyncOutcome(focusResult) })
}

/**
 * "Validar certificado" (seção 53) — reabre o PFX já armazenado com a
 * senha já armazenada, SEM transmitir nada fiscal. Útil pra confirmar que
 * o certificado continua íntegro/dentro da validade sem precisar
 * reenviar o arquivo.
 */
export async function validateStoredCertificate(companyId: number): Promise<ServiceOutcome<CertificateMetadataResult>> {
  const integration = await getCompanyIntegration(companyId, CERT_PROVIDER)
  if (!integration.ok) return failure(integration.error, integration.status)
  if (!integration.data) return failure('Nenhum certificado configurado para esta empresa.', 404)

  const [pfxResult, passwordResult] = await Promise.all([
    getIntegrationSecret(integration.data.id, companyId, 'certificate_pfx_b64'),
    getIntegrationSecret(integration.data.id, companyId, 'certificate_password'),
  ])
  if (!pfxResult.ok) return failure(pfxResult.error, pfxResult.status)
  if (!passwordResult.ok) return failure(passwordResult.error, passwordResult.status)
  if (!pfxResult.data || !passwordResult.data) return failure('Certificado incompleto no cofre desta empresa — refaça o upload.', 404)

  let metadata: ParsedCertificateMetadata
  try {
    metadata = parsePkcs12(Buffer.from(pfxResult.data, 'base64'), passwordResult.data)
  } catch (err) {
    const message = err instanceof Pkcs12ParseError ? err.message : 'Falha ao validar certificado armazenado.'
    await persistCertificateMetadata(companyId, 'invalid', null)
    return failure(message, 422)
  }

  const status = toCertificateStatus(metadata)
  const persisted = await persistCertificateMetadata(companyId, status, metadata)
  if (!persisted.ok) return failure(persisted.error, persisted.status)

  return success({
    status, subject: metadata.subject, cnpj: metadata.cnpj, issuer: metadata.issuer,
    serial: metadata.serialNumber, validFrom: metadata.validFrom, validUntil: metadata.validUntil,
    fingerprint: metadata.fingerprint, uploadedAt: new Date().toISOString(), cnpjMismatch: false,
  })
}

/**
 * CSC (seção 28) — `cscId` é identificador, não-secreto, vai em
 * `company_fiscal_settings.csc_id`. `cscToken` é secreto, cifrado no MESMO
 * cofre do certificado (`integration_secrets`, key='csc_token') — nunca
 * retornado integralmente depois de salvo (a rota GET só devolve os
 * últimos 4 caracteres mascarados, ver `getCscMasked`).
 *
 * `environment` é OBRIGATÓRIO, sem default e vem SEMPRE explicitamente de
 * quem chama (a UI exige a escolha) — ACHADO REAL (incidente de produção):
 * a versão anterior desta função INFERIA o ambiente de
 * `company_integrations.settings.environment` (provider='focus_nfe'), um
 * campo que representa o ambiente de EMISSÃO ATIVO, nunca atualizado
 * depois da criação da integração (confirmado em
 * `focusCredentials.service.ts`: fica em 'homologacao' pra sempre, a
 * menos que a linha seja recriada). Um admin cadastrou o CSC de PRODUÇÃO
 * pela UI, mas como esse campo nunca tinha sido virado pra 'producao', a
 * função sincronizou como se fosse HOMOLOGAÇÃO — sobrescrevendo o par de
 * homologação real da empresa na Focus com os valores de produção. Nunca
 * mais infere: o ambiente sincronizado é exatamente o que o admin
 * escolheu nesta chamada, ponto.
 */
export interface SaveCscResult {
  local: { cscId: string }
  focus: FocusSyncOutcome
}

export async function saveCsc(params: { companyId: number; userId: string; environment: 'homologacao' | 'producao'; cscId: string; cscToken: string }): Promise<ServiceOutcome<SaveCscResult>> {
  const vault = await getOrCreateCertificateVault(params.companyId, params.userId)
  if (!vault.ok) return failure(vault.error, vault.status)

  const tokenSaved = await setIntegrationSecret(vault.data, params.companyId, 'csc_token', params.cscToken)
  if (!tokenSaved.ok) return failure(tokenSaved.error, tokenSaved.status)

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('company_fiscal_settings')
    .update({ csc_id: params.cscId })
    .eq('company_id', params.companyId)

  if (error) return failure(error.message)

  // O CSC é POR AMBIENTE na Focus (dois pares simultâneos na mesma
  // empresa) — `params.environment` decide qual par recebe o valor, nunca
  // os dois, nunca uma suposição.
  const focusResult = await syncFocusEmpresa(params.companyId, {
    csc: { environment: params.environment, cscId: params.cscId, cscToken: params.cscToken },
  })

  return success({ local: { cscId: params.cscId }, focus: toFocusSyncOutcome(focusResult) })
}

/** Nunca devolve o token completo — só os últimos 4 caracteres, pro admin confirmar "é este mesmo" sem reexpor o segredo (seção 28/54). */
export async function getCscMasked(companyId: number): Promise<ServiceOutcome<{ cscId: string | null; cscTokenMasked: string | null }>> {
  const admin = createAdminClient()
  const { data: settings, error: settingsError } = await (admin as any)
    .from('company_fiscal_settings')
    .select('csc_id')
    .eq('company_id', companyId)
    .maybeSingle() as { data: { csc_id: string | null } | null; error: { message: string } | null }
  if (settingsError) return failure(settingsError.message)

  const integration = await getCompanyIntegration(companyId, CERT_PROVIDER)
  if (!integration.ok) return failure(integration.error, integration.status)
  if (!integration.data) return success({ cscId: settings?.csc_id ?? null, cscTokenMasked: null })

  const tokenResult = await getIntegrationSecret(integration.data.id, companyId, 'csc_token')
  if (!tokenResult.ok) return failure(tokenResult.error, tokenResult.status)

  const masked = tokenResult.data ? `${'•'.repeat(12)}${tokenResult.data.slice(-4)}` : null
  return success({ cscId: settings?.csc_id ?? null, cscTokenMasked: masked })
}
