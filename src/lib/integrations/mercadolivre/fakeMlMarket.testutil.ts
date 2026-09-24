/**
 * Double de teste (NÃO usado em produção): FakeMlApi + rotas de catálogo e
 * anúncios do Mercado Livre com a semântica documentada:
 *   - POST /items: vendedor User Products exige family_name e recusa title;
 *     legado exige title. Imagens só JPG/PNG. Cria item com user_product_id (UP).
 *   - available_quantity 0 → paused/out_of_stock; > 0 → reativa sozinho
 *     (só se a pausa for por falta de estoque).
 *   - status paused → paused_by_seller (NUNCA reativa sozinho).
 *   - priceAutomation → PUT price ignorado com warning (doc "Preços").
 */

import { FakeMlApi } from './fakeMercadoLivre.testutil'

interface FakeItem {
  id: string
  seller_id: number
  category_id: string
  price: number
  currency_id: string
  available_quantity: number
  status: string
  sub_status: string[]
  title: string
  family_name: string | null
  user_product_id: string | null
  family_id: number | null
  attributes: Array<{ id: string; value_id?: string; value_name?: string }>
  pictures: Array<{ source: string }>
  permalink: string
  description: string | null
}

export class FakeMlMarket extends FakeMlApi {
  items = new Map<string, FakeItem>()
  userProductsSeller = true
  priceAutomation = false
  /** Warnings devolvidos por /items/validate (não bloqueiam). */
  validateWarnings: Array<{ code: string; message: string }> = []
  validCategories = new Set(['MLB1234'])
  requiredAttributes = ['BRAND', 'MODEL', 'SIZE']
  /** Categoria de moda: exige SIZE_GRID_ID + SIZE_GRID_ROW_ID (validações "fashion-validator" da doc). */
  requireSizeGrid = false
  /** Tabelas do vendedor TEST: id → linhas (id da linha → tamanho). */
  sizeCharts: Record<string, { name: string; type: string; gender: string; rows: Record<string, string> }> = {
    '5001': { name: 'Tabela Sutias Feminino TEST', type: 'SPECIFIC', gender: 'Feminino', rows: { '5001:1': 'P', '5001:2': 'M', '5001:3': 'G' } },
  }
  chartSearches: Array<Record<string, unknown>> = []
  itemCounter = 0
  categoryAttributes: Array<Record<string, unknown>> = [
    { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
    { id: 'MODEL', name: 'Modelo', value_type: 'string', tags: { required: true } },
    { id: 'COLOR', name: 'Cor', value_type: 'list', tags: { allow_variations: true }, values: [{ id: '52049', name: 'Preto' }, { id: '52055', name: 'Branco' }], hierarchy: 'CHILD_PK' },
    { id: 'SIZE', name: 'Tamanho', value_type: 'string', tags: { allow_variations: true, required: true }, hierarchy: 'CHILD_PK' },
    { id: 'GTIN', name: 'Código universal', value_type: 'string', tags: { conditional_required: true } },
    { id: 'EMPTY_GTIN_REASON', name: 'Motivo GTIN vazio', value_type: 'list', tags: {}, values: [{ id: '17055160', name: 'O produto não tem código cadastrado' }] },
    { id: 'SELLER_SKU', name: 'SKU', value_type: 'string', tags: { hidden: true } },
    { id: 'ITEM_CONDITION', name: 'Condição', value_type: 'list', tags: { read_only: true } },
    { id: 'PRODUCT_DATA_SOURCE', name: 'Fonte', value_type: 'string', tags: { fixed: true } },
  ]

  private readonly baseFetch = this.fetch

  constructor() {
    super()
    this.me = { ...this.me, tags: ['normal', 'test_user', 'user_product_seller'] }
  }

  item(id: string): FakeItem | undefined {
    return this.items.get(id)
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const path = url.pathname
    const isMarket = /^\/(items|user-products|sites|categories|domains|catalog)\b/.test(path) || /^\/users\/\d+\/items\/search$/.test(path)
    if (!isMarket || this.overrides.some((o) => o.match(method, url))) return this.baseFetch(input, init)

    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? init.body : undefined
    this.calls.push({ method, url: url.toString(), headers, body })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    const token = (headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.validAccess.has(token)) return json(401, { message: 'invalid access token', status: 401 })
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {}

    // ── catálogo
    if (method === 'GET' && /^\/sites\/MLB\/domain_discovery\/search$/.test(path)) {
      return json(200, [{ domain_id: 'MLB-BRAS', domain_name: 'Sutiãs', category_id: 'MLB1234', category_name: 'Sutiãs', attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }] }])
    }
    if (method === 'GET' && path === '/categories/MLB1234') {
      return json(200, { id: 'MLB1234', name: 'Sutiãs', path_from_root: [{ id: 'MLB1', name: 'Moda' }, { id: 'MLB1234', name: 'Sutiãs' }], children_categories: [], settings: { listing_allowed: true, max_title_length: 60, currencies: ['BRL'] } })
    }
    if (method === 'GET' && path === '/categories/MLB1234/attributes') {
      return json(200, this.requireSizeGrid
        ? [...this.categoryAttributes,
          { id: 'SIZE_GRID_ID', name: 'ID da guia de tamanhos', value_type: 'grid_id', tags: { vip_hidden: true } },
          { id: 'SIZE_GRID_ROW_ID', name: 'ID da linha da guia', value_type: 'grid_row_id', tags: { hidden: true, variation_attribute: true } }]
        : this.categoryAttributes)
    }
    if (method === 'GET' && path === '/domains/MLB-BRAS/technical_specs') {
      return json(200, { input: { groups: [{ id: 'MAIN', components: [
        { component: 'COMBO', attributes: [{ id: 'BRAND', tags: ['grid_filter', 'required'] }] },
        { component: 'COMBO', attributes: [{ id: 'GENDER', tags: ['grid_template_required', 'grid_filter', 'required'] }] },
        { component: 'GRID_ROW_INPUT', attributes: [{ id: 'SIZE_GRID_ROW_ID', value_type: 'grid_row_id', tags: ['hidden'] }] },
      ] }] }, output: {} })
    }
    if (method === 'POST' && path === '/catalog/charts/search') {
      this.chartSearches.push(payload)
      if (payload.domain_id === 'HATS') return json(400, { error: 'domain_not_active', message: 'Domain MLB-HATS is not active to be used in charts.', status: 400 })
      if (String(payload.domain_id).includes('-')) return json(400, { error: 'bad_request', message: 'domain_id must not have site prefix', status: 400 })
      const gender = ((payload.attributes as Array<{ id: string; values: Array<{ name?: string }> }>) ?? []).find((a) => a.id === 'GENDER')?.values?.[0]?.name
      const charts = Object.entries(this.sizeCharts)
        .filter(([, c]) => !gender || c.gender === gender)
        .map(([id, c]) => ({ id, names: { MLB: c.name }, domain_id: 'BRAS', type: c.type, main_attribute_id: 'SIZE', attributes: [], rows: [] }))
      return json(200, { charts })
    }
    const chartMatch = path.match(/^\/catalog\/charts\/(\d+)$/)
    if (method === 'GET' && chartMatch) {
      const c = this.sizeCharts[chartMatch[1]]
      if (!c) return json(404, { error: 'not_found', message: 'Size chart not found', status: 404 })
      return json(200, {
        id: chartMatch[1], names: { MLB: c.name }, domain_id: 'BRAS', site_id: 'MLB', type: c.type, main_attribute_id: 'SIZE',
        attributes: [{ id: 'GENDER', values: [{ name: c.gender }] }],
        rows: Object.entries(c.rows).map(([rid, size]) => ({ id: rid, attributes: [{ id: 'SIZE', name: 'Tamanho', values: [{ name: size }] }] })),
      })
    }
    if (method === 'POST' && path === '/categories/MLB1234/attributes/conditional') {
      return json(200, [{ id: 'GTIN', name: 'Código universal', tags: { required: true } }])
    }

