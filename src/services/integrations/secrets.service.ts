/**
 * Service de Integrações — Secrets (Fase 2).
 *
 * Único ponto de acesso a `integration_secrets`. Deliberadamente separado
 * de `company-integrations.service.ts` (seção 14 do pedido da Fase 2):
 * nenhuma função de integração "normal" (getCompanyIntegration,
 * listCompanyIntegrations) retorna segredo — só as duas funções deste
 * arquivo, que quem chama precisa importar e invocar explicitamente.
 *
 * `getIntegrationSecret` decifra e retorna o valor em texto puro — quem
 * chama é responsável por nunca logar, nunca serializar em resposta JSON,
 * nunca passar pra client component. Ver `secretCipher.ts` pro threat model
 * completo da criptografia em si.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { encryptSecret, decryptSecret } from '@/lib/security/secretCipher'
import type { ServiceOutcome } from '../produtos.service'

// ─── Helpers internos ─────────────────────────────────────────────────────────

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

interface IntegrationSecretRow {
  id: number
  integration_id: number
  company_id: number
  key: string
  ciphertext: string
  key_version: number
}

// ─── Operações ─────────────────────────────────────────────────────────────────

/**
 * Cria ou rotaciona (upsert por `(integration_id, key)`) um segredo. Cifra
 * com a master key corrente antes de gravar — nunca recebe nem grava
 * plaintext no banco.
 */
export async function setIntegrationSecret(
  integrationId: number,
  companyId: number,
  key: string,
  plaintext: string,
): Promise<ServiceOutcome<void>> {
  const trimmedKey = key.trim()
  if (!trimmedKey) return failure('Chave do segredo é obrigatória.', 422)
  if (!plaintext) return failure('Valor do segredo é obrigatório.', 422)

  const admin = createAdminClient()

  // Confirma posse antes de gravar — mesmo padrão de
  // personAndCustomerBelongToCompany (crm/person-customer-links.service.ts).
  const { data: integration } = await (admin as any)
    .from('company_integrations')
    .select('id')
    .eq('id', integrationId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: number } | null }
  if (!integration) return failure('Integração não encontrada nesta empresa.', 404)

  const { ciphertext, keyVersion } = encryptSecret(plaintext)

  const { error } = await (admin as any)
    .from('integration_secrets')
    .upsert(
      {
        integration_id: integrationId,
        company_id: companyId,
        key: trimmedKey,
        ciphertext,
        key_version: keyVersion,
      },
      { onConflict: 'integration_id,key' },
    ) as { error: { message: string } | null }

  if (error) return failure(error.message)
  return success(undefined)
}

/**
 * Decifra e retorna o segredo em texto puro. `null` quando não configurado
 * — nunca lança por ausência (chamador decide se isso é erro no contexto
 * dele). Sempre escopado por `companyId`, nunca só por `integrationId`.
 */
export async function getIntegrationSecret(
  integrationId: number,
  companyId: number,
  key: string,
): Promise<ServiceOutcome<string | null>> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('integration_secrets')
    .select('ciphertext, key_version')
    .eq('integration_id', integrationId)
    .eq('company_id', companyId)
    .eq('key', key.trim())
    .maybeSingle() as { data: Pick<IntegrationSecretRow, 'ciphertext' | 'key_version'> | null; error: { message: string } | null }

  if (error) return failure(error.message)
  if (!data) return success(null)

  try {
    return success(decryptSecret(data.ciphertext, data.key_version))
  } catch (err) {
    return failure(`Falha ao decifrar segredo (${key}): ${err instanceof Error ? err.message : 'erro desconhecido'}`)
  }
}
