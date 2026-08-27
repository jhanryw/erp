/**
 * Orquestrador I/O do Motor Fiscal Configurável (Fase 1) — carrega a
 * política real de `fiscal_operation_policies` e combina com
 * `resolveOperationType`/`resolveFiscalOperationDecision` (puros). Único
 * módulo desta camada que toca o banco — mesma separação I/O-vs-puro já
 * usada em `loadSaleFiscalContext.ts` vs `buildNfePayload.ts`.
 *
 * Ponto de entrada CENTRAL e reutilizável (seção 4 do pedido) — chamado
 * pelos 3 lugares que criam vendas fiscalmente relevantes: PDV
 * (`POST /api/vendas`), webhook Nuvemshop, checkout de atacado. Nenhum
 * deles decide fiscal por conta própria — todos delegam pra cá.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveOperationType, type FiscalOperationType } from '@/lib/fiscal/resolveOperationType'
import {
  resolveFiscalOperationDecision,
  type FiscalOperationDecision,
  type FiscalOperationPolicy,
  type FiscalOperatorChoice,
} from '@/lib/fiscal/resolveFiscalOperationDecision'

export interface ResolveFiscalOperationInput {
  companyId: number
  saleType: string | null | undefined
  saleOrigin: string | null | undefined
  deliveryMode: string | null | undefined
  operatorChoice: FiscalOperatorChoice
}

/**
 * Lê a política da empresa pra uma operação — `null` quando não existe
 * linha (seção 38: fallback seguro é `configuration_missing`, nunca
 * presumir um comportamento). Nunca lança.
 */
export async function loadCompanyFiscalPolicy(
  companyId: number,
  operationType: FiscalOperationType,
): Promise<FiscalOperationPolicy | null> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('fiscal_operation_policies')
    .select('fiscal_enabled, document_mode, auto_issue, auto_print, print_non_fiscal_receipt, manual_issue_allowed')
    .eq('company_id', companyId)
    .eq('operation_type', operationType)
    .maybeSingle() as {
      data: {
        fiscal_enabled: boolean; document_mode: string; auto_issue: boolean
        auto_print: boolean; print_non_fiscal_receipt: boolean; manual_issue_allowed: boolean
      } | null
    }

  if (!data) return null

  return {
    fiscalEnabled: data.fiscal_enabled,
    documentMode: data.document_mode as FiscalOperationPolicy['documentMode'],
    autoIssue: data.auto_issue,
    autoPrint: data.auto_print,
    printNonFiscalReceipt: data.print_non_fiscal_receipt,
    manualIssueAllowed: data.manual_issue_allowed,
  }
}

export async function resolveFiscalOperation(input: ResolveFiscalOperationInput): Promise<FiscalOperationDecision> {
  const operationType = resolveOperationType({
    saleType: input.saleType,
    saleOrigin: input.saleOrigin,
    deliveryMode: input.deliveryMode,
  })

  const policy = operationType ? await loadCompanyFiscalPolicy(input.companyId, operationType) : null

  return resolveFiscalOperationDecision({
    operationType,
    policy,
    operatorChoice: input.operatorChoice,
    deliveryMode: input.deliveryMode,
    saleOrigin: input.saleOrigin,
  })
}
