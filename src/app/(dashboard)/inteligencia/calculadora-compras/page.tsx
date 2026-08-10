import { requirePageRole } from '@/lib/auth/requirePageRole'
import Link from 'next/link'
import { ArrowLeft, Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PurchaseCalculator } from './_components/purchase-calculator'

export const dynamic = 'force-dynamic'

export default async function CalculadoraComprasPage() {
  await requirePageRole('gerente')
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/inteligencia">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-3">
          <Scale className="w-5 h-5 text-brand" />
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Calculadora de Compra e Alavancagem</h2>
            <p className="text-sm text-text-muted">
              Compare à vista, a prazo e misto considerando caixa, obrigações e giro esperado — tudo manual, sem integração automática
            </p>
          </div>
        </div>
      </div>

      <PurchaseCalculator />
    </div>
  )
}
