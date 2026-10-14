/**
 * Configuração institucional do site de atacado (rodapé, loja, redes e botão flutuante) — módulo PURO (sem I/O).
 *
 * Persistida em `wholesale_site_settings.site_chrome` (JSONB). NÃO duplica o que o ERP já tem:
 *   - logo → Media Hub (role 'logo'); número de WhatsApp → `wholesale_site_settings.whatsapp_phone` (o MESMO da finalização);
 *   - texto institucional → `texts.footerText`; dados fiscais → `company_fiscal_settings` (opt-in `useFiscalData`).
 * Tudo é texto/URL validados: só http(s) ou caminho relativo do próprio site; nunca `javascript:`/`data:`.
 */

import { z } from 'zod'

// ─── Utilitários de validação ────────────────────────────────────────────────

const CONTROL = /[\u0000-\u001f\u007f]/g

export function cleanLine(value: string): string {
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

/** http(s) absoluta ou caminho relativo ("/x"), até 500 caracteres; `null` se inválida/insegura. */
export function safeLinkUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value || value.length > 500 || /[\s\u0000-\u001f\u007f]/.test(value)) return null
  if (value === '/' || (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'))) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname || url.username || url.password) return null
    return url.toString()
  } catch { return null }
}

export function isValidCnpj(raw: string): boolean {
  const d = raw.replace(/\D/g, '')
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false
  const calc = (len: number) => {
    let sum = 0, pos = len - 7
    for (let i = len; i >= 1; i--) { sum += Number(d[len - i]) * pos--; if (pos < 2) pos = 9 }
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13])
}

