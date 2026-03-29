import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Verifica se há uma sessão autenticada válida.
 * Use no início de API routes sensíveis.
 *
 * @example
 * const { user, response } = await requireSession()
 * if (response) return response
 */
export async function requireSession(): Promise<
  | { user: { id: string; email?: string }; response: null }
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

  return { user, response: null }
}
