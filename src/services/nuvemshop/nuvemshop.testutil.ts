/**
 * Fakes para testes da integração Nuvemshop:
 *   - createNuvemshopFakeDb: client Supabase em memória (select/eq/in/is/
 *     order/range/limit/maybeSingle/insert/update/delete + embed
 *     `products!inner(...)` em product_variations e `stock_locations!inner`).
 *   - createFakeNuvemshopApi: lojas Nuvemshop em memória, por store_id.
 */

import type { NuvemshopCredentials, NuvemshopProductFullPayload, NuvemshopProductResponse } from '@/lib/integrations/nuvemshop'

type Row = Record<string, any>
export type NsFakeTables = Record<string, Row[]>

const RELATIONS: Record<string, Record<string, { table: string; fk: string }>> = {
  media_usages:       { media: { table: 'media', fk: 'media_id' } },
  product_variations: { products: { table: 'products', fk: 'product_id' } },
  stock_balances:     { stock_locations: { table: 'stock_locations', fk: 'stock_location_id' } },
  product_variation_attributes: {
    variation_types:  { table: 'variation_types', fk: 'variation_type_id' },
    variation_values: { table: 'variation_values', fk: 'variation_value_id' },
  },
}

/** product_variations(...) e stock_balances(...) como filhos (1:N). */
const CHILDREN: Record<string, Record<string, { table: string; fk: string }>> = {
  products:           { product_variations: { table: 'product_variations', fk: 'product_id' } },
  product_variations: {
    stock_balances:               { table: 'stock_balances', fk: 'product_variation_id' },
    product_variation_attributes: { table: 'product_variation_attributes', fk: 'product_variation_id' },
  },
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

interface Embed { name: string; inner: boolean; inside: string }

function parseEmbeds(select: string): Embed[] {
  const out: Embed[] = []
  for (const token of splitTopLevel(select.replace(/\s+/g, ' '))) {
    const m = token.match(/^(?:(\w+):(\w+)|(\w+))(!inner)?\s*\(([\s\S]*)\)$/)
    if (!m) continue
    out.push({ name: (m[1] ?? m[3]) as string, inner: !!m[4], inside: m[5] })
  }
  return out
}

function attach(table: string, row: Row, embeds: Embed[], tables: NsFakeTables, embedFilters: Array<{ embed: string; field: string; value: unknown }>): Row | null {
  const out: Row = { ...row }
  for (const e of embeds) {
    const rel = RELATIONS[table]?.[e.name]
    const child = CHILDREN[table]?.[e.name]
    if (rel) {
      const related = (tables[rel.table] ?? []).find((r) => r.id === row[rel.fk]) ?? null
      const efs = embedFilters.filter((f) => f.embed === e.name)
      const matches = related != null && efs.every((f) => related[f.field] === f.value)
      if ((e.inner && !related) || (efs.length > 0 && !matches)) {
        if (e.inner) return null
        out[e.name] = null
        continue
      }
      out[e.name] = related ? attach(rel.table, related, parseEmbeds(e.inside), tables, []) : null
    } else if (child) {
      out[e.name] = (tables[child.table] ?? [])
        .filter((r) => r[child.fk] === row.id)
        .map((r) => attach(child.table, r, parseEmbeds(e.inside), tables, []))
        .filter((r): r is Row => r != null)
    }
  }
  return out
}

let seq = 1000

export interface NsFakeDbOptions {
  /** Tabelas cujo SELECT falha (simula erro de banco). */
  failSelectTables?: string[]
  /** Colunas inexistentes (simula migration não aplicada): SELECT que as cite → erro 42703. */
  missingColumns?: string[]
  /** Emulação de RPC; sem handler → erro "função inexistente" (PGRST202). */
  rpc?: (name: string, args: any, tables: NsFakeTables) => { data: any; error: { code?: string; message: string } | null }
}

export function createNuvemshopFakeDb(tables: NsFakeTables, options: NsFakeDbOptions = {}) {
  const calls: Array<{ table: string; op: string }> = []

  function from(table: string) {
    tables[table] ??= []
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
    let embeds: Embed[] = []
    let payload: Row | Row[] | null = null
    const filters: ((r: Row) => boolean)[] = []
    const embedFilters: Array<{ embed: string; field: string; value: unknown }> = []
    const orders: Array<{ col: string; asc: boolean }> = []
    let rangeFrom = 0
    let rangeTo = Number.POSITIVE_INFINITY
    let single = false
    let selectCols = ''

    const q: any = {
      select(cols: string) { if (op === 'select') { embeds = parseEmbeds(cols); selectCols = cols } return q },
      insert(values: Row | Row[]) { op = 'insert'; payload = values; return q },
      update(values: Row) { op = 'update'; payload = values; return q },
      delete() { op = 'delete'; return q },
      eq(col: string, value: unknown) {
        if (col.includes('.')) { const [embed, field] = col.split('.'); embedFilters.push({ embed, field, value }) }
        else filters.push((r) => r[col] === value)
        return q
      },
      in(col: string, values: unknown[]) { filters.push((r) => values.includes(r[col])); return q },
      is(col: string, value: null) { filters.push((r) => (r[col] ?? null) === value); return q },
      order(col: string, opts?: { ascending?: boolean }) { orders.push({ col, asc: opts?.ascending !== false }); return q },
      range(a: number, b: number) { rangeFrom = a; rangeTo = b; return q },
      limit(n: number) { rangeFrom = 0; rangeTo = n - 1; return q },
      maybeSingle() { single = true; return q },
      then(resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) {
        try { return Promise.resolve(run()).then(resolve, reject) } catch (e) { return Promise.reject(e).then(resolve, reject) }
      },
    }

    function run() {
      calls.push({ table, op })
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload as Row]
        const inserted = list.map((v) => ({ id: v.id ?? `row-${seq++}`, ...v }))
        tables[table].push(...inserted)
        return { data: inserted, error: null }
      }
      if (op === 'select') {
        const missing = (options.missingColumns ?? []).find((c) => new RegExp(`\\b${c}\\b`).test(selectCols))
        if (missing) return { data: null, error: { code: '42703', message: `column products_1.${missing} does not exist` } }
        if ((options.failSelectTables ?? []).includes(table)) return { data: null, error: { code: '57014', message: `canceling statement due to statement timeout (${table})` } }
      }
      const matched = tables[table].filter((r) => filters.every((f) => f(r)))
      if (op === 'update') { for (const r of matched) Object.assign(r, payload); return { data: matched, error: null } }
      if (op === 'delete') { tables[table] = tables[table].filter((r) => !matched.includes(r)); return { data: matched, error: null } }

      let rows = matched.map((r) => attach(table, r, embeds, tables, embedFilters)).filter((r): r is Row => r != null)
      for (const { col, asc } of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1)))
      }
      const page = rows.slice(rangeFrom, Math.min(rangeTo + 1, rangeFrom + 1000))
      return { data: single ? (page[0] ?? null) : page, error: null }
    }
    return q
  }

  const rpc = async (name: string, args: any) => {
    calls.push({ table: `rpc:${name}`, op: 'rpc' })
    return options.rpc
      ? options.rpc(name, args, tables)
      : { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } }
  }

  // Supabase Storage: só o necessário para resolveMediaUrl (bucket público).
  const storage = {
    from: (bucket: string) => ({
      getPublicUrl: (key: string) => ({ data: { publicUrl: `https://storage.test/storage/v1/object/public/${bucket}/${key}` } }),
      createSignedUrl: async (key: string) => ({ data: { signedUrl: `https://storage.test/storage/v1/object/sign/${bucket}/${key}?token=x` }, error: null }),
    }),
  }

  return { from, calls, rpc, storage }
}

