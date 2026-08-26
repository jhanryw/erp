import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { getUserProfile } from '@/lib/auth/getProfile'
import { logQueryError } from '@/lib/errors/pgResult'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Package, Truck, Printer, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent } from '@/components/ui/card'
import { SaleStatusBadge } from '@/components/ui/badge'
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDate } from '@/lib/utils/date'
import { cn } from '@/lib/utils/cn'
import { ReturnButton } from './_components/return-button'
import { CancelSaleButton } from './_components/cancel-sale-button'
import { DocumentoFiscalCard, type InitialFiscalDocument } from './_components/documento-fiscal-card'
import { resolveFiscalDocumentType, describeFiscalDocumentTypeBlockReason } from '@/lib/fiscal/resolveFiscalDocumentType'
import { validateCPF, maskCPF } from '@/lib/utils/cpf'
import type { SaleStatus } from '@/types/database.types'
import { ArrowRightLeft } from 'lucide-react'

export const dynamic = 'force-dynamic'

const STATUS_STEPS: SaleStatus[] = ['pending', 'paid', 'shipped', 'delivered']

// Labels para pedidos de ENVIO (padrão)
const STATUS_LABELS_DELIVERY: Record<string, string> = {
  pending:  'Pedido Realizado',
  paid:     'Pago',
  shipped:  'Enviado',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
  returned:  'Devolvido',
}

// Labels para pedidos de RETIRADA
const STATUS_LABELS_PICKUP: Record<string, string> = {
  pending:  'Pedido Realizado',
  paid:     'Pago',
  shipped:  'Pronto p/ Retirada',
  delivered: 'Retirado',
  cancelled: 'Cancelado',
  returned:  'Devolvido',
}

const PAYMENT_LABELS: Record<string, string> = {
  pix:         'PIX',
  card:        'Cartão',
  cash:        'Dinheiro',
  credit_card: 'Crédito',
  debit_card:  'Débito',
  cashback:    'Crédito de Troca',
}

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  aguardando_confirmacao: 'Aguardando confirmação de endereço',
  aguardando_retirada:    'Aguardando retirada',
  em_transito:            'Em trânsito',
  entregue:               'Entregue',
  nao_entregue:           'Não entregue',
  cancelado:              'Cancelado',
}

const ROUTE = 'GET /vendas/[id] getSale'

/**
 * Vendas tem 3 FKs para `users` (seller_id, cancelled_by, returned_by — os dois
 * últimos desde 20260721_sales_reversal_audit_columns.sql). Um embed
 * `users(...)` sem qualificar a FK é ambíguo para o PostgREST (erro PGRST201)
 * e derruba a query inteira — inclusive o `sale_items`/`customers` que vêm
 * junto na mesma `.select()`. Por isso a venda é buscada sozinha, sem nenhum
 * relacionamento embutido, e cada relação é resolvida em queries separadas
 * que não podem derrubar as outras.
 */
