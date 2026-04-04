import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function ConfigParametrosPage() {
  await requirePageRole('admin')

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/configuracoes"><Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button></Link>
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Parâmetros do Sistema</h2>
            <p className="text-sm text-text-muted">Configurações gerais de operação</p>
          </div>
        </div>
      </div>

      <div className="card p-8 text-center space-y-3">
        <Settings className="w-8 h-8 text-text-muted mx-auto" />
        <p className="text-sm font-medium text-text-primary">Em desenvolvimento</p>
        <p className="text-xs text-text-muted max-w-xs mx-auto">
          Parâmetros como estoque mínimo de alerta e período de análise RFM serão configuráveis aqui em breve.
        </p>
      </div>
    </div>
  )
}
