/**
 * Resolve o `operation_type` fiscal de uma venda a partir de campos JÁ
 * existentes no schema (`sales.sale_type`/`sales_channel`/`sale_origin`,
 * `shipments.delivery_mode`) — Motor Fiscal Configurável, Fase 1.
 *
 * NÃO grava um enum novo em `sales` (decisão explícita do pedido, seção 5):
 * este é um cálculo puro, chamado sob demanda a partir dos campos reais já
 * persistidos, nunca uma coluna nova.
 *
 * Módulo PURO: nenhuma chamada de rede/banco, nunca lança.
 *
 * ─── Prioridade (ordem exata) ────────────────────────────────────────────
 *   1. `saleType === 'wholesale'` → 'wholesale', SEMPRE, independente de
 *      canal/origem. Generaliza o gate de atacado que antes só existia
 *      dentro de `resolveAutomaticFiscalEmission` (Fase Fiscal 7) — agora
 *      vale pra QUALQUER canal (PDV, site de atacado, WhatsApp, manual),
 *      não só PDV. Isto é uma correção de comportamento real: o site de
 *      atacado (`sales_channel='wholesale_site'`, `sale_origin='website'`)
 *      antes seria classificado como 'website' por um resolver ingênuo —
 *      aqui a modalidade comercial (atacado) tem prioridade sobre o canal.
 *   2. `salesChannel === 'nuvemshop'` OU `saleOrigin === 'website'` →
 *      'website'. Cobre tanto o pedido real da Nuvemshop quanto qualquer
 *      venda manual marcada com origem site (mesma ambiguidade documentada
 *      em `resolveFiscalDocumentType`) — preserva o comportamento anterior
 *      exatamente, só reordenado depois da checagem de atacado.
 *   3. `salesChannel === 'whatsapp'` → 'whatsapp'.
 *   4. `salesChannel === 'manual'` → 'manual'.
 *   5. `salesChannel === 'pos'` (ou ausente — compatibilidade com vendas
 *      antigas sem o campo) → resolvido por `deliveryMode`:
 *        'delivery' → 'pos_delivery'
 *        'pickup'   → 'pos_pickup'
 *        ausente    → 'pos_retail' (balcão, pode legitimamente não ter
 *                     shipment — mesma regra de `resolveFiscalDocumentType`)
 *   6. Qualquer outra combinação (sales_channel desconhecido/corrompido) →
 *      `null` — nunca presume. O chamador trata `null` como
 *      `configuration_missing` (seção 38 do pedido).
 */

export type FiscalOperationType =
  | 'pos_retail'
  | 'pos_pickup'
  | 'pos_delivery'
  | 'wholesale'
  | 'website'
  | 'whatsapp'
  | 'manual'

export interface ResolveOperationTypeInput {
  /** `sales.sale_type` — bruto, não interpretado. */
  saleType: string | null | undefined
  /** `sales.sales_channel` — bruto, não interpretado. */
  salesChannel: string | null | undefined
  /** `sales.sale_origin` — bruto, não interpretado. */
  saleOrigin: string | null | undefined
  /** `shipments.delivery_mode`, quando existe — `null`/`undefined` para balcão sem shipment. */
  deliveryMode: string | null | undefined
}

const WHOLESALE = 'wholesale'
const WEBSITE_CHANNEL = 'nuvemshop'
const WEBSITE_ORIGIN = 'website'
const WHATSAPP_CHANNEL = 'whatsapp'
const MANUAL_CHANNEL = 'manual'
const POS_CHANNEL = 'pos'

export function resolveOperationType(input: ResolveOperationTypeInput): FiscalOperationType | null {
  const { saleType, salesChannel, saleOrigin, deliveryMode } = input

  if (saleType === WHOLESALE) return 'wholesale'

  if (salesChannel === WEBSITE_CHANNEL || saleOrigin === WEBSITE_ORIGIN) return 'website'

  if (salesChannel === WHATSAPP_CHANNEL) return 'whatsapp'

  if (salesChannel === MANUAL_CHANNEL) return 'manual'

  if (salesChannel === POS_CHANNEL || salesChannel == null) {
    if (deliveryMode === 'delivery') return 'pos_delivery'
    if (deliveryMode === 'pickup') return 'pos_pickup'
    if (deliveryMode == null) return 'pos_retail'
    return null // delivery_mode com valor inesperado — dado corrompido, nunca presume
  }

  return null // sales_channel fora do conjunto conhecido — dado corrompido, nunca presume
}
