/**
 * Log de erros técnicos — Santtorini ERP
 *
 * Persiste em `public.error_logs` (via service_role) E no stderr (JSON).
 * Fire-and-forget para a persistência no banco: nunca bloqueia a requisição.
 *
 * Princípios:
 *  - Erros técnicos NÃO são expostos ao usuário final (a rota retorna mensagem genérica).
 *  - O stack trace é preservado para diagnóstico interno.
 *  - O contexto inclui apenas dados não-sensíveis: route, user_id, company_id e
 *    campos de identificação do payload (nunca preços, CPF, senhas, etc.).
 *
 * @example
 * try {
 *   const result = await createSale(...)
 * } catch (err) {
 *   logError({ route: 'POST /api/vendas', err, context: { user_id: user.id, items_count: 3 } })
 *   return NextResponse.json({ error: 'Erro interno do servidor.' }, { status: 500 })
 * }
 */

import { createAdminClient } from '@/lib/supabase/admin'

export interface ErrorLogEntry {
  route: string
  err: unknown
  context?: Record<string, unknown>
}

/**
 * Registra um erro técnico no stderr e na tabela error_logs.
 * Deve ser chamado nos blocos catch das rotas críticas, ANTES de retornar 500.
 */
export function logError({ route, err, context }: ErrorLogEntry): void {
  const message = err instanceof Error ? err.message : String(err)
  const stack   = err instanceof Error ? err.stack   : undefined

  const entry = {
    _type:   'error',
    ts:      new Date().toISOString(),
    route,
    message,
    stack,
    context: context ?? {},
  }

  // 1. stderr sempre — capturado pelo EasyPanel / log aggregator
  try {
    console.error(JSON.stringify(entry))
  } catch { /* nunca bloquear */ }

  // 2. Persistir no banco — fire-and-forget
  void (async () => {
    try {
      const admin = createAdminClient()
      await (admin as any).from('error_logs').insert({
        route,
        message,
        stack:   stack ?? null,
        context: context ?? {},
      })
    } catch {
      // Falha silenciosa: o log de erros não deve derrubar a requisição
    }
  })()
}
