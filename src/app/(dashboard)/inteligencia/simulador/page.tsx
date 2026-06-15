import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft, Calculator } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TaxSimulator } from './_components/tax-simulator'

export const dynamic = 'force-dynamic'

export default async function SimuladorPage() {
  await requirePageRole('gerente')
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-3">
          <Calculator className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Simulador Tributário</h2>
            <p className="text-sm text-text-muted">Compare Simples Nacional, Lucro Presumido e Lucro Real por produto</p>
          </div>
        </div>
      </div>

      <TaxSimulator />
    </div>
  )
}