    // ── anúncios
    if (method === 'POST' && path === '/items/validate') {
      const errors = this.itemErrors(payload)
      const warnings = [...this.validateWarnings, ...this.sizeWarnings(payload)]
      if (errors.length === 0 && warnings.length === 0) return new Response(null, { status: 204 })
      return json(400, {
        message: 'Validation error', error: 'validation_error', status: 400,
        cause: [...errors.map((e) => ({ ...e, type: 'error', department: 'items' })), ...warnings.map((w) => ({ ...w, type: 'warning', department: 'items' }))],
      })
    }
    if (method === 'POST' && path === '/items') {
      const errors = this.itemErrors(payload)
      if (errors.length) return json(400, { message: 'Validation error', error: 'validation_error', status: 400, cause: errors.map((e) => ({ ...e, type: 'error' })) })
      const pictures = (payload.pictures as Array<{ source: string }>) ?? []
      const n = ++this.itemCounter
      const qty = Number(payload.available_quantity ?? 0)
      const id = `MLB${4000000 + n}`
      const item: FakeItem = {
        id, seller_id: this.me.id, category_id: String(payload.category_id), price: Number(payload.price), currency_id: String(payload.currency_id),
        available_quantity: qty, status: qty > 0 ? 'active' : 'paused', sub_status: qty > 0 ? [] : ['out_of_stock'],
        title: String(payload.title ?? `${payload.family_name} gerado`), family_name: (payload.family_name as string) ?? null,
        user_product_id: this.userProductsSeller ? `MLBU${7000 + n}` : null, family_id: this.userProductsSeller ? 9000 + n : null,
        attributes: (payload.attributes as FakeItem['attributes']) ?? [], pictures, permalink: `https://produto.mercadolivre.com.br/${id}`, description: null,
      }
      this.items.set(id, item)
      return json(201, this.view(item))
    }
    let m = path.match(/^\/items\/([A-Z0-9]+)\/description$/)
    if (m && method === 'POST') {
      const it = this.items.get(m[1])
      if (!it) return json(404, { message: 'item not found' })
      it.description = String(payload.plain_text ?? '')
      return json(201, { plain_text: it.description })
    }
    m = path.match(/^\/user-products\/([A-Z0-9]+)$/)
    if (m && method === 'GET') {
      const it = [...this.items.values()].find((i) => i.user_product_id === m![1])
      return it ? json(200, { id: m[1], family_id: it.family_id }) : json(404, { message: 'not found' })
    }
    m = path.match(/^\/items\/([A-Z0-9]+)$/)
    if (m) {
      const it = this.items.get(m[1])
      if (!it) return json(404, { message: 'item not found' })
      if (method === 'GET') return json(200, this.view(it))
      if (method === 'PUT') {
        const warnings: Array<{ code: string; message: string }> = []
        if (payload.available_quantity != null) {
          it.available_quantity = Number(payload.available_quantity)
          if (it.available_quantity === 0 && it.status === 'active') { it.status = 'paused'; it.sub_status = ['out_of_stock'] }
          if (it.available_quantity > 0 && it.status === 'paused' && it.sub_status.includes('out_of_stock')) { it.status = 'active'; it.sub_status = [] }
        }
        if (payload.price != null) {
          if (this.priceAutomation) warnings.push({ code: 'item.price.automation', message: 'price automation active; price ignored' })
          else it.price = Number(payload.price)
        }
        if (payload.status === 'paused') { it.status = 'paused'; it.sub_status = ['paused_by_seller'] }
        if (payload.status === 'active') {
          if (it.available_quantity > 0) { it.status = 'active'; it.sub_status = [] } else { it.status = 'paused'; it.sub_status = ['out_of_stock'] }
        }
        return json(200, { ...this.view(it), ...(warnings.length ? { warnings } : {}) })
      }
    }
    m = path.match(/^\/users\/(\d+)\/items\/search$/)
    if (m && method === 'GET') {
      const sku = url.searchParams.get('seller_sku')
      const results = [...this.items.values()]
        .filter((i) => String(i.seller_id) === m![1] && i.attributes.some((a) => a.id === 'SELLER_SKU' && a.value_name === sku))
        .map((i) => i.id)
      return json(200, { seller_id: m[1], results, paging: { total: results.length } })
    }
    return json(404, { message: 'not found' })
  }

  /** Mesmas regras em /items/validate e POST /items (como na API real). */
  private itemErrors(payload: Record<string, unknown>): Array<{ code: string; message: string }> {
    const errors: Array<{ code: string; message: string }> = []
    if (!this.validCategories.has(String(payload.category_id))) errors.push({ code: 'item.category_id.invalid', message: `Category ${payload.category_id} is not a valid leaf category` })
    if (this.userProductsSeller && payload.title) errors.push({ code: 'item.title.not_modifiable', message: 'title not allowed for user product sellers' })
    if (this.userProductsSeller && !payload.family_name) errors.push({ code: 'item.family_name.required', message: 'family_name is required' })
    if (!this.userProductsSeller && !payload.title) errors.push({ code: 'item.title.required', message: 'title is required' })
    const pictures = (payload.pictures as Array<{ source: string }>) ?? []
    if (pictures.length === 0 || pictures.some((p) => !/\.(jpe?g|png)$/i.test(p.source) || /broken/.test(p.source))) {
      errors.push({ code: 'item.pictures.invalid', message: 'Picture could not be downloaded or has invalid format' })
    }
    const list = (payload.attributes as Array<{ id: string; value_name?: string; value_id?: string }>) ?? []
    const attrs = new Set(list.map((a) => a.id))
    const missing = this.requiredAttributes.filter((id) => !attrs.has(id))
    if (missing.length) errors.push({ code: 'item.attributes.missing_required', message: `Missing required attributes: ${missing.join(', ')}` })
    if (this.requireSizeGrid) {
      const val = (id: string) => list.find((a) => a.id === id)?.value_name ?? list.find((a) => a.id === id)?.value_id ?? null
      const grid = val('SIZE_GRID_ID')
      const row = val('SIZE_GRID_ROW_ID')
      if (!grid) errors.push({ code: 'missing.fashion_grid.grid_id.values', message: 'Attribute [SIZE_GRID_ID] is missing' })
      else if (!this.sizeCharts[grid]) errors.push({ code: 'invalid.fashion_grid.grid_id.values', message: 'Attribute [SIZE_GRID_ID] is not valid' })
      else if (!row) errors.push({ code: 'missing.fashion_grid.grid_row_id.values', message: 'Attribute [SIZE_GRID_ROW_ID] is missing' })
      else if (!(row in this.sizeCharts[grid].rows)) errors.push({ code: 'invalid.fashion_grid.grid_row_id.values', message: 'Attribute [SIZE_GRID_ROW_ID] is not valid' })
    }
    return errors
  }

  /** SIZE do anúncio ≠ SIZE da linha → WARNING (cause_id 2615 da doc). */
  private sizeWarnings(payload: Record<string, unknown>): Array<{ code: string; message: string }> {
    if (!this.requireSizeGrid) return []
    const list = (payload.attributes as Array<{ id: string; value_name?: string }>) ?? []
    const v = (id: string) => list.find((a) => a.id === id)?.value_name
    const chart = this.sizeCharts[v('SIZE_GRID_ID') ?? '']
    const rowSize = chart?.rows[v('SIZE_GRID_ROW_ID') ?? '']
    return rowSize && rowSize !== v('SIZE') ? [{ code: 'invalid.fashion_grid.size.values', message: 'Attribute [SIZE] is not valid' }] : []
  }

  private view(it: FakeItem): Record<string, unknown> {
    const { description: _d, family_id: _f, ...rest } = it
    return { ...rest }
  }
}
