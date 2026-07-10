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
  | 'cancel' | 'return' | 'exchange' | 'adjust' | 'transfer'
  | 'sku_manual_override'
  | 'inventory_count'
  | 'open_cash' | 'close_cash' | 'reopen_cash'
  | 'add_movement' | 'cancel_movement'

export type AuditResource =
  | 'product' | 'product_variation' | 'brand' | 'category_attribute'
  | 'sale' | 'sale_item'
  | 'stock' | 'stock_entry' | 'stock_adjustment' | 'stock_transfer'
  | 'finance_entry'
  | 'supplier' | 'customer'
  | 'marketing_cost' | 'cashback_config'
  | 'shipping_config'
  | 'monthly_sales_goals'
  | 'cash_session' | 'cash_movement'
  | 'media' | 'media_usage'
  | 'crm_person' | 'crm_organization' | 'crm_company_contact'
  | 'crm_channel' | 'crm_channel_identity'
  | 'crm_person_customer_link' | 'crm_consent_event'
  | 'crm_conversation' | 'crm_message' | 'crm_conversation_note'

export interface AuditPayload {
  action:         AuditAction
  resource:       AuditResource
  resourceId?:    string | number
  /** Estado do registro ANTES da mutação */
  before?:        Record<string, unknown> | null
  /** Estado do registro APÓS a mutação (ou campos alterados) */
  after?:         Record<string, unknown> | null
  detail?:        string
  /** UUID de quem autorizou a ação (para ações que requerem delegação) */
  authorized_by?:          string
  reason?:                 string
  authorization_token_id?: string
  authorization_action?:   string
  discount_percent?:       number
  discount_amount_audit?:  number
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
      ts:            new Date().toISOString(),
      request_id:    ctx.requestId,
      user_id:       ctx.userId,
      user_role:     ctx.userRole,
      action:        payload.action,
      resource:      payload.resource,
      resource_id:   payload.resourceId != null ? String(payload.resourceId) : undefined,
      before_data:   payload.before ?? undefined,
      after_data:    payload.after ?? undefined,
      detail:        payload.detail,
      ip_address:    ctx.ipAddress,
      user_agent:    ctx.userAgent,
      authorized_by:          payload.authorized_by ?? undefined,
      reason:                 payload.reason ?? undefined,
      authorization_token_id: payload.authorization_token_id ?? undefined,
      authorization_action:   payload.authorization_action ?? undefined,
      discount_percent:       payload.discount_percent ?? undefined,
      discount_amount_audit:  payload.discount_amount_audit ?? undefined,
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
  userId:                  string
  userRole:                string
  action:                  AuditAction
  resource:                AuditResource
  resourceId?:             string | number
  before?:                 Record<string, unknown> | null
  after?:                  Record<string, unknown> | null
  detail?:                 string
  authorized_by?:          string
  reason?:                 string
  authorization_token_id?: string
  authorization_action?:   string
  discount_percent?:       number
  discount_amount_audit?:  number
}): void {
  const log = createAuditLogger({
    userId:    entry.userId,
    userRole:  entry.userRole,
    requestId: generateRequestId(),
  })
  log({
    action:                  entry.action,
    resource:                entry.resource,
    resourceId:              entry.resourceId,
    before:                  entry.before,
    after:                   entry.after,
    detail:                  entry.detail,
    authorized_by:           entry.authorized_by,
    reason:                  entry.reason,
    authorization_token_id:  entry.authorization_token_id,
    authorization_action:    entry.authorization_action,
    discount_percent:        entry.discount_percent,
    discount_amount_audit:   entry.discount_amount_audit,
  })
}
