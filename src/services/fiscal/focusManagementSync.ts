/**
 * Rastreamento de sincronização com a Focus (Motor Fiscal Configurável —
 * Certificado/CSC). Guardado dentro de `company_integrations.settings`
 * (JSONB já existente, provider='focus_nfe') — zero migration, zero
 * tabela nova.
 *
 * TRÊS recursos rastreados de forma INDEPENDENTE (aprovado explicitamente
 * — sincronizar certificado não prova nada sobre CSC, e vice-versa):
 *   - company     → cadastro básico (CNPJ/razão social/endereço/CRT)
 *   - certificate → PFX/senha
 *   - csc.homologacao / csc.producao → CSC é POR AMBIENTE (a Focus guarda
 *     os dois pares simultaneamente na mesma empresa) — sincronizar CSC
 *     de homologação nunca marca produção como sincronizado, e vice-versa.
 */

import { updateCompanyIntegration } from '@/services/integrations/company-integrations.service'
import type { CompanyIntegration } from '@/services/integrations/company-integrations.service'
import type { ServiceOutcome } from '@/services/produtos.service'

export type FocusSyncStatus = 'success' | 'error'

export interface FocusSyncEntry {
  status: FocusSyncStatus
  lastSyncAt: string
  lastError: string | null
}

export interface FocusManagementSyncState {
  company?: FocusSyncEntry
  certificate?: FocusSyncEntry
  csc?: {
    homologacao?: FocusSyncEntry
    producao?: FocusSyncEntry
  }
}

export function makeSyncEntry(status: FocusSyncStatus, lastError: string | null = null): FocusSyncEntry {
  return { status, lastSyncAt: new Date().toISOString(), lastError }
}

/** Leitura pura — nunca lança, `{}` quando nada foi sincronizado ainda. */
export function readFocusManagementSync(settings: Record<string, unknown> | null | undefined): FocusManagementSyncState {
  const raw = settings?.focusManagementSync
  return (raw && typeof raw === 'object' ? raw : {}) as FocusManagementSyncState
}

export interface RecordFocusManagementSyncPatch {
  company?: FocusSyncEntry
  certificate?: FocusSyncEntry
  csc?: { environment: 'homologacao' | 'producao'; entry: FocusSyncEntry }
}

/**
 * Merge-update — nunca sobrescreve os outros 2 recursos ao gravar um
 * (lê o estado atual, funde só o campo alterado). `integration` precisa
 * vir de uma leitura recente (`getCompanyIntegration`) pra `settings`
 * refletir o estado real — nunca reconstruído do zero aqui.
 */
export async function recordFocusManagementSync(
  companyId: number,
  integration: Pick<CompanyIntegration, 'id' | 'settings'>,
  patch: RecordFocusManagementSyncPatch,
): Promise<ServiceOutcome<void>> {
  const current = readFocusManagementSync(integration.settings)
  const merged: FocusManagementSyncState = {
    ...current,
    ...(patch.company ? { company: patch.company } : {}),
    ...(patch.certificate ? { certificate: patch.certificate } : {}),
    ...(patch.csc ? { csc: { ...current.csc, [patch.csc.environment]: patch.csc.entry } } : {}),
  }

  return updateCompanyIntegration(integration.id, companyId, {
    settings: { ...integration.settings, focusManagementSync: merged },
  }).then((r) => (r.ok ? { ok: true, data: undefined } : r))
}
