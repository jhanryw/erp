import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import {
  detectSizeGrid, getSizeChart, getSizeChartFilterSpec, matchSizeChartRow, parseGridFilterSpec, parseSizeChart,
  searchSizeCharts, stripSitePrefix,
} from './sizeCharts'
import { clearMercadoLivreCatalogCache, getCategoryAttributes } from './catalog'
import { createMercadoLivreAdapter } from './adapter'
import { setMercadoLivreLogSink } from './log'
import { FakeMlDb, TEST_CONFIG, setTestCipherEnv } from './fakeMercadoLivre.testutil'
import { FakeMlMarket } from './fakeMlMarket.testutil'
import type { ChannelListingDraft } from '@/lib/channels/types'

beforeAll(() => setTestCipherEnv())

const COMPANY = 10
let db: FakeMlDb
let api: FakeMlMarket
let integrationId: number
const deps = () => ({ config: TEST_CONFIG, store: db.store(), fetchImpl: api.fetch, sleep: async () => {} })
const ctx = () => ({ integrationId, companyId: COMPANY, deps: deps() })

beforeEach(() => {
  db = new FakeMlDb()
  api = new FakeMlMarket()
  api.requireSizeGrid = true
  const pair = api.issue()
  integrationId = db.seedConnected(COMPANY, String(api.me.id), { access: pair.access_token, refresh: pair.refresh_token, expiresAt: new Date(Date.now() + 3600_000) })
  setMercadoLivreLogSink(() => {})
  clearMercadoLivreCatalogCache()
})
afterEach(() => setMercadoLivreLogSink(null))

describe('tabela de medidas — puro', () => {
  it('detecta pela TIPAGEM dos atributos (grid_id/grid_row_id), não por categoria', () => {
    expect(detectSizeGrid([{ id: 'SIZE_GRID_ID', value_type: 'grid_id' }, { id: 'SIZE_GRID_ROW_ID', value_type: 'grid_row_id' }]))
      .toEqual({ grid_attribute_id: 'SIZE_GRID_ID', row_attribute_id: 'SIZE_GRID_ROW_ID' })
    expect(detectSizeGrid([{ id: 'X_GRID', value_type: 'grid_id' }, { id: 'X_ROW', value_type: 'grid_row_id' }]))
      .toEqual({ grid_attribute_id: 'X_GRID', row_attribute_id: 'X_ROW' })
    expect(detectSizeGrid([{ id: 'SIZE', value_type: 'string' }])).toBeNull()
  })

  it('domínio sem prefixo do site', () => {
    expect(stripSitePrefix('MLB-BRAS')).toBe('BRAS')
    expect(stripSitePrefix('BRAS')).toBe('BRAS')
  })

  it('filtros da busca vêm da ficha técnica (grid_template_required / grid_filter)', () => {
    const spec = parseGridFilterSpec({ input: { groups: [{ components: [
      { attributes: [{ id: 'GENDER', tags: ['grid_template_required', 'grid_filter'] }] },
      { attributes: [{ id: 'BRAND', tags: ['grid_filter'] }] },
      { attributes: [{ id: 'COLOR', tags: ['required'] }] },
    ] }] } })
    expect(spec).toEqual({ required: ['GENDER'], accepted: ['GENDER', 'BRAND'] })
  })

  it('linhas: tamanhos de SIZE + atributo principal; casamento exato normalizado e único', () => {
    const chart = parseSizeChart({
      id: 9, names: { MLB: 'T' }, main_attribute_id: 'BR_SIZE', rows: [
        { id: '9:1', attributes: [{ id: 'SIZE', values: [{ name: 'P' }] }, { id: 'BR_SIZE', values: [{ name: '38 BR' }] }] },
        { id: '9:2', attributes: [{ id: 'SIZE', values: [{ name: 'M' }] }] },
        { id: '9:3', attributes: [{ id: 'SIZE', values: [{ name: '42,5' }] }] },
      ],
    }, 'MLB')
    expect(chart.rows[0]).toEqual({ id: '9:1', sizes: ['P', '38 BR'], label: 'P / 38 BR' })
    expect(matchSizeChartRow(chart.rows, 'p')?.id).toBe('9:1')
    expect(matchSizeChartRow(chart.rows, '38br')?.id).toBe('9:1')
    expect(matchSizeChartRow(chart.rows, '42.5')?.id).toBe('9:3')
    expect(matchSizeChartRow(chart.rows, 'GG')).toBeNull()
    expect(matchSizeChartRow(chart.rows, '')).toBeNull()
  })
})

