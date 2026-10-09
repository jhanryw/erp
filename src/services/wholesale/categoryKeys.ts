/**
 * Identidade PÚBLICA das categorias do atacado.
 *
 * `categories` só garante unicidade de `(company_id, product_type_id, slug)` — duas categorias da
 * mesma empresa (tipos de produto diferentes) podem ter o MESMO slug. O slug sozinho, usado como
 * `?categoria=` nas URLs, fundia as duas. A chave pública resolve isso sem quebrar links existentes:
 *   - slug único  → a chave é o próprio slug (URLs atuais continuam válidas);
 *   - slug repetido → `slug~id` (o `~` não ocorre em slug; nunca colide com outro slug).
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface UniverseCategory {
  id: number
  name: string
  slug: string
  active: boolean
}

export interface KeyedCategory extends UniverseCategory {
  /** Valor usado em `?categoria=` — único dentro do universo da empresa. */
  key: string
}

export function assignCategoryKeys(categories: UniverseCategory[]): KeyedCategory[] {
  const bySlug = new Map<string, number>()
  for (const c of categories) bySlug.set(c.slug, (bySlug.get(c.slug) ?? 0) + 1)
  return categories.map((c) => ({ ...c, key: (bySlug.get(c.slug) ?? 0) > 1 ? `${c.slug}~${c.id}` : c.slug }))
}

/** `null` quando a chave não existe (ou é um slug ambíguo sem o `~id`). */
export function resolveCategoryKey(keyed: KeyedCategory[], key: string): KeyedCategory | null {
  return keyed.find((c) => c.key === key) ?? null
}

/**
 * Universo de categorias que a empresa enxerga: as dela + as legadas compartilhadas
 * (`company_id` nulo, ainda referenciadas por produtos antigos). Duas consultas simples,
 * com chaves calculadas sobre o conjunto completo — a chave de uma categoria não muda quando
 * outra fica sem produtos.
 */
export async function loadCategoryUniverse(admin: ReturnType<typeof createAdminClient>, companyId: number): Promise<KeyedCategory[]> {
  const columns = 'id, name, slug, active'
  const [own, legacy] = await Promise.all([
    (admin as any).from('categories').select(columns).eq('company_id', companyId).order('id', { ascending: true }),
    (admin as any).from('categories').select(columns).is('company_id', null).order('id', { ascending: true }),
  ]) as Array<{ data: Array<{ id: number; name: string; slug: string; active: boolean | null }> | null; error: { message: string } | null }>

  const error = own.error ?? legacy.error
  if (error) throw new Error(`Falha ao carregar as categorias do atacado: ${error.message}`)

  const rows = [...(own.data ?? []), ...(legacy.data ?? [])]
  return assignCategoryKeys(rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, active: r.active !== false })))
}
