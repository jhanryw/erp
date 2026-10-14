/**
 * Barra de anúncios do site de atacado — várias mensagens por empresa, ordenáveis e ativáveis.
 * `company_id` nunca vem do cliente. Tolerante à migration ausente: leitura pública devolve [] (a barra não renderiza).
 */

import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { cachedForCompany, invalidateWholesaleCompany } from '@/lib/wholesale/ttlCache'
import { HEX_COLOR, MIN_ANNOUNCEMENT_CONTRAST, cleanLine, contrastRatio, safeLinkUrl } from './siteChrome'

export interface Announcement {
  id: number
  message: string
  linkUrl: string | null
  backgroundColor: string
  textColor: string
  isActive: boolean
  sortOrder: number
}

const DEFAULT_BG = '#A71818'
const DEFAULT_FG = '#FFFFFF'
const COLUMNS = 'id, message, link_url, background_color, text_color, is_active, sort_order'

interface Row { id: number; message: string; link_url: string | null; background_color: string; text_color: string; is_active: boolean; sort_order: number }

function fromRow(r: Row): Announcement {
  // Defesa na leitura: link inseguro ou cores com contraste insuficiente nunca chegam à vitrine.
  const bg = HEX_COLOR.test(r.background_color) ? r.background_color : DEFAULT_BG
  const fg = HEX_COLOR.test(r.text_color) ? r.text_color : DEFAULT_FG
  const readable = contrastRatio(bg, fg) >= MIN_ANNOUNCEMENT_CONTRAST
  return {
    id: r.id, message: cleanLine(r.message), linkUrl: safeLinkUrl(r.link_url),
    backgroundColor: readable ? bg : DEFAULT_BG, textColor: readable ? fg : DEFAULT_FG,
    isActive: r.is_active, sortOrder: r.sort_order,
  }
}

// ─── Validação (única definição, usada pelas rotas) ──────────────────────────

const color = z.string().trim().regex(HEX_COLOR, 'Use uma cor no formato #RRGGBB.')

export const announcementInputSchema = z.object({
  message: z.string().transform(cleanLine).refine((v) => v.length >= 1 && v.length <= 160, 'A mensagem precisa ter de 1 a 160 caracteres.'),
  linkUrl: z.string().nullable().optional().transform((v) => (v == null || v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || safeLinkUrl(v) !== null, 'Use um link http(s):// ou um caminho iniciado por /.'),
  backgroundColor: color.default(DEFAULT_BG),
  textColor: color.default(DEFAULT_FG),
  isActive: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (contrastRatio(v.backgroundColor, v.textColor) < MIN_ANNOUNCEMENT_CONTRAST) {
    ctx.addIssue({ code: 'custom', path: ['textColor'], message: `Contraste insuficiente (mínimo ${MIN_ANNOUNCEMENT_CONTRAST}:1). Escolha cores mais distantes.` })
  }
})
export type AnnouncementInput = z.infer<typeof announcementInputSchema>

export const announcementPatchSchema = z.object({
  message: z.string().transform(cleanLine).refine((v) => v.length >= 1 && v.length <= 160, 'A mensagem precisa ter de 1 a 160 caracteres.').optional(),
  linkUrl: z.string().nullable().optional().transform((v) => (v === undefined ? undefined : v == null || v.trim() === '' ? null : v.trim()))
    .refine((v) => v === undefined || v === null || safeLinkUrl(v) !== null, 'Use um link http(s):// ou um caminho iniciado por /.'),
  backgroundColor: color.optional(),
  textColor: color.optional(),
  isActive: z.boolean().optional(),
}).strict()
export type AnnouncementPatch = z.infer<typeof announcementPatchSchema>

export type Mutation<T = undefined> = ({ ok: true } & (T extends undefined ? object : { data: T })) | { ok: false; error: string; status: number }

// ─── Leitura ─────────────────────────────────────────────────────────────────

/** Admin: todas (ativas e inativas), na ordem. Falha de schema → lista vazia + aviso. */
export async function listAnnouncements(companyId: number): Promise<{ announcements: Announcement[]; migrationPending: boolean }> {
  const admin = createAdminClient()
  const { data, error } = await (admin as any).from('wholesale_site_announcements').select(COLUMNS)
    .eq('company_id', companyId).order('sort_order', { ascending: true }).order('id', { ascending: true }) as
    { data: Row[] | null; error: { code?: string; message: string } | null }
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message)) return { announcements: [], migrationPending: true }
    throw new Error(`Falha ao listar anúncios: ${error.message}`)
  }
  return { announcements: (data ?? []).map(fromRow), migrationPending: false }
}

