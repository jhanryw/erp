export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { auditLog } from '@/lib/audit/log'
import { createBrand } from '@/services/marcas.service'
import { ok, err, forbidden, validationError } from '@/lib/api/response'
import { z } from 'zod'

const postSchema = z.object({
  name:   z.string().min(2).max(100),
  slug:   z.string().min(1).max(100).optional(),
  active: z.boolean().default(true),
})

// ─── GET /api/marcas ──────────────────────────────────────────────────────────
// Lista marcas da empresa. Filtro opcional ?active=true|false — sem o
// parâmetro, retorna todas (ativas e inativas).

export async function GET(request: Request) {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const { searchParams } = new URL(request.url)
  const activeParam = searchParams.get('active')

  const admin = createAdminClient()
  let query = admin
    .from('brands')
    .select('id, name, slug, active')
    .eq('company_id', user.company_id)
    .order('name')

  if (activeParam === 'true') query = query.eq('active', true) as typeof query
  if (activeParam === 'false') query = query.eq('active', false) as typeof query

  const { data, error } = await query
  if (error) return err(error.message)
  return ok({ brands: data ?? [] })
}

// ─── POST /api/marcas ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const { user, response: unauth } = await requireRole('gerente')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  let body: unknown
  try { body = await request.json() } catch { return err('JSON inválido.', 400) }

  const parsed = postSchema.safeParse(body)
  if (!parsed.success) return validationError(parsed.error.flatten())

  const result = await createBrand(parsed.data, user.company_id)
  if (!result.ok) return err(result.error, result.status)

  auditLog({
    userId: user.id, userRole: user.role,
    action: 'create', resource: 'brand',
    resourceId: result.data.id, detail: result.data.name,
  })

  return ok({ brand: result.data }, 201)
}
