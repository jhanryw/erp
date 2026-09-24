/**
 * Tabelas de medidas (size charts) do Mercado Livre — moda.
 *
 * Docs oficiais ("Guia de tamanhos" → Primeiros passos / Gerenciar /
 * Validações):
 *   - a categoria/domínio exige tabela quando tem atributo `value_type:
 *     grid_id` (SIZE_GRID_ID, nível item/família) e `grid_row_id`
 *     (SIZE_GRID_ROW_ID, nível variação/item);
 *   - filtros da busca = atributos com tag `grid_template_required` /
 *     `grid_filter` na ficha técnica do domínio (GET /domains/{id}/technical_specs);
 *   - POST /catalog/charts/search {domain_id SEM prefixo do site, site_id,
 *     seller_id, attributes} → charts (BRAND, STANDARD, SPECIFIC do vendedor);
 *   - GET /catalog/charts/{id} → linhas ("{chart}:{n}") com SIZE/tamanho;
 *   - o SIZE do anúncio deve coincidir com o da linha escolhida.
 * Nada aqui é fixo por categoria: tudo vem da ficha técnica e da busca.
 */

import { mercadoLivreRequest, type MercadoLivreRequestDeps } from './client'
import type { AttributeDefinition } from './catalog'
import type { ChannelAttributeValue } from '@/lib/channels/types'

interface Ctx {
  integrationId: number
  companyId: number
  deps?: MercadoLivreRequestDeps
}

export interface SizeGridAttributes {
  /** id do atributo de tabela (value_type grid_id) — ex.: SIZE_GRID_ID */
  grid_attribute_id: string
  /** id do atributo de linha (value_type grid_row_id) — ex.: SIZE_GRID_ROW_ID */
  row_attribute_id: string
}

/** Detecta, pelos TIPOS dos atributos da categoria, se ela usa tabela de medidas. */
export function detectSizeGrid(definitions: Array<Pick<AttributeDefinition, 'id' | 'value_type'>>): SizeGridAttributes | null {
  const grid = definitions.find((d) => d.value_type === 'grid_id')
  const row = definitions.find((d) => d.value_type === 'grid_row_id')
  if (!grid) return null
  return { grid_attribute_id: grid.id, row_attribute_id: row?.id ?? `${grid.id.replace(/_ID$/, '')}_ROW_ID` }
}

/** "MLB-BRAS" → "BRAS" (a busca de tabelas exige domínio sem prefixo do site). */
export function stripSitePrefix(domainId: string): string {
  return domainId.replace(/^[A-Z]{3}-/, '')
}

export interface SizeChartFilterSpec {
  /** Obrigatórios para buscar a tabela (tag grid_template_required). */
  required: string[]
  /** Filtros aceitos (grid_filter + grid_template_required). */
  accepted: string[]
}

/** Lê a ficha técnica do domínio e extrai os atributos que filtram a tabela. */
export function parseGridFilterSpec(technicalSpecs: unknown): SizeChartFilterSpec {
  const required = new Set<string>()
  const accepted = new Set<string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (typeof obj.id === 'string' && Array.isArray(obj.tags)) {
      const tags = obj.tags as string[]
      if (tags.includes('grid_template_required')) { required.add(obj.id); accepted.add(obj.id) }
      if (tags.includes('grid_filter')) accepted.add(obj.id)
    }
    for (const v of Object.values(obj)) if (v && typeof v === 'object') walk(v)
  }
  walk(technicalSpecs)
  return { required: [...required], accepted: [...accepted] }
}

export async function getSizeChartFilterSpec(ctx: Ctx, domainId: string): Promise<SizeChartFilterSpec> {
  const res = await mercadoLivreRequest<unknown>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET',
    path: `/domains/${encodeURIComponent(domainId)}/technical_specs`, deps: ctx.deps,
  })
  return parseGridFilterSpec(res.data)
}

export interface SizeChartSummary {
  id: string
  name: string
  type: string | null
  main_attribute_id: string | null
}