async function getSale(id: string) {
  const admin = createAdminClient()
  const saleId = Number(id)

  // ── Etapa 1: venda base — sem embeds, é a única que decide notFound() ──────
  const { data: saleData, error: saleError } = await admin
    .from('sales')
    .select('*')
    .eq('id', saleId)
    .maybeSingle() as unknown as { data: any; error: import('@/lib/errors/pgResult').PgErrorLike | null }

  if (saleError) {
    logQueryError(saleError, `${ROUTE} (sale_base)`, { sale_id: id, stage: 'sale_base' })
    throw new Error(`Erro ao consultar dados (${ROUTE} (sale_base)).`)
  }
  if (!saleData) return null
  const sale = saleData

  // ── Etapa 2: relações de 1º nível, em paralelo — nenhuma pode gerar 404 ────
  // `shipments.order_id = sale.id` (linha abaixo) — CONTRA `sales.id`,
  // nunca `pedidos.id` (tabela não relacionada, PK UUID). Mesmo join já
  // usado por `vw_sale_shipping_summary`
  // (`20260613_shipping_fiscal_ready.sql:169`) — não inventado aqui. Sem
  // FK enforced entre as duas tabelas (auditado na Fase Fiscal 4G): uma
  // venda de balcão pode legitimamente não ter nenhuma linha `shipments`
  // (ex.: venda 636) — tratado como ausência de dado, nunca inferido de
  // `shipping_charged` (usado só na resolução fiscal, ver comentário mais
  // abaixo onde `fiscalResolverInput` é montado).
  const stage2 = await Promise.all([
    admin.from('customers').select('id, name, cpf, phone').eq('id', sale.customer_id).maybeSingle(),
    admin.from('users').select('name').eq('id', sale.seller_id).maybeSingle(),
    sale.responsible_seller_id
      ? (admin as any).from('sellers').select('id, name').eq('id', sale.responsible_seller_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    admin.from('sale_items').select('id, quantity, unit_price, total_price, unit_cost, product_variation_id').eq('sale_id', sale.id),
    (admin as any).from('shipments').select('id, delivery_mode, status, notes').eq('order_id', sale.id).maybeSingle(),
    (admin as any).from('sale_payments')
      .select('id, method, amount_tendered, change_amount, change_method, net_amount, installments, card_brand, acquirer, fee_amount')
      .eq('sale_id', sale.id)
      .order('net_amount', { ascending: false }),
    (admin as any).from('exchanges')
      .select('id, status, returned_amount, credit_issued, created_at')
      .eq('original_sale_id', sale.id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false }),
    // Fase Fiscal 6, seção 18 do pedido — status real já carregado no
    // load da página (nunca exige um clique em "verificar status" só pra
    // ver o que já existe). Leitura pura de `fiscal_documents`, NUNCA
    // dispara uma consulta à Focus aqui (isso continua sendo uma ação
    // explícita do operador, "Verificar status" no card) — pega as linhas
    // mais recentes por tipo, sem filtro de status (rascunho/pendente/
    // autorizada/rejeitada, tudo relevante pra UI decidir o que mostrar).
    (admin as any).from('fiscal_documents')
      .select('id, document_type, status, number, series, access_key, authorization_protocol, status_sefaz, status_message, submission_error_code, submission_error_message, xml_path, danfe_path, created_at')
      .eq('sale_id', sale.id)
      .order('created_at', { ascending: false }),
  ]) as any[]

  const [
    { data: customer, error: customerError },
    { data: seller, error: sellerError },
    { data: responsibleSeller, error: responsibleSellerError },
    { data: saleItems, error: saleItemsError },
    { data: shipment, error: shipmentError },
    { data: salePayments, error: salePaymentsError },
    { data: exchanges, error: exchangesError },
    { data: fiscalDocumentRows, error: fiscalDocumentsError },
  ] = stage2

  logQueryError(customerError,          `${ROUTE} (customer)`,           { sale_id: id, stage: 'customer' })
  logQueryError(sellerError,            `${ROUTE} (seller)`,             { sale_id: id, stage: 'seller' })
  logQueryError(responsibleSellerError, `${ROUTE} (responsible_seller)`, { sale_id: id, stage: 'responsible_seller' })
  logQueryError(saleItemsError,         `${ROUTE} (sale_items)`,         { sale_id: id, stage: 'sale_items' })
  logQueryError(shipmentError,          `${ROUTE} (shipment)`,           { sale_id: id, stage: 'shipment' })
  logQueryError(salePaymentsError,      `${ROUTE} (payments)`,           { sale_id: id, stage: 'payments' })
  logQueryError(exchangesError,         `${ROUTE} (exchanges)`,          { sale_id: id, stage: 'exchanges' })
  logQueryError(fiscalDocumentsError,   `${ROUTE} (fiscal_documents)`,   { sale_id: id, stage: 'fiscal_documents' })

  // Só a linha mais recente por tipo — `fiscal_documents` pode ter várias
  // (draft/submission_error de tentativas anteriores, ver seção 22 do
  // pedido: nunca duas AUTORIZADAS, mas rascunhos/erros de retry são
  // esperados e não devem "esconder" a tentativa mais recente atrás de
  // uma mais antiga).
  const latestFiscalDocByType: Record<string, any> = {}
  for (const row of (fiscalDocumentRows ?? []) as any[]) {
    if (!latestFiscalDocByType[row.document_type]) latestFiscalDocByType[row.document_type] = row
  }

  // ── Etapa 3: dependem dos resultados da etapa 2 ─────────────────────────────
  const variationIds = [...new Set((saleItems ?? []).map((i: any) => i.product_variation_id))]
  const exchangeIds  = (exchanges ?? []).map((e: any) => e.id)

  const stage3 = await Promise.all([
    variationIds.length
      ? admin.from('product_variations').select('id, sku_variation, product_id').in('id', variationIds)
      : Promise.resolve({ data: [], error: null }),
    exchangeIds.length
      ? (admin as any).from('exchange_items')
          .select('id, exchange_id, quantity_returned, unit_price, product_variation_id')
          .in('exchange_id', exchangeIds)
      : Promise.resolve({ data: [], error: null }),
  ]) as any[]

  const [
    { data: productVariations, error: productVariationsError },
    { data: exchangeItems, error: exchangeItemsError },
  ] = stage3

  logQueryError(productVariationsError, `${ROUTE} (product_variations)`, { sale_id: id, stage: 'product_variations' })
  logQueryError(exchangeItemsError,     `${ROUTE} (exchange_items)`,     { sale_id: id, stage: 'exchange_items' })

  // ── Etapa 4: depende da etapa 3 (produtos/atributos das variações) ─────────
  const productIds = [...new Set((productVariations ?? []).map((v: any) => v.product_id))]

  const stage4 = await Promise.all([
    productIds.length
      ? admin.from('products').select('id, name, sku').in('id', productIds)
      : Promise.resolve({ data: [], error: null }),
    variationIds.length
      ? (admin as any).from('product_variation_attributes')
          .select('product_variation_id, variation_types:variation_type_id(name,slug), variation_values:variation_value_id(value)')
          .in('product_variation_id', variationIds)
      : Promise.resolve({ data: [], error: null }),
  ]) as any[]

  const [
    { data: products, error: productsError },
    { data: variationAttributes, error: variationAttributesError },
  ] = stage4

  logQueryError(productsError,            `${ROUTE} (products)`,              { sale_id: id, stage: 'products' })
  logQueryError(variationAttributesError, `${ROUTE} (variation_attributes)`,   { sale_id: id, stage: 'variation_attributes' })

  // ── Reagrupar no mesmo formato que a página já consome ──────────────────────
  const productsById = new Map((products ?? []).map((p: any) => [p.id, p]))

  const attrsByVariation = new Map<number, any[]>()
  for (const a of variationAttributes ?? []) {
    const list = attrsByVariation.get(a.product_variation_id) ?? []
    list.push(a)
    attrsByVariation.set(a.product_variation_id, list)
  }

  const variationsById = new Map(
    (productVariations ?? []).map((v: any) => [v.id, {
      ...v,
      products: productsById.get(v.product_id) ?? null,
      product_variation_attributes: attrsByVariation.get(v.id) ?? [],
    }])
  )

  const saleItemsEnriched = (saleItems ?? []).map((item: any) => ({
    ...item,
    product_variations: variationsById.get(item.product_variation_id) ?? null,
  }))

  const exchangeItemsByExchange = new Map<number, any[]>()
  for (const ei of exchangeItems ?? []) {
    const list = exchangeItemsByExchange.get(ei.exchange_id) ?? []
    list.push(ei)
    exchangeItemsByExchange.set(ei.exchange_id, list)
  }

  const exchangesEnriched = (exchanges ?? []).map((ex: any) => ({
    ...ex,
    exchange_items: exchangeItemsByExchange.get(ex.id) ?? [],
  }))

  const hasExchanges = exchangesEnriched.length > 0

  return {
    ...sale,
    customers:         customer ?? null,
    seller:            seller ?? null,
    responsibleSeller: responsibleSeller ?? null,
    sale_items:        saleItemsEnriched,
    shipment:          shipment ?? null,
    salePayments:      salePayments ?? [],
    exchanges:         exchangesEnriched,
    hasExchanges,
    fiscalDocuments:   latestFiscalDocByType,
  }
}

