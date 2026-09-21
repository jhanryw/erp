/**
 * Helpers de consulta do catálogo de atacado que NUNCA dependem do limite
 * global de linhas do PostgREST (`db-max-rows`, 1000 por padrão) nem de
 * `.in()` com centenas de ids na URL.
 *
 * Antes destes helpers, `product_variations`/`stock_balances` eram lidos
 * com um único `.in('...', [todos os ids])` sem `.range()` — acima do
 * limite o resultado era truncado silenciosamente e o produto aparecia sem
 * tamanho ou "sem estoque". Aqui: (1) os ids são fatiados em lotes pequenos,
 * (2) cada lote é lido em páginas via `.range()` até acabar, (3) erro de
 * banco é lançado — nunca tratado como "lista vazia".
 */

/** Ids por `.in()` — mantém a URL curta. */
export const IN_CHUNK_SIZE = 100
/** Linhas por página — sempre <= db-max-rows padrão (1000). */
export const PAGE_SIZE = 500

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/** Lê TODAS as linhas de uma consulta, página a página. `build` deve ter ORDER BY determinístico. */
export async function selectAllPages<T>(build: (from: number, to: number) => PageResult<T>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Falha ao consultar o catálogo de atacado: ${error.message}`)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) return all
  }
}

/** Divide `ids` em lotes e lê todas as páginas de cada lote. */
export async function selectAllInChunks<T, Id extends number | string>(
  ids: Id[],
  build: (chunk: Id[], from: number, to: number) => PageResult<T>,
): Promise<T[]> {
  const unique = Array.from(new Set(ids))
  const all: T[] = []
  for (let i = 0; i < unique.length; i += IN_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + IN_CHUNK_SIZE)
    all.push(...(await selectAllPages<T>((from, to) => build(chunk, from, to))))
  }
  return all
}
