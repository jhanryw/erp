/**
 * Utilitário de auditoria server-side.
 *
 * Registra ações críticas no console do servidor como JSON estruturado.
 * Em produção, o EasyPanel captura estes logs via stdout.
 *
 * Evolução recomendada: persistir em tabela `audit_logs` no Supabase.
 *
 * @example
 * import { auditLog } from '@/lib/audit/log'
 *
 * await auditLog({
 *   userId: user.id,
 *   userRole: user.role,
 *   action: 'delete',
 *   resource: 'product',
 *   resourceId: productId,
 * })
 */

export type AuditAction = 'create' | 'update' | 'delete' | 'cancel' | 'return' | 'adjust'
export type AuditResource =
  | 'product'
  | 'product_variation'
  | 'sale'
  | 'stock_entry'
  | 'stock_adjustment'
  | 'finance_entry'
  | 'supplier'
  | 'customer'
  | 'marketing_cost'
  | 'cashback_config'
  | 'shipping_config'

interface AuditEntry {
  /** ID do usuário que realizou a ação (do requireSession/requireRole) */
  userId: string
  /** Role do usuário no momento da ação */
  userRole: string
  /** Tipo de ação realizada */
  action: AuditAction
  /** Recurso afetado */
  resource: AuditResource
  /** ID do registro afetado (opcional) */
  resourceId?: string | number
  /** Informação adicional (motivo, descrição da mudança, etc.) */
  detail?: string
}

/**
 * Registra um evento de auditoria.
 * Fire-and-forget — não lança exceções para não bloquear a resposta.
 */
export function auditLog(entry: AuditEntry): void {
  try {
    console.log(
      JSON.stringify({
        _type: 'audit',
        ts: new Date().toISOString(),
        ...entry,
      })
    )
  } catch {
    // Nunca bloquear a requisição por falha no log
  }
}