export default async function VendaDetalhePage({ params }: { params: { id: string } }) {
  const sale = await getSale(params.id)
  if (!sale) notFound()

  const serverClient = createClient()
  const { data: { user: authUser } } = await serverClient.auth.getUser()
  const profile = authUser ? await getUserProfile(authUser.id, authUser.email) : null
  const requiresAuth = profile?.role === 'usuario'

  const isTerminal  = sale.status === 'cancelled' || sale.status === 'returned'
  const canReturn   = sale.status === 'delivered' || sale.status === 'paid'
  const canExchange = canReturn && !isTerminal
  const currentStepIndex = STATUS_STEPS.indexOf(sale.status as SaleStatus)

  const isPickup = sale.shipment?.delivery_mode === 'pickup'
  const statusLabels = isPickup ? STATUS_LABELS_PICKUP : STATUS_LABELS_DELIVERY

  // ─── Fiscal: resolução do documento (Fase Fiscal 4F, item 10 do pedido —
  // nunca escolha manual, sempre decorrente da operação real da venda).
  //
  // AUDITORIA (Fase Fiscal 4G, achado real na venda 636): `sale.shipment`
  // vem de `shipments.order_id = sale.id` (query em `getSale`, linha ~104
  // deste arquivo) — SEMPRE contra `sales.id`, NUNCA contra `pedidos.id`
  // (tabela não relacionada — staging de webhook Nuvemshop, PK UUID,
  // schema totalmente diferente). Esse é o MESMO join já usado por
  // `vw_sale_shipping_summary` (`20260613_shipping_fiscal_ready.sql:169`
  // — `FROM public.sales s LEFT JOIN public.shipments sh ON sh.order_id =
  // s.id`), não uma associação inventada aqui.
  //
  // Confirmado: NÃO existe FK enforced entre `shipments.order_id` e
  // `sales.id` — por isso uma linha `shipments` encontrada é tratada como
  // sinal best-effort (usada se existir), e a AUSÊNCIA de linha (venda de
  // balcão que legitimamente nunca cria `shipments` — caso real da venda
  // 636: `sale_origin='store'`, sem `shipments`, `shipping_charged=10`)
  // vira `deliveryMode: null`, nunca um valor inventado. `resolveFiscal
  // DocumentType` já trata `null` + `saleOrigin='store'` como retirada
  // (`nfce`) sem exigir a linha `shipments` — não depende da existência
  // dela (ver `resolveFiscalDocumentType.ts`).
  //
  // `sale.shipping_charged` (usado só para exibição na UI, linha ~440)
  // NUNCA entra nesta construção — um valor de frete cobrado > 0 não é,
  // sozinho, evidência de entrega (pode ser embalagem/taxa de balcão) —
  // confirmado por grep: `shipping_charged` não aparece em nenhum ponto
  // deste bloco.
  const fiscalResolverInput = { deliveryMode: sale.shipment?.delivery_mode ?? null, saleOrigin: sale.sale_origin ?? null }
  const resolvedFiscalDocumentType = resolveFiscalDocumentType(fiscalResolverInput)
  const fiscalBlockedReason = describeFiscalDocumentTypeBlockReason(fiscalResolverInput)
  const customerCpf = sale.customers?.cpf ?? null
  const maskedCustomerCpf = customerCpf && validateCPF(customerCpf) ? maskCPF(customerCpf) : null

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link href="/vendas">
            <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary font-mono">{sale.sale_number}</h2>
              <SaleStatusBadge status={sale.status as SaleStatus} />
              {/* PDV atacado/varejo (2026-09-02) — sale.sale_type já vem do
                  select('*') em getSale(), sempre a modalidade PERSISTIDA
                  (nunca assumida como retail por default na tela). */}
              <span className={cn(
                'inline-flex items-center text-xs px-2 py-0.5 rounded-full font-bold tracking-wide',
                sale.sale_type === 'wholesale'
                  ? 'bg-purple-500/15 text-purple-400 border border-purple-500/20'
                  : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
              )}>
                {sale.sale_type === 'wholesale' ? 'ATACADO' : 'VAREJO'}
              </span>
              {sale.shipment && (
                <span className={cn(
                  'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium',
                  isPickup
                    ? 'bg-purple-500/15 text-purple-400 border border-purple-500/20'
                    : 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
                )}>
                  {isPickup
                    ? <><Package className="w-3 h-3" /> Retirada</>
                    : <><Truck className="w-3 h-3" /> Envio</>
                  }
                </span>
              )}
            </div>
            <p className="text-sm text-text-muted mt-0.5">
              {formatDate(sale.sale_date)}
              {' · '}
              <Link href={`/clientes/${sale.customers?.id}`} className="hover:text-text-secondary transition-colors">
                {sale.customers?.name ?? '—'}
              </Link>
              {' · '}
              {PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/vendas/${sale.id}/editar`}>
            <Button variant="outline" size="sm">
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              Editar
            </Button>
          </Link>
          {!isPickup && (
            <Link href={`/vendas/${sale.id}/imprimir`} target="_blank">
              <Button variant="outline" size="sm">
                <Printer className="w-3.5 h-3.5 mr-1.5" />
                Imprimir Etiqueta
              </Button>
            </Link>
          )}
          {/* Comprovante não fiscal — sempre disponível, independente de NF-e/NFC-e
              emitida ou não (comercial e fiscal são independentes por design). */}
          <Link href={`/vendas/${sale.id}/comprovante`} target="_blank">
            <Button variant="outline" size="sm">
              <Printer className="w-3.5 h-3.5 mr-1.5" />
              Imprimir Comprovante
            </Button>
          </Link>
          {canExchange && (
            <Link href={`/vendas/${sale.id}/troca`}>
              <Button variant="secondary" size="sm">
                <ArrowRightLeft className="w-3.5 h-3.5 mr-1.5" />
                Registrar Troca
              </Button>
            </Link>
          )}
          {/* Só mostra Devolução se não tiver trocas parciais — evita dupla devolução */}
          {canReturn && !sale.hasExchanges && <ReturnButton saleId={sale.id} requiresAuth={requiresAuth} />}
          {!isTerminal && <CancelSaleButton saleId={sale.id} requiresAuth={requiresAuth} />}
        </div>
      </div>

      {/* Status Timeline */}
      {!isTerminal ? (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-5">Status do Pedido</h3>
          <div className="flex items-start">
            {STATUS_STEPS.map((step, i) => {
              const done = currentStepIndex >= i
              const current = currentStepIndex === i
              return (
                <div key={step} className="flex-1 flex flex-col items-center">
                  <div className="flex items-center w-full">
                    {i > 0 && (
                      <div className={cn('h-0.5 flex-1', done ? 'bg-brand' : 'bg-bg-overlay')} />
                    )}
                    <div className={cn(
                      'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0',
                      done ? 'bg-brand text-white' : 'bg-bg-overlay text-text-muted'
                    )}>
                      {i + 1}
                    </div>
                    {i < STATUS_STEPS.length - 1 && (
                      <div className={cn('h-0.5 flex-1', currentStepIndex > i ? 'bg-brand' : 'bg-bg-overlay')} />
                    )}
                  </div>
                  <span className={cn(
                    'text-[11px] mt-2 text-center leading-tight',
                    current ? 'text-brand font-semibold' : done ? 'text-text-secondary' : 'text-text-muted'
                  )}>
                    {statusLabels[step]}
                  </span>
                </div>
              )
            })}
          </div>

          {/* Shipment status detail */}
          {sale.shipment && (
            <div className={cn(
              'mt-5 pt-4 border-t border-border flex items-center gap-2 text-sm',
            )}>
              {isPickup
                ? <Package className="w-4 h-4 text-purple-400 flex-shrink-0" />
                : <Truck className="w-4 h-4 text-blue-400 flex-shrink-0" />
              }
              <span className="text-text-muted">Status do envio:</span>
              <span className={cn(
                'font-medium',
                sale.shipment.status === 'aguardando_retirada' ? 'text-purple-400' :
                sale.shipment.status === 'aguardando_confirmacao' ? 'text-yellow-400' :
                sale.shipment.status === 'em_transito' ? 'text-blue-400' :
                sale.shipment.status === 'entregue' ? 'text-success' :
                sale.shipment.status === 'nao_entregue' ? 'text-error' :
                'text-text-secondary'
              )}>
                {SHIPMENT_STATUS_LABELS[sale.shipment.status] ?? sale.shipment.status}
              </span>
            </div>
          )}
        </Card>
      ) : (
        <Card padding="md">
          <p className="text-sm text-text-secondary">
            Este pedido foi <span className="font-semibold text-text-primary">{statusLabels[sale.status]}</span>.
          </p>
        </Card>
      )}

      {/* Items */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold text-text-primary">Itens do Pedido</h3>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Produto</TableHead>
              <TableHead>Variação</TableHead>
              <TableHead align="right">Qtd</TableHead>
              <TableHead align="right">Unit.</TableHead>
              <TableHead align="right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(sale.sale_items ?? []).map((item: any) => {
              const pv = item.product_variations
              const attrs = (pv?.product_variation_attributes ?? []) as any[]
              const variation = attrs.map((a: any) => a.variation_values?.value).filter(Boolean).join(' / ')
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className="font-medium text-text-primary">
                      {pv?.products?.name ?? '—'}
                    </span>
                    <span className="block text-xs text-text-muted font-mono">{pv?.sku_variation}</span>
                  </TableCell>
                  <TableCell muted>{variation || 'Padrão'}</TableCell>
                  <TableCell align="right">{item.quantity}</TableCell>
                  <TableCell align="right">{formatCurrency(item.unit_price)}</TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(item.total_price)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      {/* Financial Summary */}
      <Card padding="md">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Resumo Financeiro</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-text-muted">Subtotal</span>
            <span className="text-text-secondary">{formatCurrency(sale.subtotal)}</span>
          </div>
          {sale.discount_amount > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Desconto</span>
              <span className="text-error">− {formatCurrency(sale.discount_amount)}</span>
            </div>
          )}
          {sale.shipping_charged > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Frete</span>
              <span className="text-text-secondary">+ {formatCurrency(sale.shipping_charged)}</span>
            </div>
          )}
          {(sale.surcharge_amount ?? 0) > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Acréscimo</span>
              <span className="text-warning">+ {formatCurrency(sale.surcharge_amount)}</span>
            </div>
          )}
          {sale.cashback_used > 0 && (
            <div className="flex justify-between">
              <span className="text-text-muted">Cashback Utilizado</span>
              <span className="text-success">− {formatCurrency(sale.cashback_used)}</span>
            </div>
          )}
          <div className="flex justify-between font-bold pt-2 border-t border-border text-text-primary">
            <span>Total</span>
            <span>{formatCurrency(sale.total)}</span>
          </div>
        </div>
      </Card>

      {/* Pagamentos detalhados (sale_payments) */}
      {sale.salePayments && sale.salePayments.length > 0 ? (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-text-primary">Formas de Pagamento</h3>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Método</TableHead>
                <TableHead align="right">Valor cobrado</TableHead>
                <TableHead align="right">Entregue</TableHead>
                <TableHead align="right">Troco</TableHead>
                <TableHead align="right">Taxa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.salePayments.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="font-medium text-text-primary">
                      {PAYMENT_LABELS[p.method] ?? p.method}
                      {p.installments > 1 ? ` ${p.installments}×` : ''}
                    </span>
                    {p.card_brand && (
                      <span className="block text-xs text-text-muted">{p.card_brand}{p.acquirer ? ` · ${p.acquirer}` : ''}</span>
                    )}
                    {p.change_method && p.change_amount > 0 && (
                      <span className="block text-xs text-text-muted">
                        Troco via {p.change_method === 'pix' ? 'PIX' : 'dinheiro'}
                      </span>
                    )}
                  </TableCell>
                  <TableCell align="right" className="font-semibold">{formatCurrency(p.net_amount)}</TableCell>
                  <TableCell align="right" muted>{formatCurrency(p.amount_tendered)}</TableCell>
                  <TableCell align="right" muted>
                    {p.change_amount > 0 ? formatCurrency(p.change_amount) : '—'}
                  </TableCell>
                  <TableCell align="right" muted>
                    {p.fee_amount > 0 ? formatCurrency(p.fee_amount) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        /* Legado: exibe apenas o método registrado em sales.payment_method */
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Pagamento</h3>
          <p className="text-sm text-text-secondary">
            {PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method}
          </p>
        </Card>
      )}

      {/* Trocas realizadas nesta venda */}
      {sale.exchanges && sale.exchanges.length > 0 && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-3">
            Trocas Registradas ({sale.exchanges.length})
          </h3>
          <div className="space-y-3">
            {sale.exchanges.map((ex: any, idx: number) => (
              <div
                key={ex.id}
                className="flex items-center justify-between gap-2 text-sm py-2 border-t border-border first:border-t-0 first:pt-0"
              >
                <div>
                  <span className="font-medium text-text-primary">
                    Troca #{idx + 1}
                  </span>
                  <span className="ml-2 text-text-muted">
                    {formatDate(ex.created_at)}
                  </span>
                  <span className="ml-2 text-text-muted">
                    · {ex.exchange_items?.length ?? 0} item
                    {(ex.exchange_items?.length ?? 0) !== 1 ? 's' : ''} devolvidos
                  </span>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-success font-semibold">
                    + {formatCurrency(ex.credit_issued)} crédito
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {sale.notes && (
        <Card padding="md">
          <h3 className="text-sm font-semibold text-text-primary mb-2">Observações</h3>
          <p className="text-sm text-text-secondary">{sale.notes}</p>
        </Card>
      )}

      {/* Fiscal — só admin (mesma regra de "Fiscal" bloqueado pra usuario, Fase Fiscal 1) */}
      {profile?.role === 'admin' && (
        <DocumentoFiscalCard
          saleId={sale.id}
          saleStatus={sale.status}
          resolvedType={resolvedFiscalDocumentType}
          blockedReason={fiscalBlockedReason}
          maskedCpf={maskedCustomerCpf}
          initialDocuments={sale.fiscalDocuments as Record<'nfe' | 'nfce', InitialFiscalDocument | undefined>}
        />
      )}
    </div>
  )
}
