/**
 * Textos personalizáveis do site de atacado — módulo PURO (sem I/O, seguro para client e server).
 *
 * `null` em qualquer campo = "sem personalização": vale o texto padrão abaixo (os textos que o site já
 * exibia antes). Nenhum texto é HTML: tudo é renderizado como TEXTO pelo React (escapado), e a validação
 * ainda remove caracteres de controle e limita o tamanho. O valor do pedido mínimo NÃO é um texto —
 * continua em `minimumOrderAmount`.
 */

import { z } from 'zod'

export interface WholesaleSiteTexts {
  heroTitle: string | null
  heroSubtitle: string | null
  categoriesTitle: string | null
  productsTitle: string | null
  addAlsoTitle: string | null
  minimumOrderNote: string | null
  emptyMessage: string | null
  footerText: string | null
}

export type SiteTextKey = keyof WholesaleSiteTexts

/** Limites (espelhados no CHECK da migration 202610091200). */
export const SITE_TEXT_LIMITS: Record<SiteTextKey, number> = {
  heroTitle: 80,
  heroSubtitle: 200,
  categoriesTitle: 60,
  productsTitle: 60,
  addAlsoTitle: 60,
  minimumOrderNote: 240,
  emptyMessage: 200,
  footerText: 500,
}

/** Campos que aceitam quebra de linha. */
const MULTILINE: SiteTextKey[] = ['minimumOrderNote', 'footerText']

export const EMPTY_SITE_TEXTS: WholesaleSiteTexts = {
  heroTitle: null, heroSubtitle: null, categoriesTitle: null, productsTitle: null,
  addAlsoTitle: null, minimumOrderNote: null, emptyMessage: null, footerText: null,
}

/** Textos exibidos hoje quando não há personalização. */
export const DEFAULT_CATEGORIES_TITLE = 'Nossas categorias'
export const DEFAULT_ADD_ALSO_TITLE = 'Adicione também'

/**
 * Normaliza um texto: remove caracteres de controle (mantém \n nos campos multilinha), aplica trim,
 * limita linhas em branco seguidas e converte vazio em `null`.
 */
export function cleanSiteText(value: string, multiline: boolean): string | null {
  // eslint-disable-next-line no-control-regex
  let v = value.replace(/\r\n?/g, '\n').replace(multiline ? /[\x00-\x09\x0b-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, multiline ? '' : ' ')
  v = multiline ? v.replace(/\n{3,}/g, '\n\n') : v.replace(/\s+/g, ' ')
  v = v.trim()
  return v === '' ? null : v
}

/**
 * Campo opcional: chave AUSENTE continua `undefined` (num PUT parcial significa "não mexer");
 * string vazia/branca vira `null` (limpa e volta ao padrão).
 */
function textField(key: SiteTextKey) {
  const multiline = MULTILINE.includes(key)
  return z.string().max(SITE_TEXT_LIMITS[key] * 2).nullable().optional()
    .transform((v) => (v === undefined ? undefined : v === null ? null : cleanSiteText(v, multiline)))
    .refine((v) => v == null || v.length <= SITE_TEXT_LIMITS[key], `Máximo de ${SITE_TEXT_LIMITS[key]} caracteres.`)
}

export const wholesaleSiteTextsSchema = z.object({
  heroTitle: textField('heroTitle'),
  heroSubtitle: textField('heroSubtitle'),
  categoriesTitle: textField('categoriesTitle'),
  productsTitle: textField('productsTitle'),
  addAlsoTitle: textField('addAlsoTitle'),
  minimumOrderNote: textField('minimumOrderNote'),
  emptyMessage: textField('emptyMessage'),
  footerText: textField('footerText'),
})

export interface ResolvedSiteTexts {
  heroTitle: string | null
  heroSubtitle: string | null
  categoriesTitle: string
  /** `null` → sem título de seção (como era). */
  productsTitle: string | null
  addAlsoTitle: string
  minimumOrderNote: string | null
  /** Mensagem da lista vazia; recebe a busca para manter o texto padrão ("… para \"x\""). */
  emptyMessage: (search?: string) => string
  /** Linhas do rodapé (texto personalizado) ou o texto padrão com o nome da empresa. */
  footerLines: string[]
}

export function resolveSiteTexts(texts: WholesaleSiteTexts | undefined, displayName: string | null): ResolvedSiteTexts {
  const t = texts ?? EMPTY_SITE_TEXTS
  return {
    heroTitle: t.heroTitle,
    heroSubtitle: t.heroSubtitle,
    categoriesTitle: t.categoriesTitle ?? DEFAULT_CATEGORIES_TITLE,
    productsTitle: t.productsTitle,
    addAlsoTitle: t.addAlsoTitle ?? DEFAULT_ADD_ALSO_TITLE,
    minimumOrderNote: t.minimumOrderNote,
    emptyMessage: (search) => t.emptyMessage ?? `Nenhum produto encontrado${search ? ` para "${search}"` : ''}.`,
    footerLines: t.footerText ? t.footerText.split('\n') : [`${displayName ?? 'Atacado'} — vendas por atacado`],
  }
}
