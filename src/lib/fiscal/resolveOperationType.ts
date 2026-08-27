/**
 * Resolve o `operation_type` fiscal de uma venda a partir de campos JÁ
 * existentes no schema (`sales.sale_type`/`sale_origin`,
 * `shipments.delivery_mode`) — Motor Fiscal Configurável.
 *
 * NÃO grava um enum novo em `sales`: este é um cálculo puro, chamado sob
 * demanda a partir dos campos reais já persistidos, nunca uma coluna nova.
 *
 * Módulo PURO: nenhuma chamada de rede/banco, nunca lança.
 *
 * ─── Consolidação 7→4 (revisão desta fase) ───────────────────────────────
 * Existiam 7 `operation_type` (`pos_retail`/`pos_pickup`/`pos_delivery`/
 * `wholesale`/`website`/`whatsapp`/`manual`), um por CANAL. Consolidado em
 * 4, um por NATUREZA FISCAL DA OPERAÇÃO — WhatsApp/manual/PDV continuam
 * existindo como `sales_channel`/`sale_origin` da venda, só deixaram de
 * ter uma política fiscal PRÓPRIA: agora são classificados pela natureza
 * real da operação (varejo sem entrega, varejo com entrega, ou atacado).
 * `salesChannel` DEIXOU de ser parâmetro desta função — não influencia
 * mais a decisão (removido de propósito, não apenas ignorado).
 *
 * ─── Prioridade (ordem exata, decisão aprovada em chat nesta revisão) ────
 *   1. `saleOrigin === 'website'` → 'website', SEMPRE — inclusive quando
 *      `saleType === 'wholesale'` ao mesmo tempo (venda do site de
 *      atacado). Decisão EXPLÍCITA desta revisão: antes da consolidação,
 *      `wholesale` tinha prioridade sobre `website` justamente para essa
 *      venda cair em NF-e MANUAL (cautela legal de crédito fiscal). Nesta
 *      revisão o dono decidiu inverter — venda do site de atacado passa a
 *      seguir a política `website` (NF-e AUTOMÁTICA), igual a qualquer
 *      outro pedido do site. Não é um esquecimento — foi perguntado e
 *      confirmado explicitamente antes de implementar.
 *   2. `saleType === 'wholesale'` → 'wholesale' — cobre atacado FORA do
 *      site (PDV, WhatsApp, manual).
 *   3. `deliveryMode === 'delivery'` → 'retail_delivery'.
 *   4. Qualquer outro caso de varejo (`deliveryMode === 'pickup'`, ou
 *      ausente — balcão sem shipment, ou WhatsApp/manual sem entrega) →
 *      'retail_pickup'. Este é o "todo restante do varejo" — não checa
 *      `salesChannel` nenhum, é o fallback de varejo.
 *   5. `deliveryMode` com valor inesperado (nem 'delivery' nem 'pickup'
 *      nem ausente) → `null` — dado corrompido, nunca presume. O
 *      chamador trata `null` como `configuration_missing`.
 */

export type FiscalOperationType = 'retail_pickup' | 'retail_delivery' | 'wholesale' | 'website'

export interface ResolveOperationTypeInput {
  /** `sales.sale_type` — bruto, não interpretado. */
  saleType: string | null | undefined
  /** `sales.sale_origin` — bruto, não interpretado. */
  saleOrigin: string | null | undefined
  /** `shipments.delivery_mode`, quando existe — `null`/`undefined` para balcão sem shipment. */
  deliveryMode: string | null | undefined
}

const WHOLESALE = 'wholesale'
const WEBSITE_ORIGIN = 'website'

export function resolveOperationType(input: ResolveOperationTypeInput): FiscalOperationType | null {
  const { saleType, saleOrigin, deliveryMode } = input

  if (saleOrigin === WEBSITE_ORIGIN) return 'website'

  if (saleType === WHOLESALE) return 'wholesale'

  if (deliveryMode === 'delivery') return 'retail_delivery'
  if (deliveryMode === 'pickup' || deliveryMode == null) return 'retail_pickup'

  return null // delivery_mode com valor inesperado — dado corrompido, nunca presume
}
