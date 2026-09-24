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

// ─── Criação de tabela SPECIFIC (POST /catalog/charts) ──────────────────────
//
// Doc "Gerenciar guia de tamanhos" + "Primeiros passos":
//   - ficha técnica da TABELA: POST /domains/{domain_id}/technical_specs?section=grids
//     com os atributos grid_template_required (ex.: gênero) no corpo;
//   - atributos grid_filter/grid_template_required vão no nível GERAL da
//     tabela (nunca nas linhas); BRAND também no nível geral;
//   - nas LINHAS: só os atributos `required` + ao menos um
//     `main_attribute_candidate` (o escolhido vira main_attribute);
//   - TOPS/BOTTOMS: atributos com tag BODY_MEASURE ou CLOTHING_MEASURE; a
//     tabela tem UM measure_type (não mistura);
//   - names: até 60 caracteres, só letras, números e espaços;
//   - domain_id SEM prefixo do site.

export interface ChartTemplateAttribute {
  id: string
  name: string
  value_type: string
  tags: string[]
  values: Array<{ id: string; name: string }>
  units: string[]
  default_unit: string | null
  /** BODY_MEASURE | CLOTHING_MEASURE | null */
  measure_type: 'BODY_MEASURE' | 'CLOTHING_MEASURE' | null
}

export interface ChartTemplate {
  /** Nível geral (gênero, marca, estilo…): grid_filter/grid_template_required, não read_only. */
  chart_attributes: ChartTemplateAttribute[]
  /** Candidatos a atributo principal (tamanho) das linhas. */
  main_attribute_candidates: ChartTemplateAttribute[]
  /** Atributos obrigatórios nas linhas (filtrados depois pelo measure_type escolhido). */
  row_attributes: ChartTemplateAttribute[]
  /** Tipos de medida disponíveis (vazio = domínio sem essa distinção). */
  measure_types: Array<'BODY_MEASURE' | 'CLOTHING_MEASURE'>
}

function collectTemplateAttributes(node: unknown, out: Map<string, ChartTemplateAttribute>): void {
  if (Array.isArray(node)) { node.forEach((n) => collectTemplateAttributes(n, out)); return }
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (Array.isArray(obj.attributes)) {
    for (const a of obj.attributes as Array<Record<string, unknown>>) {
      if (!a || typeof a.id !== 'string' || out.has(a.id)) continue
      const tags = Array.isArray(a.tags) ? (a.tags as unknown[]).map(String) : []
      out.set(a.id, {
        id: a.id,
        name: String(a.name ?? a.id),
        value_type: String(a.value_type ?? 'string'),
        tags,
        values: Array.isArray(a.values) ? (a.values as Array<{ id: unknown; name: unknown }>).filter((v) => v?.name != null).map((v) => ({ id: String(v.id ?? ''), name: String(v.name) })) : [],
        units: Array.isArray(a.units) ? (a.units as Array<{ id: unknown }>).map((u) => String(u.id)).filter(Boolean) : [],
        default_unit: typeof a.default_unit_id === 'string' ? a.default_unit_id : null,
        measure_type: tags.includes('BODY_MEASURE') ? 'BODY_MEASURE' : tags.includes('CLOTHING_MEASURE') ? 'CLOTHING_MEASURE' : null,
      })
    }
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'attributes' && v && typeof v === 'object') collectTemplateAttributes(v, out)
}

export function parseChartTemplate(spec: unknown): ChartTemplate {
  const all = new Map<string, ChartTemplateAttribute>()
  collectTemplateAttributes(spec, all)
  const attrs = [...all.values()]
  const isGeneral = (a: ChartTemplateAttribute) => a.tags.includes('grid_filter') || a.tags.includes('grid_template_required')
  const chart_attributes = attrs.filter((a) => isGeneral(a) && !a.tags.includes('read_only'))
  const main_attribute_candidates = attrs.filter((a) => !isGeneral(a) && a.tags.includes('main_attribute_candidate'))
  const row_attributes = attrs.filter((a) => !isGeneral(a) && a.tags.includes('required') && !a.tags.includes('main_attribute_candidate'))
  const measure_types = [...new Set(attrs.map((a) => a.measure_type).filter((m): m is 'BODY_MEASURE' | 'CLOTHING_MEASURE' => Boolean(m)))]
  return { chart_attributes, main_attribute_candidates, row_attributes, measure_types }
}

/** Atributos de linha exigidos para o measure_type escolhido (os sem tag de medida valem para ambos). */
export function rowAttributesFor(template: ChartTemplate, measureType: string | null): ChartTemplateAttribute[] {
  return template.row_attributes.filter((a) => !a.measure_type || !measureType || a.measure_type === measureType)
}

export async function getChartTemplate(ctx: Ctx, domainId: string, templateAttributes: ChannelAttributeValue[]): Promise<ChartTemplate> {
  const res = await mercadoLivreRequest<unknown>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'POST',
    path: `/domains/${encodeURIComponent(domainId)}/technical_specs`, query: { section: 'grids' },
    body: {
      attributes: templateAttributes.map((a) => ({
        id: a.id,
        ...(a.value_id ? { value_id: a.value_id } : {}),
        ...(a.value_name ? { value_name: a.value_name } : {}),
        values: [{ ...(a.value_id ? { id: a.value_id } : {}), ...(a.value_name ? { name: a.value_name } : {}) }],
      })),
    },
    deps: ctx.deps,
  })
  return parseChartTemplate(res.data)
}

