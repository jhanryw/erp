/**
 * Smart product search with multi-word matching and Portuguese normalization.
 *
 * Why this matters:
 * - "Calcinha Low" must match "Calcinha Invisible Low" (words in any order, partial)
 * - "Calcinha Amarela" must match "Calcinha Amarelo" (gender: a↔o, as↔os)
 * - Accents ignored: "calcinha" matches "calçinha"
 */

function stripAccents(str: string): string {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

/** Returns all Portuguese morphological variants of a word to try. */
function wordVariants(raw: string): string[] {
  const w = stripAccents(raw.toLowerCase())
  const set = new Set<string>([w])

  if (w.endsWith('as')) {
    set.add(w.slice(0, -2) + 'os') // amarelas → amarelos
    set.add(w.slice(0, -1))         // amarelas → amarela (singular)
  } else if (w.endsWith('os')) {
    set.add(w.slice(0, -2) + 'as') // amarelos → amarelas
    set.add(w.slice(0, -1))         // amarelos → amarelo
  } else if (w.endsWith('a')) {
    set.add(w.slice(0, -1) + 'o')  // amarela → amarelo
    set.add(w + 's')                // amarela → amarelas
  } else if (w.endsWith('o')) {
    set.add(w.slice(0, -1) + 'a')  // amarelo → amarela
    set.add(w + 's')                // amarelo → amarelos
  }

  return Array.from(set)
}

/**
 * Returns true if ALL words in `query` appear somewhere in `name + sku`.
 * Words can match in any order, partially, ignoring gender and accents.
 */
export function matchesProductQuery(name: string, sku: string, query: string): boolean {
  if (!query.trim()) return true

  const haystack = stripAccents(`${name} ${sku}`.toLowerCase())
  const words = query.trim().split(/\s+/).filter(Boolean)

  return words.every((word) =>
    wordVariants(word).some((variant) => haystack.includes(variant))
  )
}

export function filterProducts<T extends { name: string; sku: string }>(
  products: T[],
  query: string,
  limit = 10
): T[] {
  if (!query.trim()) return products.slice(0, limit)
  return products.filter((p) => matchesProductQuery(p.name, p.sku, query)).slice(0, limit)
}
