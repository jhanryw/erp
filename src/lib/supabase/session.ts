import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getUserRole } from '@/lib/auth/getProfile'
import type { AppRole } from '@/types/roles'
import { hasMinRole } from '@/types/roles'

export interface SessionUser {
  id: string
  email?: string
  role: AppRole
}

/**
 * Verifica se há uma sessão autenticada válida e retorna o usuário com seu role.
 * Consulta a tabela public.users para obter o role real (fonte autoritativa).
 * Retorna 401 se não houver sessão.
 *
 * @example
 * const { user, response } = await requireSession()
 * if (response) return response
 * // user.id, user.email, user.role disponíveis
 */
export async function requireSession(): Promise<
  | { user: SessionUser; response: null }
  | { user: null; response: NextResponse }
> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return {
      user: null,
      response: NextResponse.json({ error: 'Não autorizado.' }, { status: 401 }),
    }
  }

  const role = await getUserRole(user.id)

  return {
    user: { id: user.id, email: user.email, role },
    response: null,
  }
}

/**
 * Verifica autenticação E autorização por role hierárquico.
 * Retorna 401 sem sessão, 403 com sessão mas role insuficiente.
 *
 * Hierarquia: admin (3) ≥ gerente (2) ≥ usuario (1)
 * Um admin passa em qualquer rota; um gerente passa em rotas de gerente e usuario.
 *
 * @param minRole - Role mínimo exigido para acessar a rota.
 *
 * @example
 * // Rota para gerente e admin:
 * const { user, response } = await requireRole('gerente')
 * if (response) return response
 *
 * // Rota exclusiva para admin:
 * const { user, response } = await requireRole('admin')
 * if (response) return response
 */
export async function requireRole(minRole: AppRole): Promise<
  | { user: SessionUser; response: null }
  | { user: null; response: NextResponse }
> {
  const result = await requireSession()
  if (result.response) return result

  const { user } = result

  if (!hasMinRole(user.role, minRole)) {
    return {
      user: null,
      response: NextResponse.json(
        { error: 'Acesso negado. Permissão insuficiente.' },
        { status: 403 }
      ),
    }
  }

  return { user, response: null }
}
