// ⚠️ DEV BYPASS — autenticação completamente desativada para testes.
// Para reativar: restaure o conteúdo original do middleware.ts
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Deixa todas as rotas passarem sem verificação de sessão
  return NextResponse.next({ request })
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
