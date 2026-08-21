/**
 * Resolução do tipo de documento fiscal — Fase Fiscal 4 (fundação) +
 * política ajustada nesta revisão (decisão aprovada em chat, não em
 * `docs/fiscal-fase4-nfce-arquitetura-proposta.md`, que descrevia a
 * versão anterior desta regra).
 *
 * Módulo PURO: nenhuma chamada de rede/banco, nunca lança. Decide entre
 * NF-e/NFC-e/bloqueado a partir de dois sinais já existentes no schema
 * (nenhum campo novo inventado):
 *   - `sales.sale_origin` (enum `customer_origin`) — checado PRIMEIRO:
 *     `'website'` sempre força NF-e, incondicionalmente.
 *   - `shipments.delivery_mode` ('pickup' | 'delivery') — natureza
 *     logística, checado depois de `website`.
 *
 * ─── Prioridade (ordem exata, decisão aprovada) ──────────────────────────
 *   1. `sale_origin === 'website'`           → nfe  (prevalece sobre tudo,
 *      inclusive `delivery_mode='pickup'` — política conservadora, ver nota)
 *   2. `delivery_mode === 'delivery'`         → nfe
 *   3. `delivery_mode === 'pickup'`           → nfce
 *   4. `delivery_mode` AUSENTE + `sale_origin === 'store'`
 *                                              → nfce (venda presencial de
 *      balcão pode legitimamente nunca ter criado `shipments` — NÃO
 *      depende da existência de `shipments` pra reconhecer retirada)
 *   5. qualquer outro caso (delivery_mode ausente sem origem 'store', ou
 *      delivery_mode com valor que não é 'pickup'/'delivery'/ausente —
 *      dado corrompido/inconsistente) → blocked, nunca presume
 *
 * "Atacado" (venda de atacado → NF-e) foi PROPOSTO mas DELIBERADAMENTE
 * ADIADO por decisão explícita: auditoria completa do schema/código
 * (migrations + `src/`) não encontrou NENHUM campo real que identifique
 * venda de atacado hoje — nenhuma coluna, enum, flag. Implementar essa
 * prioridade exigiria inventar um sinal que não existe, o que foi
 * explicitamente vetado. Fica pra uma fase futura, quando o ERP tiver um
 * fluxo de atacado real com um campo real pra checar aqui.
 *
 * ─── Sobre "website prevalece, mesmo com pickup" ─────────────────────────
 *
 * Isto NÃO é uma regra fiscal SEFAZ documentada de forma centralizada e
 * absoluta (auditado em `docs/fiscal-fase4-nfce-arquitetura-proposta.md`,
 * §2 — o schema NFC-e real da Focus só distingue `presenca_comprador`
 * presencial/entrega-a-domicílio, sem representação limpa pra "venda não
 * presencial com retirada posterior"). É uma **política operacional
 * conservadora deste ERP**, escolhida deliberadamente porque NF-e modela
 * melhor a natureza "não presencial" da origem do pedido
 * (`presenca_comprador=2`, já usado hoje) mesmo quando a retirada final é
 * física. Por isso a decisão fica isolada NESTA função (não espalhada por
 * `validateFiscalReadiness`/builders) — se essa política mudar no futuro,
 * o ponto de mudança é só aqui.
 *
 * `sale_origin='website'` hoje é usado tanto por vendas Nuvemshop quanto
 * por qualquer venda manual marcada como site — não distingue
 * especificamente Nuvemshop (o enum `customer_origin` não tem um valor
 * `'nuvemshop'` separado, confirmado na auditoria).
 */

export type FiscalDocumentType = 'nfe' | 'nfce' | 'blocked'

export type DeliveryMode = 'pickup' | 'delivery'

export interface ResolveFiscalDocumentTypeInput {
  /** `shipments.delivery_mode` — `null`/`undefined` quando a venda não tem `shipments` (legítimo pra balcão — NÃO tratado como bloqueio quando `saleOrigin === 'store'`, ver regra 4) ou o valor não é um dos dois esperados (dado inconsistente). */
  deliveryMode: DeliveryMode | string | null | undefined
  /** `sales.sale_origin` — bruto, não interpretado (mesma filosofia de `FiscalPaymentContext.method`: dado carregado, nunca um enum estrito importado de types gerados, que já se mostraram desatualizados nesta auditoria). */
  saleOrigin: string | null | undefined
}

const WEBSITE_ORIGIN = 'website'
const STORE_ORIGIN = 'store'

export function resolveFiscalDocumentType(input: ResolveFiscalDocumentTypeInput): FiscalDocumentType {
  const { deliveryMode, saleOrigin } = input

  // 1. website sempre prevalece — mesmo que delivery_mode seja 'pickup'.
  if (saleOrigin === WEBSITE_ORIGIN) return 'nfe'

  // 2-3. sinal explícito de shipments — o mais confiável quando existe.
  if (deliveryMode === 'delivery') return 'nfe'
  if (deliveryMode === 'pickup') return 'nfce'

  // 4. Sem shipments (delivery_mode genuinamente ausente, não um valor
  // inválido) — venda de balcão pode legitimamente nunca criar shipment.
  // 'store' é o único sinal de origem que representa presença física
  // inequívoca; os demais (instagram/referral/paid_traffic/other) são
  // canal de marketing, não indicam por si só que a venda foi presencial.
  if (deliveryMode == null && saleOrigin === STORE_ORIGIN) return 'nfce'

  // 5. Dado ausente sem origem presencial clara, OU delivery_mode com um
  // valor que não é 'pickup'/'delivery'/ausente (linha shipments corrompida
  // ou inesperada) — nunca presume, sempre bloqueia.
  return 'blocked'
}

/**
 * Motivo legível pra `resolveFiscalDocumentType` ter devolvido `'blocked'`
 * — Fase Fiscal 4F, item 5 do pedido ("retorne o motivo estruturado").
 * Não duplica a lógica de decisão — só descreve por que bloqueou, pra UI/
 * rota mostrarem ao operador em vez de um erro genérico. Devolve `null`
 * quando o resultado NÃO seria `'blocked'` (chamador não precisa checar
 * a decisão duas vezes, mas pode).
 */
export function describeFiscalDocumentTypeBlockReason(input: ResolveFiscalDocumentTypeInput): string | null {
  const { deliveryMode, saleOrigin } = input

  if (saleOrigin === WEBSITE_ORIGIN) return null
  if (deliveryMode === 'delivery' || deliveryMode === 'pickup') return null
  if (deliveryMode == null && saleOrigin === STORE_ORIGIN) return null

  if (deliveryMode == null) {
    return 'Esta venda não tem modalidade de entrega/retirada registrada (sem shipments) e a origem não indica presença física em loja (sale_origin ≠ "store") — não é possível determinar automaticamente NF-e ou NFC-e.'
  }
  return `Modalidade de entrega/retirada desta venda tem um valor inesperado ("${deliveryMode}", esperado "pickup" ou "delivery") — dado inconsistente, não é possível determinar automaticamente NF-e ou NFC-e.`
}