describe('tabela de medidas — API (ML simulado)', () => {
  it('categoria de moda expõe SIZE_GRID_ID/SIZE_GRID_ROW_ID pelos tipos', async () => {
    expect(detectSizeGrid(await getCategoryAttributes(ctx(), 'MLB1234'))).toEqual({ grid_attribute_id: 'SIZE_GRID_ID', row_attribute_id: 'SIZE_GRID_ROW_ID' })
  })

  it('busca: domínio sem prefixo, seller_id numérico, filtros; depois linhas da tabela', async () => {
    const spec = await getSizeChartFilterSpec(ctx(), 'MLB-BRAS')
    expect(spec.required).toEqual(['GENDER'])
    const charts = await searchSizeCharts(ctx(), { domainId: 'MLB-BRAS', siteId: 'MLB', sellerId: '555', attributes: [{ id: 'GENDER', value_name: 'Feminino' }, { id: 'BRAND', value_name: '' }] })
    expect(api.chartSearches[0]).toEqual({ domain_id: 'BRAS', site_id: 'MLB', seller_id: 555, attributes: [{ id: 'GENDER', values: [{ name: 'Feminino' }] }] })
    expect(charts).toEqual([{ id: '5001', name: 'Tabela Sutias Feminino TEST', type: 'SPECIFIC', main_attribute_id: 'SIZE' }])
    const chart = await getSizeChart(ctx(), '5001', 'MLB')
    expect(chart.rows.map((r) => [r.id, r.sizes[0]])).toEqual([['5001:1', 'P'], ['5001:2', 'M'], ['5001:3', 'G']])
  })

  it('domínio sem tabela ativa → erro tipado domain_not_active (UI não bloqueia)', async () => {
    await expect(searchSizeCharts(ctx(), { domainId: 'MLB-HATS', siteId: 'MLB', sellerId: '555', attributes: [] }))
      .rejects.toMatchObject({ kind: 'bad_request', mlError: 'domain_not_active' })
  })

  describe('validate com tabela de medidas', () => {
    const draft = (extra: Array<{ id: string; value_name: string }>, size = 'M'): ChannelListingDraft => ({
      sellerSku: 'TEST-ML-NORMAL-01', productName: 'Item de Teste ML', title: 'x', description: null, categoryId: 'MLB1234',
      price: 10, currencyId: 'BRL', quantity: 5, pictureUrls: ['https://cdn.example.com/a.jpg'], channelOptions: {},
      attributes: [{ id: 'BRAND', value_name: 'TEST' }, { id: 'MODEL', value_name: 'TEST' }, { id: 'SIZE', value_name: size }, ...extra],
    })
    const adapter = () => createMercadoLivreAdapter({ integrationId, companyId: COMPANY, sellerId: '555', model: 'user_products', deps: deps() })

    it('sem SIZE_GRID_ID → erro missing.fashion_grid.grid_id (bloqueia)', async () => {
      const r = await adapter().validateListing!(draft([]))
      expect(r.ok).toBe(false)
      expect(r.errors.map((e) => e.code)).toContain('missing.fashion_grid.grid_id.values')
    })

    it('tabela sem linha → missing grid_row_id; linha de outra tabela → invalid', async () => {
      expect((await adapter().validateListing!(draft([{ id: 'SIZE_GRID_ID', value_name: '5001' }]))).errors[0].code).toBe('missing.fashion_grid.grid_row_id.values')
      expect((await adapter().validateListing!(draft([{ id: 'SIZE_GRID_ID', value_name: '5001' }, { id: 'SIZE_GRID_ROW_ID', value_name: '999:1' }]))).errors[0].code).toBe('invalid.fashion_grid.grid_row_id.values')
    })

    it('tabela + linha corretas → ok; SIZE diferente da linha → só warning (não bloqueia)', async () => {
      expect(await adapter().validateListing!(draft([{ id: 'SIZE_GRID_ID', value_name: '5001' }, { id: 'SIZE_GRID_ROW_ID', value_name: '5001:2' }]))).toEqual({ ok: true, errors: [], warnings: [] })
      const w = await adapter().validateListing!(draft([{ id: 'SIZE_GRID_ID', value_name: '5001' }, { id: 'SIZE_GRID_ROW_ID', value_name: '5001:3' }], 'M'))
      expect(w.ok).toBe(true)
      expect(w.warnings.map((x) => x.code)).toEqual(['invalid.fashion_grid.size.values'])
    })
  })
})
