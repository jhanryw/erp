/**
 * Grupos de cores (família de um modelo) do atacado — gestão no ERP.
 *
 * Cada cor é um produto; o vínculo é EXPLÍCITO (`products.color_group_id`). Nada é agrupado
 * automaticamente: `suggestColorGroups` só PROPÕE conjuntos para um humano confirmar.
 * `company_id` nunca vem do cliente; o banco ainda garante a mesma empresa (FK composta).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateWholesaleCompany } from '@/lib/wholesale/ttlCache'

type Admin = ReturnType<typeof createAdminClient>

export interface ColorGroupMember { productId: number; name: string; active: boolean; wholesaleEnabled: boolean }
export interface ColorGroup { id: number; name: string; members: ColorGroupMember[] }
export interface UngroupedProduct { id: number; name: string }
export interface ColorGroupSuggestion { baseName: string; products: UngroupedProduct[] }

export type GroupResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { data: T })) | { ok: false; error: string; status: number }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Remove a cor do FIM do nome ("Calcinha Invisible Low Fio Rosê" + "Rosê" → "Calcinha Invisible Low Fio"). */
export function baseNameWithoutColor(name: string, color: string): string | null {
  const n = norm(name), c = norm(color)
  if (!c || !n.endsWith(` ${c}`) && n !== c) return null
  const base = name.trim().slice(0, name.trim().length - color.trim().length).trim()
  return base.length > 0 ? base : null
}

/**
 * Sugestões para revisão humana: produtos SEM grupo, de atacado, com exatamente uma cor e o mesmo nome-base.
 * Pode sugerir produtos de categorias diferentes de propósito — quem decide é o administrador.
 */
export function buildSuggestions(products: Array<{ id: number; name: string; color: string | null }>): ColorGroupSuggestion[] {
  const byBase = new Map<string, { baseName: string; products: UngroupedProduct[] }>()
  for (const p of products) {
    if (!p.color) continue
    const base = baseNameWithoutColor(p.name, p.color)
    if (!base) continue
    const key = norm(base)
    const entry = byBase.get(key) ?? { baseName: base, products: [] }
    entry.products.push({ id: p.id, name: p.name })
    byBase.set(key, entry)
  }
  return Array.from(byBase.values())
    .filter((g) => g.products.length >= 2)
    .map((g) => ({ ...g, products: g.products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')) }))
    .sort((a, b) => a.baseName.localeCompare(b.baseName, 'pt-BR'))
}

export async function listColorGroups(companyId: number): Promise<{ groups: ColorGroup[]; ungrouped: UngroupedProduct[]; suggestions: ColorGroupSuggestion[] }> {
  const admin = createAdminClient()

  const { data: groupRows, error: groupError } = await (admin as any)
    .from('product_color_groups').select('id, name').eq('company_id', companyId).order('name', { ascending: true }) as
    { data: { id: number; name: string }[] | null; error: { message: string } | null }
  if (groupError) throw new Error(`Falha ao listar grupos de cores: ${groupError.message}`)

  const { data: products, error: productError } = await (admin as any)
    .from('products').select('id, name, active, wholesale_enabled, color_group_id').eq('company_id', companyId).eq('active', true).order('name', { ascending: true }) as
    { data: { id: number; name: string; active: boolean; wholesale_enabled: boolean; color_group_id: number | null }[] | null; error: { message: string } | null }
  if (productError) throw new Error(`Falha ao listar produtos: ${productError.message}`)

  const all = products ?? []
  const groups: ColorGroup[] = (groupRows ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    members: all.filter((p) => p.color_group_id === g.id).map((p) => ({ productId: p.id, name: p.name, active: p.active, wholesaleEnabled: p.wholesale_enabled })),
  }))

  const ungroupedRows = all.filter((p) => p.color_group_id == null && p.wholesale_enabled)
  const ungrouped = ungroupedRows.map((p) => ({ id: p.id, name: p.name }))

  // Cor de cada produto sem grupo (um único valor de "Cor" entre as variações).
  const colors = await loadSingleColorByProduct(admin, ungroupedRows.map((p) => p.id))
  const suggestions = buildSuggestions(ungroupedRows.map((p) => ({ id: p.id, name: p.name, color: colors.get(p.id) ?? null })))

  return { groups, ungrouped, suggestions }
}

async function loadSingleColorByProduct(admin: Admin, productIds: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  if (productIds.length === 0) return result
  const colorsByProduct = new Map<number, Set<string>>()

  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100)
    const { data: variations } = await (admin as any).from('product_variations').select('id, product_id').in('product_id', chunk).eq('active', true) as { data: { id: number; product_id: number }[] | null }
    const variationIds = (variations ?? []).map((v) => v.id)
    if (variationIds.length === 0) continue
    const productOf = new Map((variations ?? []).map((v) => [v.id, v.product_id]))

    const { data: attrs } = await (admin as any)
      .from('product_variation_attributes')
      .select('product_variation_id, variation_types:variation_type_id(name), variation_values:variation_value_id(value)')
      .in('product_variation_id', variationIds) as { data: any[] | null }

    for (const a of attrs ?? []) {
      const type = (Array.isArray(a.variation_types) ? a.variation_types[0] : a.variation_types)?.name
      const value = (Array.isArray(a.variation_values) ? a.variation_values[0] : a.variation_values)?.value
      if (!type || !value || norm(type) !== 'cor') continue
      const pid = productOf.get(a.product_variation_id)
      if (pid == null) continue
      const set = colorsByProduct.get(pid) ?? new Set<string>()
      set.add(value)
      colorsByProduct.set(pid, set)
    }
  }
  for (const [pid, set] of colorsByProduct) if (set.size === 1) result.set(pid, [...set][0])
  return result
}