export function formatCnpj(raw: string): string {
  const d = raw.replace(/\D/g, '')
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : raw
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Razão de contraste WCAG entre duas cores `#RRGGBB`. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const MIN_ANNOUNCEMENT_CONTRAST = 4.5
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/

// ─── Esquema ─────────────────────────────────────────────────────────────────

const text = (max: number) => z.string().max(max * 2).transform(cleanLine).refine((v) => v.length <= max, `Máximo de ${max} caracteres.`)
const optionalText = (max: number) => text(max).transform((v) => (v === '' ? '' : v))
const url = z.string().max(600).transform((v) => v.trim()).refine((v) => v === '' || safeLinkUrl(v) !== null, 'Use um link http(s):// ou um caminho iniciado por /.')

export const linkItemSchema = z.object({ label: text(40).refine((v) => v.length >= 1, 'Informe o texto do link.'), url: url.refine((v) => v !== '', 'Informe o link.') }).strict()
export type LinkItem = z.infer<typeof linkItemSchema>

export const siteChromeSchema = z.object({
  footer: z.object({
    sections: z.object({ brand: z.boolean(), navigation: z.boolean(), support: z.boolean(), store: z.boolean(), legal: z.boolean() }).partial().strict(),
    navigationLinks: z.array(linkItemSchema).max(8),
    supportLinks: z.array(linkItemSchema).max(8),
    legalLinks: z.array(linkItemSchema).max(6),
    hours: optionalText(120),
  }).partial().strict(),
  store: z.object({
    useFiscalData: z.boolean(),
    legalName: optionalText(120),
    tradeName: optionalText(120),
    cnpj: z.string().max(30).transform((v) => v.trim()).refine((v) => v === '' || isValidCnpj(v), 'CNPJ inválido.'),
    addressLine: optionalText(160),
    city: optionalText(80),
    state: z.string().max(2).transform((v) => v.trim().toUpperCase()).refine((v) => v === '' || /^[A-Z]{2}$/.test(v), 'Use a sigla do estado (2 letras).'),
    mapsUrl: url,
  }).partial().strict(),
  social: z.object({ instagramUrl: url }).partial().strict(),
  whatsappFloat: z.object({ enabledDesktop: z.boolean(), enabledMobile: z.boolean(), message: optionalText(300) }).partial().strict(),
}).partial().strict()

export type SiteChromeInput = z.infer<typeof siteChromeSchema>

export interface ResolvedSiteChrome {
  footer: {
    sections: { brand: boolean; navigation: boolean; support: boolean; store: boolean; legal: boolean }
    navigationLinks: LinkItem[]; supportLinks: LinkItem[]; legalLinks: LinkItem[]; hours: string
  }
  store: { useFiscalData: boolean; legalName: string; tradeName: string; cnpj: string; addressLine: string; city: string; state: string; mapsUrl: string }
  social: { instagramUrl: string }
  whatsappFloat: { enabledDesktop: boolean; enabledMobile: boolean; message: string }
}

export const DEFAULT_WHATSAPP_FLOAT_MESSAGE = 'Olá! Vim pelo catálogo de atacado e gostaria de atendimento.'

export const DEFAULT_SITE_CHROME: ResolvedSiteChrome = {
  footer: {
    sections: { brand: true, navigation: true, support: true, store: true, legal: true },
    navigationLinks: [], supportLinks: [], legalLinks: [], hours: '',
  },
  store: { useFiscalData: false, legalName: '', tradeName: '', cnpj: '', addressLine: '', city: '', state: '', mapsUrl: '' },
  social: { instagramUrl: '' },
  whatsappFloat: { enabledDesktop: true, enabledMobile: true, message: DEFAULT_WHATSAPP_FLOAT_MESSAGE },
}

/**
 * Lê o JSONB do banco com tolerância total: valor ausente, de versão antiga ou corrompido NUNCA derruba o site —
 * cada campo inválido volta ao padrão (links com URL insegura são descartados na leitura, não só na gravação).
 */
export function resolveSiteChrome(raw: unknown): ResolvedSiteChrome {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, any>
  const d = DEFAULT_SITE_CHROME
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const str = (v: unknown, max: number) => (typeof v === 'string' ? cleanLine(v).slice(0, max) : '')
  const links = (v: unknown, max: number): LinkItem[] => (Array.isArray(v) ? v : []).slice(0, max).flatMap((item) => {
    const label = str(item?.label, 40)
    const href = safeLinkUrl(typeof item?.url === 'string' ? item.url : '')
    return label && href ? [{ label, url: href }] : []
  })
  const footer = src.footer ?? {}, store = src.store ?? {}, social = src.social ?? {}, wa = src.whatsappFloat ?? {}
  const section = (k: keyof ResolvedSiteChrome['footer']['sections']) => bool(footer.sections?.[k], d.footer.sections[k])
  const cnpj = typeof store.cnpj === 'string' && isValidCnpj(store.cnpj) ? store.cnpj.trim() : ''
  const state = typeof store.state === 'string' && /^[A-Za-z]{2}$/.test(store.state.trim()) ? store.state.trim().toUpperCase() : ''

  return {
    footer: {
      sections: { brand: section('brand'), navigation: section('navigation'), support: section('support'), store: section('store'), legal: section('legal') },
      navigationLinks: links(footer.navigationLinks, 8), supportLinks: links(footer.supportLinks, 8), legalLinks: links(footer.legalLinks, 6),
      hours: str(footer.hours, 120),
    },
    store: {
      useFiscalData: bool(store.useFiscalData, false), legalName: str(store.legalName, 120), tradeName: str(store.tradeName, 120),
      cnpj, addressLine: str(store.addressLine, 160), city: str(store.city, 80), state,
      mapsUrl: safeLinkUrl(typeof store.mapsUrl === 'string' ? store.mapsUrl : '') ?? '',
    },
    social: { instagramUrl: safeLinkUrl(typeof social.instagramUrl === 'string' ? social.instagramUrl : '') ?? '' },
    whatsappFloat: {
      enabledDesktop: bool(wa.enabledDesktop, d.whatsappFloat.enabledDesktop),
      enabledMobile: bool(wa.enabledMobile, d.whatsappFloat.enabledMobile),
      message: str(wa.message, 300) || d.whatsappFloat.message,
    },
  }
}

/** Mescla parcial por grupo (campo ausente = mantém; string vazia limpa). Arrays substituem por inteiro. */
export function mergeSiteChrome(current: ResolvedSiteChrome, patch: SiteChromeInput | undefined): ResolvedSiteChrome {
  if (!patch) return current
  return {
    footer: {
      ...current.footer, ...(patch.footer ?? {}),
      sections: { ...current.footer.sections, ...(patch.footer?.sections ?? {}) },
    } as ResolvedSiteChrome['footer'],
    store: { ...current.store, ...(patch.store ?? {}) } as ResolvedSiteChrome['store'],
    social: { ...current.social, ...(patch.social ?? {}) } as ResolvedSiteChrome['social'],
    whatsappFloat: { ...current.whatsappFloat, ...(patch.whatsappFloat ?? {}) } as ResolvedSiteChrome['whatsappFloat'],
  }
}