// ─── API Nuvemshop fake ───────────────────────────────────────────────────────

export class FakeNotFound extends Error {
  status = 404
}

export function createFakeNuvemshopApi() {
  let nextId = 5000
  const stores = new Map<string, Map<string, NuvemshopProductResponse>>()
  const stock = new Map<string, number>() // `${store}:${product}:${variant}` → qty
  const calls = {
    create: 0,
    createPayloads: [] as NuvemshopProductFullPayload[],
    addedImages: [] as Array<{ productId: string; src: string; position?: number }>,
    stockPuts: [] as Array<{ storeId: string; productId: string; variantId: string; qty: number }>,
  }
  /** Se true, a criação devolve as variantes em ordem invertida. */
  const options = {
    reverseVariants: false,
    duplicateRemoteSku: false,
    /** Quantas imagens do POST /products a loja "aceita" (simula recusa parcial). */
    acceptInitialImages: undefined as number | undefined,
    /** Posições cuja inclusão posterior falha. */
    failAddImagePositions: [] as number[],
  }

  const store = (creds?: NuvemshopCredentials) => {
    const id = creds?.storeId ?? 'env'
    if (!stores.has(id)) stores.set(id, new Map())
    return stores.get(id)!
  }

  return {
    stores, stock, calls, options,
    /** Simula exclusão manual no painel da Nuvemshop. */
    deleteRemote(storeId: string, productId: string) { stores.get(storeId)?.delete(String(productId)) },
    deleteRemoteVariant(storeId: string, productId: string, variantId: string) {
      const p = stores.get(storeId)?.get(String(productId))
      if (p) p.variants = p.variants.filter((v) => String(v.id) !== String(variantId))
    },
    addRemote(storeId: string, product: NuvemshopProductResponse) {
      if (!stores.has(storeId)) stores.set(storeId, new Map())
      stores.get(storeId)!.set(String(product.id), product)
    },

    async createNuvemshopProductFull(payload: NuvemshopProductFullPayload, creds?: NuvemshopCredentials): Promise<NuvemshopProductResponse> {
      calls.create++
      const id = nextId++
      let variants = payload.variants.map((v) => ({ id: nextId++, sku: v.sku ?? null, price: v.price.toFixed(2), stock: v.stock }))
      if (options.duplicateRemoteSku && variants.length > 1) variants[1].sku = variants[0].sku
      if (options.reverseVariants) variants = [...variants].reverse()
      const images = (payload.images ?? []).slice(0, options.acceptInitialImages ?? Infinity).map((img, i) => ({ id: nextId++, src: img.src, position: img.position ?? i + 1 }))
      calls.createPayloads.push(JSON.parse(JSON.stringify(payload)))
      const product = { id, name: { pt: payload.name }, variants, images }
      store(creds).set(String(id), product)
      return JSON.parse(JSON.stringify(product))
    },
    async addNuvemshopProductImage(productId: string, image: { src: string; position?: number }, creds?: NuvemshopCredentials) {
      const p = store(creds).get(String(productId))
      if (!p) throw new FakeNotFound('Nuvemshop addProductImage 404')
      if (image.position != null && options.failAddImagePositions.includes(image.position)) throw new Error(`Nuvemshop addProductImage 422: imagem ${image.position} inacessível`)
      calls.addedImages.push({ productId: String(productId), ...image })
      const img = { id: nextId++, src: image.src, position: image.position }
      ;(p.images ??= []).push(img)
      return img
    },
    async getNuvemshopProduct(id: string, creds?: NuvemshopCredentials) {
      const p = store(creds).get(String(id))
      return p ? JSON.parse(JSON.stringify(p)) : null
    },
    async getNuvemshopProductBySku(sku: string, creds?: NuvemshopCredentials) {
      for (const p of store(creds).values()) if (p.variants.some((v) => v.sku === sku)) return JSON.parse(JSON.stringify(p))
      return null
    },
    async listAllNuvemshopProducts(creds?: NuvemshopCredentials) {
      return [...store(creds).values()].map((p) => JSON.parse(JSON.stringify(p)))
    },
    async updateVariantStock(productId: string, variantId: string, qty: number, creds?: NuvemshopCredentials) {
      const p = store(creds).get(String(productId))
      if (!p || !p.variants.some((v) => String(v.id) === String(variantId))) throw new FakeNotFound('Nuvemshop updateVariantStock 404: Not Found')
      calls.stockPuts.push({ storeId: creds?.storeId ?? 'env', productId: String(productId), variantId: String(variantId), qty })
      stock.set(`${creds?.storeId ?? 'env'}:${productId}:${variantId}`, qty)
    },
    isNuvemshopNotFound(err: unknown) { return err instanceof FakeNotFound },
  }
}

