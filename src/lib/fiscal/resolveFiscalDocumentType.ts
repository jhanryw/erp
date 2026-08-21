/**
 * Resolução do tipo de documento fiscal — Fase Fiscal 4 (fundação),
 * decisão aprovada em `docs/fiscal-fase4-nfce-arquitetura-proposta.md`.
 *
 * Módulo PURO: nenhuma chamada de rede/banco, nunca lança. Decide entre
 * NF-e/NFC-e/bloqueado a partir de dois sinais já existentes no schema
 * (nenhum campo novo inventado):
 *   - `shipments.delivery_mode` ('pickup' | 'delivery') — sinal PRIMÁRIO,
 *     natureza logística da venda.
 *   - `sales.sale_origin` (enum `customer_origin`) — usado só pra
 *     desambiguar o caso `pickup` (retirada) entre presencial de balcão
 *     (NFC-e) e retirada de uma compra feita no site (NF-e).
 *
 * Regra aprovada:
 *   delivery                      → nfe   (sempre — entrega exige destinatário)
 *   pickup + origem != 'website'  → nfce  (balcão/manual — presencial)
 *   pickup + origem == 'website'  → nfe   (política CONSERVADORA do ERP —
 *                                           ver nota abaixo, NÃO é regra
 *                                           fiscal SEFAZ universal)
 *   deliveryMode ausente/inválido → blocked (nunca presume)
 *
 * ─── Sobre "pickup + website → nfe" ───────────────────────────────────────
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
 * `validateFiscalReadiness`/builders) — se essa política mudar no futuro
 * (ex.: confirmação de que a Focus/SEFAZ aceita NFC-e nesse caso, ou uma
 * decisão de negócio diferente), o ponto de mudança é só aqui.
 *
 * `sale_origin='website'` hoje é usado tanto por vendas Nuvemshop quanto
 * por qualquer venda manual marcada como site — não distingue
 * especificamente Nuvemshop (o enum `customer_origin` não tem um valor
 * `'nuvemshop'` separado, confirmado na auditoria).
 */

export type FiscalDocumentType = 'nfe' | 'nfce' | 'blocked'

export type DeliveryMode = 'pickup' | 'delivery'

export interface ResolveFiscalDocumentTypeInput {
  /** `shipments.delivery_mode` — `null`/`undefined` quando a venda não tem `shipments` (ex.: hoje, toda venda Nuvemshop) ou o valor não é um dos dois esperados. */
  deliveryMode: DeliveryMode | string | null | undefined
  /** `sales.sale_origin` — bruto, não interpretado (mesma filosofia de `FiscalPaymentContext.method`: dado carregado, nunca um enum estrito importado de types gerados, que já se mostraram desatualizados nesta auditoria). */
  saleOrigin: string | null | undefined
}

const WEBSITE_ORIGIN = 'website'

export function resolveFiscalDocumentType(input: ResolveFiscalDocumentTypeInput): FiscalDocumentType {
  const { deliveryMode, saleOrigin } = input

  if (deliveryMode !== 'pickup' && deliveryMode !== 'delivery') {
    // Ausente, null, ou qualquer valor que não seja um dos dois reais do
    // banco — nunca presume retirada nem entrega. Cobre exatamente o caso
    // de hoje: vendas Nuvemshop não têm `shipments`/`delivery_mode`.
    return 'blocked'
  }

  if (deliveryMode === 'delivery') return 'nfe'

  // deliveryMode === 'pickup'
  if (saleOrigin === WEBSITE_ORIGIN) return 'nfe' // política conservadora — ver comentário do arquivo
  return 'nfce'
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
  const { deliveryMode } = input
  if (deliveryMode !== 'pickup' && deliveryMode !== 'delivery') {
    return 'Modalidade de entrega/retirada desta venda não está definida (shipments.delivery_mode ausente ou com valor inesperado) — não é possível determinar automaticamente NF-e ou NFC-e.'
  }
  return null
}
