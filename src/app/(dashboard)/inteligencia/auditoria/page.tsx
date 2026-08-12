import { createAdminClient } from '@/lib/supabase/admin'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuditTable, type AuditIssue } from './_components/audit-table'

export const dynamic = 'force-dynamic'

async function getAuditIssues(): Promise<AuditIssue[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('vw_data_quality_issues' as any)
    .select('issue_type, severity, entity_type, entity_id, entity_label, description, suggested_action, reference_date')
    .order('reference_date', { ascending: false }) as unknown as { data: AuditIssue[] | null; error: any }

  if (error) console.error('vw_data_quality_issues error:', error.message)
  return data ?? []
}

export default async function AuditoriaPage() {
  await requirePageRole('gerente')
  const issues = await getAuditIssues()

  const critical = issues.filter(i => i.severity === 'critical').length
  const high     = issues.filter(i => i.severity === 'high').length
  const medium   = issues.filter(i => i.severity === 'medium').length

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Auditoria de Dados</h2>
          <p className="text-sm text-text-muted">Inconsistências detectadas automaticamente no sistema</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={`card p-4 ${critical > 0 ? 'border-error/40' : ''}`}>
          <p className="text-xs text-text-muted mb-1">Crítico</p>
          <p className={`text-2xl font-bold ${critical > 0 ? 'text-error' : 'text-text-primary'}`}>
            {critical}
          </p>
          <p className="text-xs text-text-muted mt-0.5">ação imediata</p>
        </div>
        <div className={`card p-4 ${high > 0 ? 'border-warning/40' : ''}`}>
          <p className="text-xs text-text-muted mb-1">Alto</p>
          <p className={`text-2xl font-bold ${high > 0 ? 'text-warning' : 'text-text-primary'}`}>
            {high}
          </p>
          <p className="text-xs text-text-muted mt-0.5">relatórios incorretos</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Médio</p>
          <p className={`text-2xl font-bold ${medium > 0 ? 'text-info' : 'text-text-primary'}`}>
            {medium}
          </p>
          <p className="text-xs text-text-muted mt-0.5">dados incompletos</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-text-muted mb-1">Total</p>
          <p className="text-2xl font-bold text-text-primary">{issues.length}</p>
          <p className="text-xs text-text-muted mt-0.5">problemas ativos</p>
        </div>
      </div>

      <AuditTable issues={issues} />
    </div>
  )
}
