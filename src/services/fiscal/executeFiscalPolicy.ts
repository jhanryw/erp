/**
 * Executor da decisão do Motor Fiscal Configurável (Fase 1, seção 2 do
 * pedido: `policy = resolveFiscalOperation(sale)` depois
 * `executeFiscalPolicy(policy)`). Único ponto que efetivamente CHAMA a
 * transmissão fiscal (`submitNfceHomologacao`/`submitNfeHomologacao`) a
 * partir de uma decisão já resolvida — nunca decide por conta própria,
 * só executa o que `resolveFiscalOperation` mandou.
 *
 * Reaproveita 100% da infraestrutura de idempotência/claim/lease já
 * validada (Fase Fiscal 3B/4) — este módulo não sabe nada sobre isso, só
 * chama os serviços de emissão como sempre foram chamados.
 *
 * SEMPRE não-fatal: uma falha aqui nunca derruba a resposta de quem
 * chamou — a venda já foi criada com sucesso antes deste ponto.
 */

import { logError } from '@/lib/errors/log'
import { buildFiscalRecipientInput, type FiscalRecipientPayload, type DeliveryRecipientPayload } from './buildFiscalRecipientInput'
import { upsertSaleRecipient } from './upsertSaleRecipient'
import { submitNfeHomologacao } from './submitNfeHomologacao'
import { submitNfceHomologacao } from './submitNfceHomologacao'
import type { FiscalOperationDecision } from '@/lib/fiscal/resolveFiscalOperationDecision'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

export interface FiscalEmissionResult {
  requested: 'nfce' | 'nfe'
  status: string
  reason: string | null
  fiscal_document_id: number | null
  validation_errors: { code: string; message: string }[]
  /** Caminho RELATIVO do DANFE da Focus (`emission.data.danfePath`) — só presente quando `status === 'authorized'` e a Focus já persistiu o link. Usado por resolvePostSalePrintTarget pra abrir o DANFE oficial em vez do comprovante. */
  danfe_path: string | null
  /**
   * Ambiente REAL do documento (`emission.data.environment` —
   * `fiscal_documents.environment`, nunca um literal fixo). `null` só nos
   * ramos onde a emissão nem chegou a rodar de fato (falha de API antes
   * de `emission.data` existir, ou bloqueio de elegibilidade/config) —
   * nesses casos `status` nunca é `'authorized'`, então
   * `resolvePostSalePrintTarget` nunca precisa deste campo ali.
   */
  environment: FocusEnvironment | null
}

export interface ExecuteFiscalPolicyResult {
  /** `null` quando a decisão não tentou emitir nada (fiscal_disabled/skipped_by_operator com policy ausente de motivo) — mesma semântica que já existia. */
  fiscalResult: FiscalEmissionResult | null
}

export async function executeFiscalPolicy(params: {
  saleId: number
  companyId: number
  decision: FiscalOperationDecision
  fiscalRecipient?: FiscalRecipientPayload | null
  deliveryRecipient?: DeliveryRecipientPayload | null
}): Promise<ExecuteFiscalPolicyResult> {
  const { saleId, companyId, decision, fiscalRecipient, deliveryRecipient } = params

  if (decision.attempt) {
    const requested = decision.attempt
    try {
      const recipientInput = buildFiscalRecipientInput(fiscalRecipient ?? null, deliveryRecipient ?? null)
      if (recipientInput) {
        const recipientResult = await upsertSaleRecipient(saleId, companyId, recipientInput)
        if (!recipientResult.ok) {
          logError({ route: 'executeFiscalPolicy (fiscal recipient)', err: new Error(recipientResult.error), context: { sale_id: saleId } })
        }
      }

      const emission = requested === 'nfce'
        ? await submitNfceHomologacao(saleId, companyId)
        : await submitNfeHomologacao(saleId, companyId)

      return {
        fiscalResult: emission.ok
          ? { requested, status: emission.data.status, reason: null, fiscal_document_id: emission.data.fiscalDocumentId, validation_errors: emission.data.validationErrors, danfe_path: emission.data.danfePath, environment: emission.data.environment }
          : { requested, status: 'error', reason: emission.error, fiscal_document_id: null, validation_errors: [], danfe_path: null, environment: null },
      }
    } catch (fiscalErr) {
      logError({ route: 'executeFiscalPolicy (fiscal emission)', err: fiscalErr, context: { sale_id: saleId, requested } })
      return {
        fiscalResult: { requested, status: 'error', reason: 'Erro inesperado ao tentar emitir — tente novamente na tela da venda.', fiscal_document_id: null, validation_errors: [], danfe_path: null, environment: null },
      }
    }
  }

  // Só reporta quando havia intenção real de emitir (bloqueio de
  // elegibilidade ou configuração incompleta) — nunca quando o motivo é
  // simplesmente fiscal desligado ou o operador pediu 'none' de propósito
  // (nesses casos `decision.reason` já é `null` por construção).
  if (decision.reason) {
    return {
      fiscalResult: {
        requested: 'nfce', status: decision.status, reason: decision.reason,
        fiscal_document_id: null, validation_errors: [], danfe_path: null, environment: null,
      },
    }
  }

  return { fiscalResult: null }
}
