/**
 * Normalização de telefone brasileiro para E.164 (ex.: +5584999999999).
 *
 * FASE 1 (Customer Identity) — substitui a implementação anterior, que tinha
 * um bug real: decidia se o "55" já era o DDI olhando só se a string
 * começava com "55" (`digits.startsWith('55')`). Isso quebra silenciosamente
 * para qualquer pessoa com DDD 55 (Rio Grande do Sul — Santa Maria, Passo
 * Fundo etc.): "55991234567" (DDD 55 + celular, 11 dígitos, sem DDI) batia
 * no `startsWith('55')` e era devolvido sem o DDI prepended, gerando um
 * identificador errado (11 dígitos em vez de 13) — a mesma pessoa podia
 * gerar duas identidades diferentes dependendo de como digitou o número.
 *
 * Novo critério: usar o COMPRIMENTO da string de dígitos para decidir se o
 * DDI já está presente, nunca o prefixo:
 *   10 dígitos → DDD(2) + fixo(8), sem DDI            → prepend 55
 *   11 dígitos → DDD(2) + celular(9), sem DDI          → prepend 55
 *   12 dígitos → deve começar com 55: DDI+DDD(2)+fixo(8)
 *   13 dígitos → deve começar com 55: DDI+DDD(2)+celular(9)
 *   qualquer outro comprimento → rejeitado (nunca adivinha DDD)
 *
 * "00" na frente (prefixo de discagem internacional, ex. "0055...") é
 * removido antes da lógica acima, só quando o restante ainda for longo o
 * bastante pra ser DDI+DDD+número (evita interpretar "0084..." — que não é
 * um prefixo internacional válido pro Brasil — como se fosse).
 *
 * Validações adicionais, propositalmente conservadoras (preferimos rejeitar
 * a adivinhar):
 *   - DDD: primeiro dígito nunca é 0 (não validamos contra a lista completa
 *     de ~67 DDDs da ANATEL — o risco de rejeitar um DDD real por eu ter
 *     errado a lista é pior que aceitar um DDD tecnicamente inexistente).
 *   - Celular (9 dígitos após o DDD): o primeiro dígito do assinante deve
 *     ser '9' — regra universal desde a migração do 9º dígito (2016), sem
 *     exceção conhecida. Um "celular" de 9 dígitos que não começa com 9 é
 *     tratado como AMBÍGUO (pode ser erro de digitação), nunca aceito.
 *   - Fixo (8 dígitos após o DDD): aceito sem checar o primeiro dígito —
 *     não há regra universal confiável aqui, e 8 dígitos após um DDD
 *     também é o formato de celular anterior a 2016; como não dá pra
 *     diferenciar os dois com segurança, aceitamos sem tentar adivinhar
 *     qual dos dois é.
 *   - "múltiplos telefones no mesmo campo" (ex. "84999999999 e 84888888888")
 *     não tem tratamento especial: remover tudo que não é dígito concatena
 *     os dois números numa string que não bate em nenhum comprimento válido
 *     (10/11/12/13) e cai em `invalid_length` — comportamento correto por
 *     construção, não por caso especial.
 *
 * Usado hoje pela ingestão inbound do CRM (Fase 3, `normalizeChannelIdentityValue`)
 * e pelo serviço de Customer Identity (Fase 1, `customer-identity.service.ts`).
 * Não substitui a normalização inline já existente no node "Parse payload"
 * do fluxo N8N de pós-venda nem em post-sale-context.ts — cada um resolve
 * seu próprio fluxo, fora de escopo tocar código já validado em produção.
 */

export type PhoneNormalizationFailureReason =
  | 'empty'
  | 'invalid_length'
  | 'invalid_ddd'
  | 'ambiguous'

export type PhoneNormalizationResult =
  | { ok: true; e164: string } // ex.: "+5584999999999"
  | { ok: false; reason: PhoneNormalizationFailureReason }

export function normalizePhoneBR(raw: string | null | undefined): PhoneNormalizationResult {
  if (!raw || !raw.trim()) return { ok: false, reason: 'empty' }

  let digits = raw.replace(/\D/g, '')
  if (!digits) return { ok: false, reason: 'empty' }

  // Prefixo de discagem internacional "00" — só remove se sobrar comprimento
  // plausível de DDI(2)+DDD(2)+número(8 ou 9) = 12 ou 13.
  if (digits.startsWith('00') && (digits.length === 14 || digits.length === 15)) {
    digits = digits.slice(2)
  }

  let national: string // DDD + número do assinante, sem DDI
  if (digits.length === 12 || digits.length === 13) {
    if (!digits.startsWith('55')) return { ok: false, reason: 'invalid_length' }
    national = digits.slice(2)
  } else if (digits.length === 10 || digits.length === 11) {
    national = digits
  } else {
    return { ok: false, reason: 'invalid_length' }
  }

  const ddd = national.slice(0, 2)
  const subscriber = national.slice(2)

  if (!/^[1-9][0-9]$/.test(ddd)) return { ok: false, reason: 'invalid_ddd' }

  if (subscriber.length === 9) {
    if (subscriber[0] !== '9') return { ok: false, reason: 'ambiguous' }
  } else if (subscriber.length !== 8) {
    return { ok: false, reason: 'invalid_length' }
  }

  return { ok: true, e164: `+55${ddd}${subscriber}` }
}

/**
 * Contrato antigo, mantido por compatibilidade — único chamador real hoje é
 * `normalizeChannelIdentityValue` (CRM). Retorna E.164 SEM o "+" (dígitos
 * puros), string vazia em qualquer falha (mesmo contrato de antes; o
 * chamador já trata `''` como "identidade inválida").
 */
export function normalizeE164BR(raw: string): string {
  const result = normalizePhoneBR(raw)
  return result.ok ? result.e164.slice(1) : ''
}