export interface SizeChartRow {
  id: string
  /** Valores de tamanho da linha (SIZE, atributo principal e secundário), p/ casar com o SIZE da variação. */
  sizes: string[]
  label: string
}

export interface SizeChart extends SizeChartSummary {
  domain_id: string | null
  rows: SizeChartRow[]
}

function chartName(names: unknown, siteId?: string): string {
  if (!names || typeof names !== 'object') return ''
  const map = names as Record<string, string>
  return (siteId && map[siteId]) || Object.values(map)[0] || ''
}

export async function searchSizeCharts(
  ctx: Ctx,
  input: { domainId: string; siteId: string; sellerId: string; attributes: ChannelAttributeValue[] },
): Promise<SizeChartSummary[]> {
  const res = await mercadoLivreRequest<{ charts?: Array<Record<string, unknown>> }>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'POST', path: '/catalog/charts/search',
    body: {
      domain_id: stripSitePrefix(input.domainId),
      site_id: input.siteId,
      seller_id: Number(input.sellerId),
      attributes: input.attributes
        .filter((a) => (a.value_name ?? '').toString().trim() || (a.value_id ?? '').toString().trim())
        .map((a) => ({ id: a.id, values: [{ ...(a.value_id ? { id: a.value_id } : {}), ...(a.value_name ? { name: a.value_name } : {}) }] })),
    },
    deps: ctx.deps,
  })
  return (res.data?.charts ?? [])
    .filter((c) => c && c.id != null)
    .map((c) => ({
      id: String(c.id),
      name: chartName(c.names, input.siteId),
      type: (c.type as string) ?? null,
      main_attribute_id: (c.main_attribute_id as string) ?? null,
    }))
}

export function parseSizeChart(raw: Record<string, unknown>, siteId?: string): SizeChart {
  const main = (raw.main_attribute_id as string) ?? null
  const secondary = (raw.secondary_attribute_id as string) ?? null
  const rows = Array.isArray(raw.rows) ? (raw.rows as Array<Record<string, unknown>>) : []
  return {
    id: String(raw.id),
    name: chartName(raw.names, siteId),
    type: (raw.type as string) ?? null,
    main_attribute_id: main,
    domain_id: (raw.domain_id as string) ?? null,
    rows: rows.filter((r) => r.id != null).map((r) => {
      const attrs = Array.isArray(r.attributes) ? (r.attributes as Array<Record<string, unknown>>) : []
      const valueOf = (id: string | null) => {
        const a = id ? attrs.find((x) => x.id === id) : undefined
        const v = a && Array.isArray(a.values) ? (a.values as Array<{ name?: string }>)[0]?.name : undefined
        return v ? String(v) : null
      }
      const sizes = [...new Set([valueOf('SIZE'), valueOf(main), valueOf(secondary)].filter((x): x is string => Boolean(x)))]
      return { id: String(r.id), sizes, label: sizes.join(' / ') || String(r.id) }
    }),
  }
}

export async function getSizeChart(ctx: Ctx, chartId: string, siteId?: string): Promise<SizeChart> {
  const res = await mercadoLivreRequest<Record<string, unknown>>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'GET',
    path: `/catalog/charts/${encodeURIComponent(chartId)}`, deps: ctx.deps,
  })
  return parseSizeChart(res.data, siteId)
}

const normalizeSize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, '').replace(/,/g, '.')

/**
 * Linha da tabela cujo tamanho coincide com o da variação (o ML exige
 * SIZE idêntico ao da linha). Sem correspondência única → null (usuário escolhe).
 */
export function matchSizeChartRow(rows: SizeChartRow[], size: string | null | undefined): SizeChartRow | null {
  if (!size?.trim()) return null
  const target = normalizeSize(size)
  const hits = rows.filter((r) => r.sizes.some((s) => normalizeSize(s) === target))
  return hits.length === 1 ? hits[0] : null
}
