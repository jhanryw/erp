/**
 * Configuração do catálogo de atacado (por empresa) — Reformulação da
 * vitrine, Fase 2.
 *
 * Mesmo padrão de `company_fiscal_settings`: 1 linha por `company_id`,
 * RLS restrita a `service_role`, lida/escrita só server-side. Nunca
 * aceita `company_id` de fora — sempre resolvido por quem chama (mesma
 * regra de `tenant.ts`).
 *
 * `getWholesaleSiteSettings` NUNCA lança/retorna erro para "sem linha
 * ainda" — devolve os defaults que preservam o comportamento de HOJE do
 * catálogo (catálogo ativo, sem WhatsApp configurado, R$ 300 de pedido
 * mínimo, exibição padrão), porque a tabela é nova e a empresa real ainda
 * não tem linha até configurar pela tela.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { listMediaByEntity } from '@/services/media.service'
import { EMPTY_SITE_TEXTS, type WholesaleSiteTexts } from './siteTexts'

export interface WholesaleSiteSettings {
  catalogActive: boolean
  displayName: string | null
  whatsappPhone: string | null
  minimumOrderAmount: number
  showOutOfStock: boolean
  showStockQuantity: boolean
  showSearch: boolean
  showCategories: boolean
  pixelEnabled: boolean
  pixelId: string | null
  /** Textos personalizados (null = padrão do código). Nunca contém o valor do pedido mínimo. */
  texts: WholesaleSiteTexts
}

// Preserva o comportamento atual do catálogo (que não tinha nenhuma
// dessas configurações) até a empresa configurar a tela nova — nunca
// esconde o catálogo nem inventa um pedido mínimo diferente de R$ 300 por
// conta própria.
const DEFAULT_SETTINGS: WholesaleSiteSettings = {
  catalogActive: true,
  displayName: null,
  whatsappPhone: null,
  minimumOrderAmount: 300,
  showOutOfStock: false,
  showStockQuantity: false,
  showSearch: true,
  showCategories: true,
  pixelEnabled: false,
  pixelId: null,
  texts: EMPTY_SITE_TEXTS,
}

interface SettingsRow {
  catalog_active: boolean
  display_name: string | null
  whatsapp_phone: string | null
  minimum_order_amount: number | string
  show_out_of_stock: boolean
  show_stock_quantity: boolean
  show_search: boolean
  show_categories: boolean
  pixel_enabled: boolean
  pixel_id: string | null
  hero_title?: string | null
  hero_subtitle?: string | null
  categories_title?: string | null
  products_title?: string | null
  add_also_title?: string | null
  minimum_order_note?: string | null
  empty_message?: string | null
  footer_text?: string | null
}

const SETTINGS_COLUMNS =
  'catalog_active, display_name, whatsapp_phone, minimum_order_amount, show_out_of_stock, show_stock_quantity, show_search, show_categories, pixel_enabled, pixel_id, ' +
  'hero_title, hero_subtitle, categories_title, products_title, add_also_title, minimum_order_note, empty_message, footer_text'

function fromRow(row: SettingsRow): WholesaleSiteSettings {
  return {
    catalogActive: row.catalog_active,
    displayName: row.display_name,
    whatsappPhone: row.whatsapp_phone,
    minimumOrderAmount: Number(row.minimum_order_amount),
    showOutOfStock: row.show_out_of_stock,
    showStockQuantity: row.show_stock_quantity,
    showSearch: row.show_search,
    showCategories: row.show_categories,
    pixelEnabled: row.pixel_enabled,
    pixelId: row.pixel_id,
    texts: {
      heroTitle: row.hero_title ?? null,
      heroSubtitle: row.hero_subtitle ?? null,
      categoriesTitle: row.categories_title ?? null,
      productsTitle: row.products_title ?? null,
      addAlsoTitle: row.add_also_title ?? null,
      minimumOrderNote: row.minimum_order_note ?? null,
      emptyMessage: row.empty_message ?? null,
      footerText: row.footer_text ?? null,
    },
  }
}

export async function getWholesaleSiteSettings(companyId: number): Promise<WholesaleSiteSettings> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any)
    .from('wholesale_site_settings')
    .select(SETTINGS_COLUMNS)
    .eq('company_id', companyId)
    .maybeSingle() as { data: SettingsRow | null; error: { message: string } | null }

  // Erro de banco NUNCA vira "configuração padrão": isso abriria o catálogo (catalog_active=true)
  // e trocaria pedido mínimo/WhatsApp por defaults numa falha transitória. Só "sem linha" usa defaults.
  if (error) throw new Error(`Falha ao ler a configuração do atacado: ${error.message}`)

  return data ? fromRow(data) : DEFAULT_SETTINGS
}

