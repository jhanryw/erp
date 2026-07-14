/**
 * Distingue "não encontrado" de erro real de consulta em queries Supabase/PostgREST
 * usadas por Server Components (onde não há um `NextResponse` para devolver 500).
 *
 * Motivação: várias páginas de vendas faziam `const { data } = await ...single()`
 * e chamavam `notFound()` sempre que `data` era falsy — isso torna "venda não existe"
 * e "a query falhou" (coluna renomeada, join quebrado, etc.) indistinguíveis: ambas
 * viram um 404 genérico, sem log, sem forma de diagnosticar o que realmente houve.
 *
 * Regra:
 *  - PGRST116 (0 linhas em `.single()`) ou ausência de erro com data nula → não encontrado
 *    real. Retorna `null` — o chamador decide chamar `notFound()`.
 *  - Qualquer outro erro → registrado via `logError` (mensagem completa, código,
 *    details, hint) e relançado como exceção genérica, que o Next.js renderiza no
 *    `error.tsx` mais próximo (não no `not-found.tsx`). A mensagem lançada nunca
 *    inclui `error.message`/`details`/`hint` originais — isso fica só no log — para
 *    não vazar detalhes internos de schema/query para o navegador.
 */

import { logError } from '@/lib/errors/log'

export interface PgErrorLike {
  code?: string
  message: string
  details?: string | null
  hint?: string | null
}

export function resolveOrThrow<T>(
  data: T | null,
  error: PgErrorLike | null,
  route: string,
  context?: Record<string, unknown>
): T | null {
  if (error) {
    if (error.code === 'PGRST116') return null

    logError({
      route,
      err: new Error(error.message),
      context: {
        ...context,
        pg_code:    error.code ?? null,
        pg_details: error.details ?? null,
        pg_hint:    error.hint ?? null,
      },
    })
    throw new Error(`Erro ao consultar dados (${route}).`)
  }

  return data
}

/** Loga um erro de query secundária (não-crítica) sem interromper o render da página. */
export function logQueryError(
  error: PgErrorLike | null,
  route: string,
  context?: Record<string, unknown>
): void {
  if (!error) return
  logError({
    route,
    err: new Error(error.message),
    context: {
      ...context,
      pg_code:    error.code ?? null,
      pg_details: error.details ?? null,
      pg_hint:    error.hint ?? null,
    },
  })
}
