/**
 * Sistema de auditoria server-side — Santtorini ERP
 *
 * Persiste em `public.audit_logs` (via service_role) E no stdout (JSON).
 * Fire-and-forget: nunca bloqueia a requisição.
 *
 * Schema da tabela (ver 001_rls_and_audit.sql):
 *   id, ts, request_id, user_id, user_role, action, resource,
 *   resource_id, before_data, after_data, detail, ip_address, user_agent
 *
 * @example
 * const log = createAuditLogger({ userId: user.id, userRole: user.role, requestId })
 * await log({ action: 'delete', resource: 'product', resourceId: id, before: snapshot })
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type AuditAction =
  | 'create' | 'update' | 'delete'
  | 'cancel' | 'return' | 'adjust'

export type AuditResource =
  | 'product' | 'product_variation'
  | 'sale' | 'sale_item'
  | 'stock_entry' | 'stock_adjustment'
  | 'finance_entry'
  | 'supplier' | 'customer'
  | 'marketing_cost' | 'cashback_config'
  | 'shipping_config'

export interface AuditPayload {
  action:      AuditAction
  resource:    AuditResource
  resourceId?: string | number
  /** Estado do registro ANTES da mutação */
  before?:     Record<string, unknown> | null
  /** Estado do registro APÓS a mutação (ou campos alterados) */
  after?:      Record<string, unknown> | null
  detail?:     string
}

interface AuditContext {
  userId:    string
  userRole:  string
  requestId: string
  ipAddress?: string
  userAgent?: string
}

/**
 * Gera um request ID simples sem dependência de crypto.
 * Suficiente para correlacionar logs de uma mesma requisição.
 */
export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Cria um logger de auditoria vinculado ao contexto de uma requisição.
 * Use uma vez por request handler, reutilize o logger para múltiplas ações.
 *
 * @example
 * const log = createAuditLogger({ userId: user.id, userRole: user.role, requestId: generateRequestId() })
 * log({ action: 'create', resource: 'product', resourceId: newProduct.id })
 * log({ action: 'create', resource: 'product_variation', resourceId: variation.id })
 */
export function createAuditLogger(ctx: AuditContext) {
  return function log(payload: AuditPayload): void {
    const entry = {
      ts:          new Date().toISOString(),
      request_id:  ctx.requestId,
      user_id:     ctx.userId,
      user_role:   ctx.userRole,
      action:      payload.action,
      resource:    payload.resource,
      resource_id: payload.resourceId != null ? String(payload.resourceId) : undefined,
      before_data: payload.before ?? undefined,
      after_data:  payload.after ?? undefined,
      detail:      payload.detail,
      ip_address:  ctx.ipAddress,
      user_agent:  ctx.userAgent,
    }

    // 1. Stdout sempre (capturado pelo EasyPanel / log aggregator)
    try {
      console.log(JSON.stringify({ _type: 'audit', ...entry }))
    } catch { /* nunca bloquear */ }

    // 2. Persistir no banco — fire-and-forget via Promise não aguardada
    void (async () => {
      try {
        const admin = createAdminClient()
        await admin.from('audit_logs').insert(entry as any)
      } catch {
        // Falha silenciosa: logs de auditoria não devem derrubar a requisição
      }
    })()
  }
}

/**
 * Helper de uso único — conveniente quando não há múltiplas ações na mesma request.
 * Mantém retrocompatibilidade com código existente.
 */
export function auditLog(entry: {
  userId:     string
  userRole:   string
  action:     AuditAction
  resource:   AuditResource
  resourceId?: string | number
  before?:    Record<string, unknown> | null
  after?:     Record<string, unknown> | null
  detail?:    string
}): void {
  const log = createAuditLogger({
    userId:    entry.userId,
    userRole:  entry.userRole,
    requestId: generateRequestId(),
  })
  log({
    action:     entry.action,
    resource:   entry.resource,
    resourceId: entry.resourceId,
    before:     entry.before,
    after:      entry.after,
    detail:     entry.detail,
  })
}
