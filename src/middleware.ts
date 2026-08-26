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
import { isWholesaleHost, shouldRewriteToWholesaleApp, toInternalWholesalePath } from '@/lib/wholesale/site-host'

// Rotas que não precisam de sessão
const PUBLIC_PATHS = [
  '/login',
  '/recuperar-acesso',
  '/api/auth',
  '/api/shipping/calculate', // cálculo público (checkout de clientes)
  '/api/shipping/cep',       // lookup de CEP (sem dados sensíveis)
  '/api/integrations/nuvemshop/callback',
  '/api/integrations/chatwoot/webhook', // webhook Chatwoot — path exato, autentica só por assinatura HMAC (ver route.ts); nunca liberar /api/integrations/ inteiro
  '/api/webhooks/',          // webhooks externos (Nuvemshop, etc.) — sem sessão
  '/api/automations/',       // automação N8N→ERP — protegida por secret próprio (Bearer), não sessão
  '/api/jobs/',              // cron jobs — protegidos por CRON_SECRET próprio, não sessão
  '/api/alerts/daily',       // cron de alerta diário — protegida por CRON_SECRET próprio, não sessão
                              // (path exato, não o prefixo /api/alerts/ inteiro — não liberar
                              // futuras rotas sob /api/alerts/ sem decisão própria)
  '/comprovante/',           // verificação pública de comprovante não fiscal — protegida só pelo
                              // token aleatório/imutável na URL (sales.receipt_token), nunca por
                              // sessão; a própria página não expõe dado sensível (sem custo/margem,
                              // sem CPF/nome de cliente) e ações de troca dentro dela exigem sessão
                              // própria (link só aparece para usuário autenticado/autorizado)
  '/atacado',                // Site de Atacado (Fase 8) — canal externo B2B, autenticação PRÓPRIA
                              // de cliente (public.customers.auth_user_id), NUNCA a mesma gate de
                              // staff deste middleware (que redirecionaria pra /login de staff).
                              // Páginas que exigem cliente logado (checkout/pedidos) checam a
                              // sessão sozinhas via getWholesaleCustomerSession() — nunca aqui.
                              // Continua valendo tanto para o path real (/atacado/**, acessado
                              // direto no host administrativo) quanto para o path JÁ REESCRITO
                              // pelo rewrite por host abaixo (a checagem usa o pathname pós-rewrite).
  '/api/wholesale/',         // APIs públicas do site de atacado — mesma razão acima. Cada rota
                              // decide sua própria exigência de sessão de cliente (nunca de staff).
]

export async function middleware(request: NextRequest) {
  const originalPathname = request.nextUrl.pathname
  const host = request.headers.get('host')

  // ─── Rewrite por host — domínio próprio do site de atacado ────────────────
  // atacado.santtorini.com/carrinho → internamente /atacado/carrinho, sem
  // NUNCA aparecer "/atacado" na URL do navegador (rewrite, não redirect).
  // Fora do host configurado (ERP administrativo, preview, dev sem
  // WHOLESALE_SITE_HOST) nada muda — comportamento atual preservado,
  // incluindo /atacado/** acessível diretamente por lá.
  // /api/**, /_next/** e paths já prefixados com /atacado nunca são
  // reescritos (ver shouldRewriteToWholesaleApp) — as APIs /api/wholesale/**
  // continuam respondendo no path real, sem prefixo nenhum.
  const rewriteUrl =
    isWholesaleHost(host) && shouldRewriteToWholesaleApp(originalPathname)
      ? (() => {
          const u = request.nextUrl.clone()
          u.pathname = toInternalWholesalePath(originalPathname)
          return u
        })()
      : null

  // Pathname "efetivo" usado pro resto deste middleware (checagem de rota
  // pública) — sempre o pós-rewrite quando houver um, senão o original.
  const effectivePathname = rewriteUrl ? rewriteUrl.pathname : originalPathname

  const buildBaseResponse = () =>
    rewriteUrl ? NextResponse.rewrite(rewriteUrl, { request }) : NextResponse.next({ request })

  let response = buildBaseResponse()

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
          response = buildBaseResponse()
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options as never)
          )
        },
      },
    }
  )

  // getUser() verifica o token JWT — não confia apenas no cookie local
  const { data: { user } } = await supabase.auth.getUser()

  const isPublic = PUBLIC_PATHS.some((p) => effectivePathname.startsWith(p))

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('redirect', originalPathname)
    return NextResponse.redirect(loginUrl)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
