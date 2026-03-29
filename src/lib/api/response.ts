/**
 * Helpers padronizados de resposta para API Routes.
 *
 * Uso:
 *   import { unauthorized, forbidden, ok, err, notFound } from '@/lib/api/response'
 *
 *   const { response: unauth } = await requireRole('gerente')
 *   if (unauth) return unauth
 *
 *   return ok({ product })
 *   return err('SKU já cadastrado.', 409)
 *   return notFound('Produto')
 */

import { NextResponse } from 'next/server'

/** 401 — Sem sessão */
export const unauthorized = () =>
  NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })

/** 403 — Sessão válida mas role insuficiente */
export const forbidden = () =>
  NextResponse.json({ error: 'Acesso negado. Permissão insuficiente.' }, { status: 403 })

/** 404 — Recurso não encontrado */
export const notFound = (resource = 'Recurso') =>
  NextResponse.json({ error: `${resource} não encontrado.` }, { status: 404 })

/** 409 — Conflito (FK, unique constraint, regra de negócio) */
export const conflict = (message: string) =>
  NextResponse.json({ error: message }, { status: 409 })

/** 422 — Erro de validação Zod */
export const validationError = (errors: unknown) =>
  NextResponse.json({ error: errors }, { status: 422 })

/** 200/201 — Sucesso com payload */
export const ok = (data: Record<string, unknown>, status = 200) =>
  NextResponse.json(data, { status })

/** 4xx/5xx — Erro genérico com mensagem */
export const err = (message: string, status = 500) =>
  NextResponse.json({ error: message }, { status })
