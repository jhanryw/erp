/**
 * Marketplace Hub — contrato GENÉRICO de canal de venda.
 *
 * O core do Qarvon (listings.service) fala só com esta interface. Cada canal
 * (Mercado Livre hoje; Shopee/Amazon/Nuvemshop depois) implementa um
 * ChannelAdapter dentro da sua própria pasta em src/lib/integrations/<canal>/.
 *
 * O adaptador recebe um anúncio já RESOLVIDO pelo core: SKU vendável,
 * preço, quantidade ABSOLUTA vendável (camada central de disponibilidade —
 * produto normal ou kit, indiferente), imagens públicas e atributos. Ele
 * nunca consulta estoque, nunca sabe o que é kit e nunca recebe composição.
 */

export type ChannelProvider = 'mercadolivre'

/** Status LOCAL do vínculo (Qarvon). Nunca é o texto cru do canal. */
export type ListingLocalStatus = 'draft' | 'publishing' | 'active' | 'paused' | 'error' | 'closed'

export interface ChannelAttributeValue {
  /** id do atributo no canal (ex.: BRAND, COLOR, SIZE, GTIN, SELLER_SKU) */
  id: string
  value_id?: string | null
  value_name?: string | null
}

/** O que o core entrega ao adaptador para publicar UMA variação vendável. */
export interface ChannelListingDraft {
  sellerSku: string
  /** Nome genérico do produto (ML UP: family_name; legado: base do título). */
  productName: string
  /** Título completo (usado só por canais/modelos que exigem título). */
  title: string
  description: string | null
  categoryId: string
  price: number
  currencyId: string
  /** Quantidade ABSOLUTA vendável (nunca delta). */
  quantity: number
  pictureUrls: string[]
  attributes: ChannelAttributeValue[]
  /** Parâmetros específicos do canal (tipo de anúncio, condição…). */
  channelOptions: Record<string, unknown>
}

/** Identificadores e estado que o canal devolveu — extensível. */
export interface ChannelListingSnapshot {
  externalListingId: string
  externalVariantId: string | null
  externalProductId: string | null
  externalGroupId: string | null
  externalIds: Record<string, unknown>
  externalCategoryId: string | null
  externalStatus: string | null
  externalSubStatus: string[]
  permalink: string | null
  price: number | null
  quantity: number | null
  sellerSku: string | null
  title: string | null
  pictureCount: number
  /** Avisos não fatais (ex.: descrição não aceita, preço ignorado por automação). */
  warnings: string[]
}

export interface ChannelListingRef {
  externalListingId: string
  externalVariantId?: string | null
  externalProductId?: string | null
}

/** Resultado da validação prévia no canal (ML: POST /items/validate). */
export interface ChannelValidationResult {
  ok: boolean
  /** Bloqueiam a publicação. */
  errors: Array<{ code: string | null; message: string }>
  /** Não bloqueiam; ficam registrados no vínculo. */
  warnings: Array<{ code: string | null; message: string }>
}

export interface ChannelAdapter {
  readonly provider: ChannelProvider
  /** Validação no canal SEM criar nada. Opcional: canais sem esse recurso publicam direto. */
  validateListing?(draft: ChannelListingDraft): Promise<ChannelValidationResult>
  publishListing(draft: ChannelListingDraft): Promise<ChannelListingSnapshot>
  fetchListing(ref: ChannelListingRef): Promise<ChannelListingSnapshot>
  /** Atualiza conteúdo editável (título/imagens/atributos) de um anúncio existente. */
  updateListing(ref: ChannelListingRef, draft: Partial<ChannelListingDraft>): Promise<ChannelListingSnapshot>
  updatePrice(ref: ChannelListingRef, price: number): Promise<ChannelListingSnapshot>
  /** Quantidade ABSOLUTA. 0 é válido (o canal trata como sem estoque). */
  updateQuantity(ref: ChannelListingRef, quantity: number): Promise<ChannelListingSnapshot>
  pauseListing(ref: ChannelListingRef): Promise<ChannelListingSnapshot>
  activateListing(ref: ChannelListingRef): Promise<ChannelListingSnapshot>
  /** Reconciliação: anúncios do vendedor com este SKU (ex.: processo caiu após publicar). */
  findListingsBySellerSku(sellerSku: string): Promise<ChannelListingSnapshot[]>
}

/**
 * Traduz o estado externo para o local, SEM desfazer uma pausa manual:
 * se o usuário pausou no Qarvon (local 'paused'), continua 'paused' mesmo
 * que o canal diga outra coisa; sem estoque ('out_of_stock') não é pausa
 * manual — o anúncio continua 'active' localmente.
 */
export function resolveLocalStatus(current: ListingLocalStatus, externalStatus: string | null, externalSubStatus: string[]): ListingLocalStatus {
  if (externalStatus === 'closed') return 'closed'
  if (current === 'paused') return 'paused'
  if (externalStatus === 'paused' && externalSubStatus.includes('paused_by_seller')) return 'paused'
  return current === 'publishing' || current === 'draft' || current === 'error' ? 'active' : current
}