/** Valor de célula informado pelo usuário: texto livre, opção de lista ou número (+unidade). */
export interface ChartCellValue {
  value_id?: string | null
  value_name?: string | null
}

export interface NewSizeChartInput {
  name: string
  siteId: string
  domainId: string
  measureType: string | null
  mainAttributeId: string
  /** Nível geral (gênero, marca…). */
  attributes: ChannelAttributeValue[]
  /** Uma entrada por linha (tamanho): attributeId → valor. */
  rows: Array<Record<string, ChartCellValue>>
}

export class SizeChartInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SizeChartInputError'
  }
}

/** Nome aceito pelo ML: ≤ 60, só letras, números e espaços. */
export function sanitizeChartName(name: string): string {
  return name.normalize('NFC').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim()
}

function cellValue(def: ChartTemplateAttribute, cell: ChartCellValue | undefined): { id?: string; name?: string } | null {
  const id = cell?.value_id?.toString().trim() || ''
  let name = cell?.value_name?.toString().trim() || ''
  if (def.value_type === 'list' || def.value_type === 'boolean') {
    const opt = def.values.find((v) => (id && v.id === id) || (name && v.name.localeCompare(name, 'pt-BR', { sensitivity: 'base' }) === 0))
    if (!opt) return null
    return { ...(opt.id ? { id: opt.id } : {}), name: opt.name }
  }
  if (!name) return null
  if (def.value_type === 'number_unit') {
    // "82" → "82 cm" (unidade padrão da ficha); "82 cm" é mantido
    if (/^-?\d+([.,]\d+)?$/.test(name)) {
      if (!def.default_unit) return null
      name = `${name.replace('.', ',')} ${def.default_unit}`
    }
  }
  return { name }
}

/**
 * Monta o corpo do POST /catalog/charts SÓ com o que a ficha da tabela
 * define (qualquer atributo fora dela o ML recusa) e valida localmente os
 * obrigatórios antes de chamar a API.
 */
export function buildSizeChartBody(template: ChartTemplate, input: NewSizeChartInput): Record<string, unknown> {
  const name = sanitizeChartName(input.name)
  if (!name) throw new SizeChartInputError('Informe o nome da tabela (letras, números e espaços).')

  const main = template.main_attribute_candidates.find((a) => a.id === input.mainAttributeId)
  if (!main) throw new SizeChartInputError(`Atributo principal ${input.mainAttributeId} não é candidato na ficha da tabela.`)
  if (template.measure_types.length > 0 && !template.measure_types.includes(input.measureType as 'BODY_MEASURE')) {
    throw new SizeChartInputError(`Escolha o tipo de medida: ${template.measure_types.join(' ou ')}.`)
  }

  const general: Array<{ id: string; values: Array<{ id?: string; name?: string }> }> = []
  const byId = new Map(input.attributes.map((a) => [a.id.toUpperCase(), a]))
  for (const def of template.chart_attributes) {
    const v = cellValue(def, byId.get(def.id))
    if (v) general.push({ id: def.id, values: [v] })
    else if (def.tags.includes('required') || def.tags.includes('grid_template_required')) {
      throw new SizeChartInputError(`Preencha ${def.name} (${def.id}) da tabela.`)
    }
  }

  const rowDefs = rowAttributesFor(template, input.measureType)
  if (input.rows.length === 0) throw new SizeChartInputError('Adicione ao menos uma linha (tamanho).')
  const seen = new Set<string>()
  const rows = input.rows.map((row, i) => {
    const mainValue = cellValue(main, row[main.id])
    if (!mainValue?.name) throw new SizeChartInputError(`Linha ${i + 1}: informe ${main.name}.`)
    const key = mainValue.name.toUpperCase()
    if (seen.has(key)) throw new SizeChartInputError(`Tamanho repetido: ${mainValue.name}.`)
    seen.add(key)
    const attributes: Array<{ id: string; values: Array<{ id?: string; name?: string }> }> = [{ id: main.id, values: [mainValue] }]
    for (const def of rowDefs) {
      const v = cellValue(def, row[def.id])
      if (!v) throw new SizeChartInputError(`Tamanho ${mainValue.name}: preencha ${def.name}${def.default_unit ? ` (${def.default_unit})` : ''}.`)
      attributes.push({ id: def.id, values: [v] })
    }
    return { attributes }
  })

  return {
    names: { [input.siteId]: name },
    domain_id: stripSitePrefix(input.domainId),
    site_id: input.siteId,
    ...(input.measureType && template.measure_types.length > 0 ? { measure_type: input.measureType } : {}),
    main_attribute: { attributes: [{ site_id: input.siteId, id: main.id }] },
    attributes: general,
    rows,
  }
}

export async function createSizeChart(ctx: Ctx, body: Record<string, unknown>, siteId?: string): Promise<SizeChart> {
  const res = await mercadoLivreRequest<Record<string, unknown>>({
    integrationId: ctx.integrationId, companyId: ctx.companyId, method: 'POST', path: '/catalog/charts', body, deps: ctx.deps,
  })
  return parseSizeChart(res.data, siteId)
}
