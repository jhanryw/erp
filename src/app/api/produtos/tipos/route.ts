export const dynamic = 'force-dynamic'

import { requireRole } from '@/lib/supabase/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { ok, err, forbidden } from '@/lib/api/response'

// ─── GET /api/produtos/tipos ──────────────────────────────────────────────────
// Lista os Tipos de produto (product_types) da empresa atual, ativos. Fonte
// única do select "Tipo" em produtos/novo — substitui o antigo hardcode em
// SKU_TIPO, que nunca soube de Tipos criados só no banco (ex.: Sex Shop).

export async function GET() {
  const { user, response: unauth } = await requireRole('usuario')
  if (unauth) return unauth
  if (!user.company_id) return forbidden()

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('product_types')
    .select('id, name, slug, sku_code')
    .eq('company_id', user.company_id)
    .eq('active', true)
    .order('name')

  if (error) return err(error.message)
  return ok({ product_types: data ?? [] })
}
