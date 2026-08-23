// Página pública de verificação de comprovante não fiscal.
//
// Rota pública (ver PUBLIC_PATHS em src/middleware.ts — protegida só pelo
// token aleatório/imutável na URL, nunca por sessão). Por isso o que
// aparece aqui é deliberadamente mínimo: existência da venda, data, itens,
// quantidades, situação, quantidade já trocada/devolvida, quantidade ainda
// elegível. NUNCA nome/CPF de cliente, NUNCA custo/margem, NUNCA taxa de
// cartão/valor líquido de pagamento — getReceiptByToken já não retorna
// nada disso (includeCustomer=false).
//
// "Registrar troca" só aparece para quem tem sessão ERP autenticada E
// autorizada (mesmo mínimo de 'usuario' já exigido pela rota de troca) E
// pertence à MESMA empresa da venda — nunca para um visitante anônimo.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { hasMinRole } from '@/types/roles'
import { getReceiptByToken } from '@/lib/receipts/getReceiptData'
import { SaleStatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

async function canRegisterExchange(companyId: number): Promise<boolean> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const profile = await getUserProfile(user.id, user.email)
  if (!hasMinRole(profile.role, 'usuario')) return false
  if (profile.company_id !== companyId) return false

  return true
}

export default async function ComprovanteVerificacaoPage({ params }: { params: { token: string } }) {
  const receipt = await getReceiptByToken(params.token)
  if (!receipt) notFound()

  const { sale, items, totals } = receipt

  const hasAvailable = items.some((i) => i.available_to_return > 0)
  const canExchangeStatus = ['paid', 'delivered'].includes(sale.status)
  const showExchangeButton = canExchangeStatus && hasAvailable && (await canRegisterExchange(sale.company_id))

  return (
    <div className="min-h-screen bg-bg-root flex justify-center px-4 py-8">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center space-y-1">
          <div className="text-lg font-semibold">{receipt.store.name}</div>
          <div className="inline-block rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-warning">
            Comprovante não fiscal
          </div>
          <p className="text-xs text-text-muted">
            Este documento não substitui NF-e/NFC-e — não tem valor fiscal.
          </p>
        </div>

        <div className="rounded-lg border border-border-default bg-bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Venda</span>
            <span className="font-mono text-sm">{sale.sale_number}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Data</span>
            <span className="text-sm">{formatDateTime(sale.created_at)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">Situação</span>
            <SaleStatusBadge status={sale.status as SaleStatus} />
          </div>
        </div>

        <div className="rounded-lg border border-border-default bg-bg-surface p-4">
          <div className="text-sm font-medium mb-3">Itens</div>
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.sale_item_id} className="text-sm border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                <div className="flex justify-between">
                  <span className="font-medium">{item.product_name}</span>
                  <span>{formatCurrency(item.total_price)}</span>
                </div>
                {item.variation_label && (
                  <div className="text-xs text-text-muted">{item.variation_label}</div>
                )}
                <div className="text-xs text-text-muted">
                  {item.quantity}× {formatCurrency(item.unit_price)}
                </div>
                <div className="text-xs mt-1">
                  {item.already_returned > 0 ? (
                    <span className="text-warning">
                      {item.already_returned} já trocada(s) · {item.available_to_return} elegível(is)
                    </span>
                  ) : (
                    <span className="text-text-muted">{item.available_to_return} elegível(is) para troca</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border-default flex justify-between font-semibold text-sm">
            <span>Total</span>
            <span>{formatCurrency(totals.total)}</span>
          </div>
        </div>

        {showExchangeButton && (
          <Link href={`/vendas/${sale.id}/troca`}>
            <Button className="w-full">Registrar troca</Button>
          </Link>
        )}

        {!canExchangeStatus && (
          <p className="text-center text-xs text-text-muted">
            Esta venda está com status &quot;{sale.status}&quot; e não está elegível para troca.
          </p>
        )}
        {canExchangeStatus && !hasAvailable && (
          <p className="text-center text-xs text-text-muted">
            Todos os itens desta venda já foram trocados.
          </p>
        )}
      </div>
    </div>
  )
}