/** Público: só ativas, em cache curto por empresa; qualquer falha → [] (sem barra, sem erro na página). */
export function getActiveAnnouncements(companyId: number): Promise<Announcement[]> {
  return cachedForCompany(companyId, 'announcements', async () => {
    try {
      const { announcements } = await listAnnouncements(companyId)
      return announcements.filter((a) => a.isActive && a.message !== '')
    } catch { return [] }
  })
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

export async function createAnnouncement(companyId: number, input: AnnouncementInput): Promise<Mutation<Announcement>> {
  const admin = createAdminClient()
  const { data: last } = await (admin as any).from('wholesale_site_announcements').select('sort_order')
    .eq('company_id', companyId).order('sort_order', { ascending: false }).limit(1).maybeSingle() as { data: { sort_order: number } | null }
  const { data, error } = await (admin as any).from('wholesale_site_announcements').insert({
    company_id: companyId, message: input.message, link_url: input.linkUrl, background_color: input.backgroundColor,
    text_color: input.textColor, is_active: input.isActive, sort_order: (last?.sort_order ?? -1) + 1,
  }).select(COLUMNS).single() as { data: Row | null; error: { message: string } | null }
  if (error || !data) return { ok: false, error: error?.message ?? 'Falha ao criar o anúncio.', status: 500 }
  invalidateWholesaleCompany(companyId)
  return { ok: true, data: fromRow(data) }
}

export async function updateAnnouncement(companyId: number, id: number, patch: AnnouncementPatch): Promise<Mutation<Announcement>> {
  const admin = createAdminClient()
  const { data: current } = await (admin as any).from('wholesale_site_announcements').select(COLUMNS)
    .eq('company_id', companyId).eq('id', id).maybeSingle() as { data: Row | null }
  if (!current) return { ok: false, error: 'Anúncio não encontrado.', status: 404 }

  const bg = patch.backgroundColor ?? current.background_color
  const fg = patch.textColor ?? current.text_color
  if ((patch.backgroundColor || patch.textColor) && contrastRatio(bg, fg) < MIN_ANNOUNCEMENT_CONTRAST) {
    return { ok: false, error: `Contraste insuficiente (mínimo ${MIN_ANNOUNCEMENT_CONTRAST}:1). Escolha cores mais distantes.`, status: 422 }
  }

  const updates: Record<string, unknown> = {}
  if (patch.message !== undefined) updates.message = patch.message
  if (patch.linkUrl !== undefined) updates.link_url = patch.linkUrl
  if (patch.backgroundColor !== undefined) updates.background_color = patch.backgroundColor
  if (patch.textColor !== undefined) updates.text_color = patch.textColor
  if (patch.isActive !== undefined) updates.is_active = patch.isActive
  if (Object.keys(updates).length === 0) return { ok: true, data: fromRow(current) }

  const { data, error } = await (admin as any).from('wholesale_site_announcements').update(updates)
    .eq('company_id', companyId).eq('id', id).select(COLUMNS).single() as { data: Row | null; error: { message: string } | null }
  if (error || !data) return { ok: false, error: error?.message ?? 'Falha ao atualizar.', status: 500 }
  invalidateWholesaleCompany(companyId)
  return { ok: true, data: fromRow(data) }
}

export async function deleteAnnouncement(companyId: number, id: number): Promise<Mutation> {
  const admin = createAdminClient()
  const { error, count } = await (admin as any).from('wholesale_site_announcements').delete({ count: 'exact' })
    .eq('company_id', companyId).eq('id', id) as { error: { message: string } | null; count: number | null }
  if (error) return { ok: false, error: error.message, status: 500 }
  if (!count) return { ok: false, error: 'Anúncio não encontrado.', status: 404 }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}

/** Reordena: ids de OUTRA empresa são ignorados (nunca alteram sort_order alheio). */
export async function reorderAnnouncements(companyId: number, ids: number[]): Promise<Mutation> {
  const admin = createAdminClient()
  const { data: owned } = await (admin as any).from('wholesale_site_announcements').select('id')
    .eq('company_id', companyId).in('id', ids) as { data: { id: number }[] | null }
  const ownedIds = new Set((owned ?? []).map((r) => r.id))
  const results = await Promise.all(ids.filter((id) => ownedIds.has(id)).map((id, index) =>
    (admin as any).from('wholesale_site_announcements').update({ sort_order: index }).eq('company_id', companyId).eq('id', id)))
  const failed = results.find((r: any) => r.error)
  if (failed) return { ok: false, error: failed.error.message, status: 500 }
  invalidateWholesaleCompany(companyId)
  return { ok: true }
}
