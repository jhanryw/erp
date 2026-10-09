/**
 * Cache em memória (por processo) do site público de atacado — curto, por empresa e com invalidação.
 *
 * Por que em memória e não `unstable_cache`/CDN: as rotas do atacado são `force-dynamic` + `force-no-store`
 * de propósito (nenhum dado de catálogo/estoque pode ficar preso no cache de dados do Next). Aqui o controle é
 * explícito: a chave SEMPRE começa com o `company_id` (nenhum dado atravessa tenants), o TTL é curto (padrão 30 s)
 * e as mutações feitas no ERP (configurações, banners, capas) invalidam a empresa na hora — ERP e site rodam no
 * mesmo processo. Requisições simultâneas ao mesmo dado compartilham UMA carga (single-flight).
 *
 * O que NÃO passa por aqui: validação do carrinho e criação do pedido (preço, estoque, mínimo e disponibilidade
 * continuam lidos direto do banco a cada operação) e a página de produto.
 */

interface Entry { value: unknown; expiresAt: number }

const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
const MAX_ENTRIES = 500

const DEFAULT_TTL_MS = 30_000
let ttlOverride: number | null = null

export function cacheTtlMs(): number {
  if (ttlOverride !== null) return ttlOverride
  const fromEnv = Number(process.env.WHOLESALE_CACHE_TTL_MS)
  if (Number.isFinite(fromEnv) && fromEnv >= 0 && process.env.WHOLESALE_CACHE_TTL_MS !== undefined) return fromEnv
  // Testes unitários dependem de ler o banco a cada chamada; quem quer testar o cache liga explicitamente.
  return process.env.NODE_ENV === 'test' ? 0 : DEFAULT_TTL_MS
}

/** Uso em testes. `null` volta ao padrão. */
export function configureWholesaleCache(options: { ttlMs: number | null }): void {
  ttlOverride = options.ttlMs
  clearWholesaleCache()
}

export function clearWholesaleCache(): void {
  store.clear()
  inflight.clear()
}

const companyKey = (companyId: number, key: string) => `c${companyId}:${key}`

/** Lê do cache ou carrega. A chave é prefixada com a empresa — nunca compartilhada entre tenants. */
export async function cachedForCompany<T>(companyId: number, key: string, loader: () => Promise<T>): Promise<T> {
  const ttl = cacheTtlMs()
  if (ttl <= 0) return loader()

  const k = companyKey(companyId, key)
  const hit = store.get(k)
  if (hit && hit.expiresAt > Date.now()) return hit.value as T

  const pending = inflight.get(k)
  if (pending) return pending as Promise<T>

  const promise = loader()
    .then((value) => {
      if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string)
      store.set(k, { value, expiresAt: Date.now() + ttl })
      return value
    })
    .finally(() => { inflight.delete(k) })

  inflight.set(k, promise)
  return promise
}

/** Descarta tudo o que está em cache da empresa (chame após qualquer mutação no ERP que afete o site). */
export function invalidateWholesaleCompany(companyId: number): void {
  const prefix = `c${companyId}:`
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k)
  for (const k of inflight.keys()) if (k.startsWith(prefix)) inflight.delete(k)
}

/**
 * Mede uma etapa e registra UMA linha JSON quando `WHOLESALE_PERF_LOG=1` (desligado por padrão).
 * Sem dados pessoais: só rótulo, empresa e milissegundos.
 */
export async function timed<T>(label: string, companyId: number, fn: () => Promise<T>): Promise<T> {
  if (process.env.WHOLESALE_PERF_LOG !== '1') return fn()
  const start = performance.now()
  try {
    return await fn()
  } finally {
    console.info(JSON.stringify({ scope: 'wholesale-perf', label, companyId, ms: Math.round(performance.now() - start) }))
  }
}
