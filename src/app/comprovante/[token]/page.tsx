// Página pública de verificação de comprovante não fiscal.
//
// Rota pública (ver PUBLIC_PATHS em src/middleware.ts — protegida só pelo
// token aleatório/imutável na URL, nunca por sessão). Decisão definitiva:
// esta página é a página do CLIENTE, sempre read-only, nunca mostra
// nenhuma ação administrativa — mesmo quando o navegador tiver uma sessão
// ERP autenticada aberta. O que aparece aqui é deliberadamente mínimo:
// existência da venda, data, itens, quantidades, situação, quantidade já
// trocada/devolvida, quantidade ainda elegível (informativo, não uma
// ação). NUNCA nome/CPF de cliente, NUNCA custo/margem, NUNCA taxa de
// cartão/valor líquido de pagamento — getReceiptByToken já não retorna
// nada disso (includeCustomer=false). NUNCA o receipt_token completo.
//
// O fluxo administrativo de troca (registrar troca de verdade) existe
// SOMENTE dentro do ERP autenticado: /vendas/[id] → botão "Registrar
// Troca" → /vendas/[id]/troca. Esta página nunca linka pra lá, nunca checa
// sessão/role — não há nenhum ramo condicional de "administrador" aqui.

import { notFound } from 'next/navigation'
import { getReceiptByToken } from '@/lib/receipts/getReceiptData'
import { SaleStatusBadge } from '@/components/ui/badge'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import type { SaleStatus } from '@/types/database.types'

export const dynamic = 'force-dynamic'

export default async function ComprovanteVerificacaoPage({ params }: { params: { token: string } }) {
  const receipt = await getReceiptByToken(params.token)
  if (!receipt) notFound()

  const { sale, items, totals } = receipt

  const hasAvailable = items.some((i) => i.available_to_return > 0)
  const canExchangeStatus = ['paid', 'delivered'].includes(sale.status)

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

        {/*
          Só informativo — situação de elegibilidade pro cliente entender se
          a venda ainda pode ser trocada. Nenhuma ação/link aqui: registrar
          troca de verdade é sempre dentro do ERP autenticado
          (/vendas/[id]/troca), nunca a partir desta página pública.
        */}
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