export type FakeNuvemshopApi = ReturnType<typeof createFakeNuvemshopApi>

/** Cenário base: empresa 1 (loja 111) e empresa 2 (loja 222). */
export function baseTables(): NsFakeTables {
  return {
    products: [
      { id: 10, company_id: 1, name: 'Vestido Rosa', base_price: 100, photo_url: null, active: true },
      { id: 11, company_id: 1, name: 'Saia Sem Estoque', base_price: 80, photo_url: null, active: true },
      { id: 20, company_id: 2, name: 'Blusa Outra Empresa', base_price: 60, photo_url: null, active: true },
    ],
    product_variations: [
      { id: 101, product_id: 10, sku_variation: 'VR-P', active: true },
      { id: 102, product_id: 10, sku_variation: 'VR-M', active: true },
      { id: 111, product_id: 11, sku_variation: 'SS-U', active: true },
      { id: 201, product_id: 20, sku_variation: 'BO-U', active: true },
    ],
    product_variation_attributes: [],
    stock_locations: [{ id: 1, active: true }],
    stock_balances: [
      { id: 1, product_variation_id: 101, stock_location_id: 1, quantity: 3 },
      { id: 2, product_variation_id: 102, stock_location_id: 1, quantity: 5 },
      { id: 3, product_variation_id: 201, stock_location_id: 1, quantity: 7 },
    ],
    produto_map: [],
    nuvemshop_sync_logs: [],
    media: [
      mediaRow(1, 1, 'p10-main', 'jpg'),
      mediaRow(2, 1, 'p10-gal', 'png'),
      mediaRow(3, 1, 'p11-main', 'jpg'),
      mediaRow(4, 2, 'p20-main', 'jpg'),
    ],
    media_usages: [
      usageRow(1, 1, 1, 'product', '10', 'primary', 0),
      usageRow(2, 2, 1, 'product', '10', 'gallery', 0),
      usageRow(3, 3, 1, 'product', '11', 'primary', 0),
      usageRow(4, 4, 2, 'product', '20', 'primary', 0),
    ],
  }
}

