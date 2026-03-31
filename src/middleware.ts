/**
 * Middleware de autenticação — verifica apenas se há sessão válida.
 *
 * Decisão de design: o middleware é responsável APENAS por autenticação.
 * A autorização por role fica nas API routes (requireRole) e nos layouts
 * server-side. Isso mantém public.users.role como fonte única de verdade,
 * evita queries extras no edge e elimina risco de dessincronização com
 * user_metadata.
 *
 * Fluxo:
 *   Middleware → verifica JWT via supabase.auth.getUser()
 *   Layout → getUserProfile() → verifica role para acesso à seção
 *   API Route → requireRole(minRole) → verifica role para mutações
 */

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Rotas que não precisam de sessão
const PUBLIC_PATHS = [
  '/login',
  '/recuperar-acesso',
  '/api/auth',
  '/api/shipping/calculate', // cálculo público (checkout de clientes)
  '/api/shipping/cep',       // lookup de CEP (sem dados sensíveis)
  '/api/integrations/nuvemshop/callback',
]

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as never)
          )
        },
      },
    }
  )

  // getUser() verifica o token JWT — não confia apenas no cookie local
  const { data: { user } } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
