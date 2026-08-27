/**
 * Decide o que a emissão automática do PDV deve tentar ao fechar uma venda
 * — Fase Fiscal 7 (automatismo). Envolve `resolveFiscalDocumentType` (que
 * continua sendo só a resolução NF-e/NFC-e por entrega/origem, sem saber
 * nada de atacado — ver comentário lá) com a política de automatismo:
 *
 *   - `operatorChoice === 'none'`   → nunca emite nada (override explícito).
 *   - `operatorChoice === 'nfe'`    → sempre tenta NF-e (nunca tem gate de
 *     elegibilidade nem de atacado — mesmo comportamento de sempre).
 *   - venda de ATACADO (`saleType === 'wholesale'`)  → automatismo
 *     BLOQUEADO pra NFC-e, mesmo que o operador peça explicitamente.
 *     Exceção legal, não lacuna técnica: a definição estrutural de NFC-e
 *     (Ajuste SINIEF 07/2005) é "consumidor final, sem geração de crédito
 *     fiscal ao adquirente". O ERP não tem hoje nenhum campo que capture
 *     se ESTA venda de atacado especificamente gera esse crédito (CNPJ por
 *     si só deixou de ser bloqueio legal — Ajuste SINIEF nº 12/2026 revogou
 *     a vedação de NFC-e contra CNPJ — mas a exigência de "sem crédito
 *     fiscal" é anterior e independente disso, e continua valendo). Decisão
 *     de negócio (2026-08-27, aprovada em chat): nunca presumir, sempre
 *     deixar pendente pra emissão manual de NF-e.
 *   - `operatorChoice === 'auto'` (novo default — venda comum do ERP não
 *     pode mais depender do vendedor lembrar de clicar em "Emitir NFC-e")
 *     → tenta automaticamente o tipo resolvido, ou fica pendente
 *     (`attempt: null`) se os dados forem ambíguos demais pra resolver.
 *   - `operatorChoice === 'nfce'` explícito → mesmo assim passa pelo gate
 *     de elegibilidade (nunca troca de tipo silenciosamente, mesma
 *     filosofia já usada na Fase Fiscal 6).
 */

import {
  resolveFiscalDocumentType,
  describeFiscalDocumentTypeBlockReason,
  type ResolveFiscalDocumentTypeInput,
} from './resolveFiscalDocumentType'

export type FiscalEmissionOperatorChoice = 'auto' | 'none' | 'nfce' | 'nfe'

export interface ResolveAutomaticFiscalEmissionInput extends ResolveFiscalDocumentTypeInput {
  /** `sales.sale_type` — bruto, não interpretado (mesma filosofia de `saleOrigin` em resolveFiscalDocumentType). */
  saleType: string | null | undefined
  operatorChoice: FiscalEmissionOperatorChoice
}

export interface FiscalEmissionDecision {
  /** `null` = não tenta emitir nada agora (override explícito, atacado bloqueado, ou dado ambíguo). */
  attempt: 'nfce' | 'nfe' | null
  /** Motivo legível pra reportar ao operador quando `attempt` é `null` mas HAVIA intenção de emitir (auto ou override) — `null` quando o próprio operador pediu 'none' de propósito. */
  skipReason: string | null
}

const WHOLESALE_SALE_TYPE = 'wholesale'

export function resolveAutomaticFiscalEmission(
  input: ResolveAutomaticFiscalEmissionInput
): FiscalEmissionDecision {
  const { operatorChoice, saleType, ...resolverInput } = input

  if (operatorChoice === 'none') {
    return { attempt: null, skipReason: null }
  }

  if (operatorChoice === 'nfe') {
    return { attempt: 'nfe', skipReason: null }
  }

  const isWholesale = saleType === WHOLESALE_SALE_TYPE

  if (isWholesale) {
    return {
      attempt: null,
      skipReason:
        'Venda de atacado — NFC-e não é emitida automaticamente (pode envolver geração de crédito fiscal ao comprador, o que a NFC-e não pode representar). Emita NF-e manualmente na tela da venda quando aplicável.',
    }
  }

  const autoResolvedType = resolveFiscalDocumentType(resolverInput)

  if (operatorChoice === 'nfce') {
    if (autoResolvedType === 'nfce') return { attempt: 'nfce', skipReason: null }
    return {
      attempt: null,
      skipReason:
        autoResolvedType === 'blocked'
          ? describeFiscalDocumentTypeBlockReason(resolverInput)
          : 'Esta venda não é elegível para NFC-e (modalidade de entrega/origem indica NF-e) — emita NF-e na tela da venda.',
    }
  }

  // operatorChoice === 'auto'
  if (autoResolvedType === 'blocked') {
    return { attempt: null, skipReason: describeFiscalDocumentTypeBlockReason(resolverInput) }
  }
  return { attempt: autoResolvedType, skipReason: null }
}
