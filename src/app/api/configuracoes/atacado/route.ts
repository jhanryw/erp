export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/supabase/session'
import { getWholesaleSiteSettings, updateWholesaleSiteSettings } from '@/services/wholesale/settings'
import { normalizePhoneBR } from '@/lib/utils/phone'

// ─── GET /api/configuracoes/atacado — configuração do catálogo público ────────

export async function GET() {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  const settings = await getWholesaleSiteSettings(user.company_id)
  return NextResponse.json({ settings })
}

// ─── PUT /api/configuracoes/atacado — atualiza configuração (parcial) ─────────

const putSchema = z.object({
  catalogActive: z.boolean().optional(),
  displayName: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(120).nullable().optional()),
  whatsappPhone: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(30).nullable().optional()),
  minimumOrderAmount: z.coerce.number().min(0).optional(),
  showOutOfStock: z.boolean().optional(),
  showStockQuantity: z.boolean().optional(),
  showSearch: z.boolean().optional(),
  showCategories: z.boolean().optional(),
  pixelEnabled: z.boolean().optional(),
  pixelId: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().max(60).nullable().optional()),
}).partial()

export async function PUT(request: Request) {
  const { user, response: unauth } = await requireRole('admin')
  if (unauth) return unauth
  if (!user.company_id) return NextResponse.json({ error: 'Usuário sem empresa vinculada.' }, { status: 403 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 }) }

  const parsed = putSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  // WhatsApp — validado com a MESMA normalização usada pelo CRM (nunca uma
  // segunda lógica de telefone). Só valida quando um valor foi realmente
  // enviado (não quando o campo foi omitido do payload).
  if (parsed.data.whatsappPhone !== undefined && parsed.data.whatsappPhone !== null) {
    const normalized = normalizePhoneBR(parsed.data.whatsappPhone)
    if (!normalized.ok) {
      return NextResponse.json({ error: 'Número de WhatsApp inválido — informe com DDD (ex.: 84 99999-9999).' }, { status: 422 })
    }
  }

  if (parsed.data.pixelEnabled === true) {
    const current = await getWholesaleSiteSettings(user.company_id)
    const pixelId = parsed.data.pixelId !== undefined ? parsed.data.pixelId : current.pixelId
    if (!pixelId) {
      return NextResponse.json({ error: 'Informe o Pixel ID antes de ativar o Meta Pixel.' }, { status: 422 })
    }
  }

  const result = await updateWholesaleSiteSettings(user.company_id, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ settings: result.data })
}
