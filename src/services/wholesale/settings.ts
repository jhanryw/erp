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
}

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
  }
}

export async function getWholesaleSiteSettings(companyId: number): Promise<WholesaleSiteSettings> {
  const admin = createAdminClient()
  const { data } = await (admin as any)
    .from('wholesale_site_settings')
    .select('catalog_active, display_name, whatsapp_phone, minimum_order_amount, show_out_of_stock, show_stock_quantity, show_search, show_categories, pixel_enabled, pixel_id')
    .eq('company_id', companyId)
    .maybeSingle() as { data: SettingsRow | null }

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
    }, { onConflict: 'company_id' })
    .select('catalog_active, display_name, whatsapp_phone, minimum_order_amount, show_out_of_stock, show_stock_quantity, show_search, show_categories, pixel_enabled, pixel_id')
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
