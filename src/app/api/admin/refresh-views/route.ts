import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'

// POST /api/admin/refresh-views
// Atualiza todas as materialized views analíticas.
// Requer role >= gerente.
export async function POST() {
  try {
    // Verificar autenticação
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
    }

    const profile = await getUserProfile(user.id, user.email)
    if (!hasMinRole(profile.role, 'gerente')) {
      return NextResponse.json({ error: 'Permissão insuficiente' }, { status: 403 })
    }

    // Chamar função de refresh via admin client (service_role)
    const admin = createAdminClient()
    const { data, error } = await admin.rpc('refresh_analytics_views')

    if (error) {
      console.error('[refresh-views] Erro:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    console.error('[refresh-views] Erro inesperado:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro desconhecido' },
      { status: 500 }
    )
  }
}