let usageSeq = 0
/** Linha de `media` pública/ativa/pronta (sobrescreva campos com `over`). */
export function mediaRow(id: number, companyId: number, name: string, extension: string, over: Record<string, unknown> = {}) {
  return {
    id, public_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, company_id: companyId,
    storage_key: `${companyId}/${name}.${extension}`, external_url: null, visibility: 'public',
    extension, mime_type: extension === 'jpg' ? 'image/jpeg' : `image/${extension}`, status: 'ready', active: true, ...over,
  }
}

export function usageRow(id: number, mediaId: number, companyId: number, entityType: string, entityId: string, role: string, position: number) {
  usageSeq++
  return { id, media_id: mediaId, company_id: companyId, entity_type: entityType, entity_id: entityId, role, position, created_at: `2026-09-25T00:00:${String(usageSeq % 60).padStart(2, '0')}Z` }
}

export const publicUrl = (key: string) => `https://storage.test/storage/v1/object/public/media-public/${key}`

export const ctxCompany1 = { companyId: 1, storeId: '111', integrationId: 1, source: 'company_integration' as const, credentials: { storeId: '111', accessToken: 't1' } }
export const ctxCompany2 = { companyId: 2, storeId: '222', integrationId: 2, source: 'company_integration' as const, credentials: { storeId: '222', accessToken: 't2' } }