export interface UpdateWholesaleSiteSettingsInput {
  catalogActive?: boolean
  displayName?: string | null
  whatsappPhone?: string | null
  minimumOrderAmount?: number
  showOutOfStock?: boolean
  showStockQuantity?: boolean
  showSearch?: boolean
  showCategories?: boolean
  pixelEnabled?: boolean
  pixelId?: string | null
  /** Parcial: campo ausente mantém o valor atual; `null` volta ao texto padrão. */
  texts?: Partial<WholesaleSiteTexts>
}

export type UpdateSettingsResult =
  | { ok: true; data: WholesaleSiteSettings }
  | { ok: false; error: string; status: number }

/**
 * Upsert por `company_id` (UNIQUE) — cria a linha na primeira vez que a
 * empresa salva algo na tela, atualiza depois. Nunca faz merge parcial
 * "campo ausente = mantém banco" pela metade: sempre lê o estado atual
 * (ou os defaults) primeiro e sobrescreve só os campos informados, então
 * grava o objeto completo — evita o mesmo bug de preprocess-em-chave-
 * ausente já corrigido em produtos (não há campo aqui com essa forma de
 * schema, mas o padrão de merge explícito é mantido por consistência).
 */
function mergeTexts(current: WholesaleSiteTexts, patch: Partial<WholesaleSiteTexts> | undefined): WholesaleSiteTexts {
  const merged = { ...current }
  for (const key of Object.keys(patch ?? {}) as (keyof WholesaleSiteTexts)[]) {
    if (patch![key] !== undefined) merged[key] = patch![key] as string | null
  }
  return merged
}

export async function updateWholesaleSiteSettings(
  companyId: number,
  patch: UpdateWholesaleSiteSettingsInput,
): Promise<UpdateSettingsResult> {
  const admin = createAdminClient()
  const current = await getWholesaleSiteSettings(companyId)

  const merged: WholesaleSiteSettings = {
    catalogActive: patch.catalogActive ?? current.catalogActive,
    displayName: patch.displayName !== undefined ? patch.displayName : current.displayName,
    whatsappPhone: patch.whatsappPhone !== undefined ? patch.whatsappPhone : current.whatsappPhone,
    minimumOrderAmount: patch.minimumOrderAmount ?? current.minimumOrderAmount,
    showOutOfStock: patch.showOutOfStock ?? current.showOutOfStock,
    showStockQuantity: patch.showStockQuantity ?? current.showStockQuantity,
    showSearch: patch.showSearch ?? current.showSearch,
    showCategories: patch.showCategories ?? current.showCategories,
    pixelEnabled: patch.pixelEnabled ?? current.pixelEnabled,
    pixelId: patch.pixelId !== undefined ? patch.pixelId : current.pixelId,
    texts: mergeTexts(current.texts, patch.texts),
  }

  const { data, error } = await (admin as any)
    .from('wholesale_site_settings')
    .upsert({
      company_id: companyId,
      catalog_active: merged.catalogActive,
      display_name: merged.displayName,
      whatsapp_phone: merged.whatsappPhone,
      minimum_order_amount: merged.minimumOrderAmount,
      show_out_of_stock: merged.showOutOfStock,
      show_stock_quantity: merged.showStockQuantity,
      show_search: merged.showSearch,
      show_categories: merged.showCategories,
      pixel_enabled: merged.pixelEnabled,
      pixel_id: merged.pixelId,
      hero_title: merged.texts.heroTitle,
      hero_subtitle: merged.texts.heroSubtitle,
      categories_title: merged.texts.categoriesTitle,
      products_title: merged.texts.productsTitle,
      add_also_title: merged.texts.addAlsoTitle,
      minimum_order_note: merged.texts.minimumOrderNote,
      empty_message: merged.texts.emptyMessage,
      footer_text: merged.texts.footerText,
    }, { onConflict: 'company_id' })
    .select(SETTINGS_COLUMNS)
    .single() as { data: SettingsRow | null; error: { message: string } | null }

  if (error || !data) return { ok: false, error: error?.message ?? 'Falha ao salvar configuração.', status: 500 }
  return { ok: true, data: fromRow(data) }
}

/**
 * Logo do catálogo público — `null` quando a empresa ainda não enviou uma
 * (mesma tela de Configurações → Atacado). Reaproveita o Media Hub
 * (entity_type='company', role='logo') — nunca uma segunda tabela/URL.
 */
export async function getWholesaleCompanyLogoUrl(companyId: number): Promise<string | null> {
  const result = await listMediaByEntity('company', String(companyId), companyId)
  if (!result.ok) return null
  return result.data.find((m) => m.role === 'logo')?.url ?? null
}