async function productsAreEligible(admin: Admin, companyId: number, productIds: number[], groupId: number | null): Promise<GroupResult> {
  const { data } = await (admin as any)
    .from('products').select('id, color_group_id').eq('company_id', companyId).in('id', productIds) as
    { data: { id: number; color_group_id: number | null }[] | null }
  const found = data ?? []
  if (found.length !== productIds.length) return { ok: false, error: 'Há produtos que não pertencem a esta empresa.', status: 422 }
  const taken = found.filter((p) => p.color_group_id != null && p.color_group_id !== groupId)
  if (taken.length > 0) return { ok: false, error: 'Há produtos que já pertencem a outro grupo de cores. Remova-os do outro grupo primeiro.', status: 409 }
  return { ok: true }
}

export async function createColorGroup(companyId: number, name: string, productIds: number[]): Promise<GroupResult<{ id: number }>> {
  const ids = Array.from(new Set(productIds))
  if (ids.length < 2) return { ok: false, error: 'Um grupo precisa de pelo menos 2 produtos.', status: 422 }

  const admin = createAdminClient()
  const eligible = await productsAreEligible(admin, companyId, ids, null)
  if (!eligible.ok) return eligible

  const { data: group, error } = await (admin as any)
    .from('product_color_groups').insert({ company_id: companyId, name }).select('id').single() as { data: { id: number } | null; error: { message: string } | null }
  if (error || !group) return { ok: false, error: error?.message ?? 'Falha ao criar o grupo.', status: 500 }

  const { error: linkError } = await (admin as any).from('products').update({ color_group_id: group.id }).eq('company_id', companyId).in('id', ids) as { error: { message: string } | null }
  if (linkError) {
    await (admin as any).from('product_color_groups').delete().eq('company_id', companyId).eq('id', group.id)
    return { ok: false, error: linkError.message, status: 500 }
  }
  invalidateWholesaleCompany(companyId)
  return { ok: true, data: { id: group.id } }
}

export async function updateColorGroup(companyId: number, groupId: number, patch: { name?: string; productIds?: number[] }): Promise<GroupResult> {
  const admin = createAdminClient()
  const { data: group } = await (admin as any).from('product_color_groups').select('id').eq('company_id', companyId).eq('id', groupId).maybeSingle() as { data: { id: number } | null }
  if (!group) return { ok: false, error: 'Grupo não encontrado.', status: 404 }

  if (patch.name !== undefined) {
    const { error } = await (admin as any).from('product_color_groups').update({ name: patch.name }).eq('company_id', companyId).eq('id', groupId)
    if (error) return { ok: false, error: error.message, status: 500 }
  }

  if (patch.productIds !== undefined) {
    const ids = Array.from(new Set(patch.productIds))
    if (ids.length < 2) return { ok: false, error: 'Um grupo precisa de pelo menos 2 produtos. Para desfazer, exclua o grupo.', status: 422 }
    const eligible = await productsAreEligible(admin, companyId, ids, groupId)
    if (!eligible.ok) return eligible
    // Libera quem saiu e vincula quem entrou.
    await (admin as any).from('products').update({ color_group_id: null }).eq('company_id', companyId).eq('color_group_id', groupId)
    const { error } = await (admin as any).from('products').update({ color_group_id: groupId }).eq('company_id', companyId).in('id', ids)
    if (error) return { ok: false, error: error.message, status: 500 }
  }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}

export async function deleteColorGroup(companyId: number, groupId: number): Promise<GroupResult> {
  const admin = createAdminClient()
  const { data: group } = await (admin as any).from('product_color_groups').select('id').eq('company_id', companyId).eq('id', groupId).maybeSingle() as { data: { id: number } | null }
  if (!group) return { ok: false, error: 'Grupo não encontrado.', status: 404 }

  await (admin as any).from('products').update({ color_group_id: null }).eq('company_id', companyId).eq('color_group_id', groupId)
  const { error } = await (admin as any).from('product_color_groups').delete().eq('company_id', companyId).eq('id', groupId)
  if (error) return { ok: false, error: error.message, status: 500 }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}
