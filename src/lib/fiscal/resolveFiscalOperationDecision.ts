/**
 * Camada de decisão do Motor Fiscal Configurável (Fase 1) — combina a
 * POLÍTICA configurada pela empresa (`fiscal_operation_policies`, "o que o
 * cliente quer fazer") com o VALIDADOR LEGAL já existente
 * (`resolveFiscalDocumentType`, "se ele pode fazer") — seção 3 do pedido.
 * Módulo PURO: recebe a policy já carregada (I/O fica em
 * `resolveFiscalOperation.ts`), nunca lança, nunca faz fallback silencioso.
 *
 * A configuração do cliente NUNCA sobrepõe a legislação: mesmo com
 * `document_mode='nfce'` configurado, se `resolveFiscalDocumentType`
 * resolver para NF-e (ou `blocked`), o resultado é `eligibility_blocked` —
 * nunca troca de tipo silenciosamente, nunca ignora a regra legal.
 */

import {
  resolveFiscalDocumentType,
  describeFiscalDocumentTypeBlockReason,
  type ResolveFiscalDocumentTypeInput,
} from './resolveFiscalDocumentType'
import type { FiscalOperationType } from './resolveOperationType'

export type FiscalDocumentMode = 'auto' | 'nfce' | 'nfe' | 'none'

/** Espelha exatamente as colunas de `fiscal_operation_policies` — nomes em camelCase, valores brutos do banco. */
export interface FiscalOperationPolicy {
  fiscalEnabled: boolean
  documentMode: FiscalDocumentMode
  autoIssue: boolean
  autoPrint: boolean
  printNonFiscalReceipt: boolean
  manualIssueAllowed: boolean
}

/** Mesmo vocabulário de `fiscal_document_type` já usado no PDV — 'auto' é o default (Fase Fiscal 7), 'none' é override explícito do operador. */
export type FiscalOperatorChoice = 'auto' | 'none' | 'nfce' | 'nfe'

export type FiscalOperationStatus =
  | 'configuration_missing'
  | 'fiscal_disabled'
  | 'eligibility_blocked'
  | 'skipped_by_operator'
  | 'manual_issue_required'
  | 'emission_pending'

export interface FiscalOperationDecision {
  operationType: FiscalOperationType | null
  /** O que REALMENTE tentar emitir agora — só não-nulo quando `status === 'emission_pending'`. */
  attempt: 'nfce' | 'nfe' | null
  status: FiscalOperationStatus
  reason: string | null
  autoPrint: boolean
  printNonFiscalReceipt: boolean
  manualIssueAllowed: boolean
}

export interface ResolveFiscalOperationDecisionInput extends ResolveFiscalDocumentTypeInput {
  operationType: FiscalOperationType | null
  /** `null` = nenhuma linha em `fiscal_operation_policies` pra esta empresa+operação (seção 38: nunca emitir por suposição). */
  policy: FiscalOperationPolicy | null
  operatorChoice: FiscalOperatorChoice
}

function blockedResult(
  operationType: FiscalOperationType | null,
  status: FiscalOperationStatus,
  reason: string | null,
  policy: FiscalOperationPolicy | null,
): FiscalOperationDecision {
  return {
    operationType,
    attempt: null,
    status,
    reason,
    autoPrint: false,
    printNonFiscalReceipt: policy?.printNonFiscalReceipt ?? true, // fail-safe: sem policy, prefere garantir ALGUM comprovante ao cliente
    manualIssueAllowed: policy?.manualIssueAllowed ?? true,
  }
}

export function resolveFiscalOperationDecision(input: ResolveFiscalOperationDecisionInput): FiscalOperationDecision {
  const { operationType, policy, operatorChoice, ...resolverInput } = input

  if (operationType === null) {
    return blockedResult(null, 'configuration_missing', 'Não foi possível determinar o tipo de operação fiscal desta venda (dados de canal/origem/entrega inconsistentes).', null)
  }

  if (policy === null) {
    return blockedResult(operationType, 'configuration_missing', `Nenhuma política fiscal configurada para a operação "${operationType}" nesta empresa — configure em Configurações → Fiscal.`, null)
  }

  if (!policy.fiscalEnabled) {
    return blockedResult(operationType, 'fiscal_disabled', null, policy)
  }

  // Override explícito do operador pedindo pra NÃO emitir nada agora — nunca reporta motivo (silêncio intencional, mesmo comportamento da Fase Fiscal 7).
  if (operatorChoice === 'none') {
    return blockedResult(operationType, 'skipped_by_operator', null, policy)
  }

  const legalResolved = resolveFiscalDocumentType(resolverInput)

  // Override explícito do operador pedindo um tipo específico — só permitido
  // se `manual_issue_allowed`, e AINDA ASSIM passa pelo validador legal
  // (seção 3: configuração/escolha nunca sobrepõe legislação).
  if (operatorChoice === 'nfce' || operatorChoice === 'nfe') {
    if (!policy.manualIssueAllowed) {
      return blockedResult(operationType, 'manual_issue_required', 'Emissão manual não é permitida para esta operação — ajuste em Configurações → Fiscal se necessário.', policy)
    }
    if (operatorChoice === 'nfce' && legalResolved !== 'nfce') {
      const reason = legalResolved === 'blocked'
        ? describeFiscalDocumentTypeBlockReason(resolverInput)
        : 'Esta venda não é elegível para NFC-e (modalidade de entrega/origem indica NF-e) — emita NF-e na tela da venda.'
      return blockedResult(operationType, 'eligibility_blocked', reason, policy)
    }
    // NF-e nunca tem gate de elegibilidade prévio (mesmo comportamento de sempre).
    return {
      operationType, attempt: operatorChoice, status: 'emission_pending', reason: null,
      autoPrint: policy.autoPrint, printNonFiscalReceipt: policy.printNonFiscalReceipt, manualIssueAllowed: policy.manualIssueAllowed,
    }
  }

  // operatorChoice === 'auto' — segue a POLÍTICA configurada.
  if (policy.documentMode === 'none') {
    return blockedResult(operationType, 'manual_issue_required', 'Documento fiscal configurado como "Nenhum" para esta operação.', policy)
  }

  let desired: 'nfce' | 'nfe'
  if (policy.documentMode === 'auto') {
    if (legalResolved === 'blocked') {
      return blockedResult(operationType, 'eligibility_blocked', describeFiscalDocumentTypeBlockReason(resolverInput), policy)
    }
    desired = legalResolved
  } else {
    // documentMode === 'nfce' | 'nfe' — preferência explícita da empresa, ainda sujeita ao validador legal.
    if (policy.documentMode === 'nfce' && legalResolved !== 'nfce') {
      const reason = legalResolved === 'blocked'
        ? describeFiscalDocumentTypeBlockReason(resolverInput)
        : 'Esta venda não é elegível para NFC-e (modalidade de entrega/origem indica NF-e) — política da empresa pede NFC-e, mas a operação concreta não permite.'
      return blockedResult(operationType, 'eligibility_blocked', reason, policy)
    }
    desired = policy.documentMode
  }

  if (!policy.autoIssue) {
    return {
      operationType, attempt: null, status: 'manual_issue_required', reason: null,
      autoPrint: false, printNonFiscalReceipt: policy.printNonFiscalReceipt, manualIssueAllowed: policy.manualIssueAllowed,
    }
  }

  return {
    operationType, attempt: desired, status: 'emission_pending', reason: null,
    autoPrint: policy.autoPrint, printNonFiscalReceipt: policy.printNonFiscalReceipt, manualIssueAllowed: policy.manualIssueAllowed,
  }
}
