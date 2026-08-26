// Comprovante não fiscal — impressão interna (80mm térmica).
//
// Disponível independentemente de NFC-e/NF-e emitida ou não — comercial e
// fiscal são independentes por design (requisito 7 do pedido). Nunca lê
// fiscal_documents/Focus/resolveFiscalDocumentType.
//
// Não existe hoje nenhuma configuração de "política de troca" armazenada no
// ERP (grep confirma — nenhuma tabela/coluna do tipo politica_troca/
// exchange_policy/return_policy). Por instrução explícita, esta página NÃO
// inventa um texto jurídico de troca — a seção só apareceria se e quando tal
// configuração existir.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { headers } from 'next/headers'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getReceiptForSalePrint } from '@/lib/receipts/getReceiptData'
import { generateReceiptQr, formatShortReceiptCode, buildVerificationUrl } from '@/lib/receipts/generateReceiptQr'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import { PrintTrigger } from './PrintTrigger'
import { PrintButton } from './PrintButton'

export const dynamic = 'force-dynamic'

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'PIX',
  card: 'Cartão',
  cash: 'Dinheiro',
  credit_card: 'Cartão de Crédito',
  debit_card: 'Cartão de Débito',
  cashback: 'Crédito de Troca',
}

/**
 * Resolve a origem pública (protocolo+host) pra montar a URL do QR.
 * Prioridade: cabeçalhos da REQUISIÇÃO REAL (x-forwarded-host/host,
 * x-forwarded-proto) — funciona em qualquer ambiente sem precisar de
 * configuração manual, e é o que estava faltando: NEXT_PUBLIC_APP_URL só
 * existe em .env.local (desenvolvimento), nunca foi configurada no
 * ambiente de produção, então o QR sempre caía no fallback. Cabeçalhos de
 * requisição sempre refletem o domínio real usado pelo navegador — este
 * app já roda atrás de proxy reverso (EasyPanel, ver comentário em
 * src/lib/errors/log.ts), que encaminha x-forwarded-host/x-forwarded-proto
 * normalmente. NEXT_PUBLIC_APP_URL vira só um fallback secundário, pro
 * caso raro de o proxy não enviar esses cabeçalhos.
 */
function resolvePublicOrigin(): string | null {
  const h = headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (host) {
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
    return `${proto}://${host}`
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  return appUrl ? appUrl.replace(/\/$/, '') : null
}

export default async function ComprovantePage({ params }: { params: { id: string } }) {
  const profile = await requirePageRole('usuario')
  const saleId = Number(params.id)
  if (!saleId || !profile.company_id) notFound()

  const receipt = await getReceiptForSalePrint({ saleId, companyId: profile.company_id })
  if (!receipt) notFound()

  const origin = resolvePublicOrigin()
  const verificationUrl = origin ? buildVerificationUrl(origin, receipt.sale.receipt_token) : null
  const qrSvg = verificationUrl ? await generateReceiptQr(verificationUrl, receipt.sale.id) : null

  return (
    <>
      <PrintTrigger />

      <style>{`
        /*
          80mm é a largura FÍSICA do rolo — a área realmente imprimível em
          impressoras térmicas de 80mm comuns costuma ficar em torno de
          ~72mm (a maioria dos drivers/POS trata @page margin de forma
          inconsistente nessas impressoras, então margem de segurança fica
          no próprio bloco de conteúdo, centralizado, não confiando só no
          @page margin do navegador).
        */
        @page { size: 80mm auto; margin: 0; }
        body { margin: 0; padding: 0; background: white; }

        .receipt {
          width: 72mm;
          margin: 0 auto;
          padding: 2mm 0;
          font-family: 'Courier New', monospace;
          font-size: 9.5pt;
          color: #000;
          background: white;
        }
        .center { text-align: center; }
        .bold { font-weight: 700; }
        .divider { border-top: 1px dashed #000; margin: 2mm 0; }
        .store-name { font-size: 13pt; font-weight: 900; letter-spacing: 1px; }
        .badge-nao-fiscal {
          margin: 1.5mm 0;
          padding: 1mm 2mm;
          border: 1.5px solid #000;
          display: inline-block;
          font-size: 8.5pt;
          font-weight: 700;
          letter-spacing: 0.5px;
        }
        .row { display: flex; justify-content: space-between; gap: 4mm; }
        .item-line { margin: 1.5mm 0; }
        .item-name { font-weight: 700; }
        .item-detail { font-size: 8.5pt; color: #333; }
        .totals-row { display: flex; justify-content: space-between; margin: 0.5mm 0; }
        .grand-total { font-size: 11pt; font-weight: 900; }
        .qr-wrap { display: flex; justify-content: center; margin: 3mm 0 1mm; }
        .qr-wrap svg { width: 28mm; height: 28mm; }
        .disclaimer { font-size: 7.5pt; color: #333; margin-top: 2mm; }

        .screen-only {
          padding: 16px; background: #f5f5f5; display: flex; gap: 12px;
          align-items: center; font-family: Arial, sans-serif;
          border-bottom: 1px solid #ddd; margin-bottom: 16px;
        }
        .btn-print {
          padding: 8px 20px; background: #000; color: #fff; border: none;
          border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
        }
        .btn-back {
          padding: 8px 16px; background: transparent; color: #555;
          border: 1px solid #ccc; border-radius: 6px; font-size: 14px;
          cursor: pointer; text-decoration: none;
        }
        @media print { .screen-only { display: none !important; } }
      `}</style>

      <div className="screen-only">
        <PrintButton />
        <Link href={`/vendas/${saleId}`} className="btn-back">
          ← Voltar para a venda
        </Link>
      </div>

      <div className="receipt">
        <div className="center">
          <div className="store-name">{receipt.store.name}</div>
          <div className="badge-nao-fiscal">COMPROVANTE NÃO FISCAL</div>
          <div style={{ fontSize: '7.5pt', color: '#333' }}>
            Não substitui NF-e/NFC-e — sem valor fiscal
          </div>
        </div>

        <div className="divider" />

        <div className="row">
          <span>Venda</span>
          <span className="bold">{receipt.sale.sale_number}</span>
        </div>
        <div className="row">
          <span>Data</span>
          <span>{formatDateTime(receipt.sale.created_at)}</span>
        </div>
        {/* PDV atacado/varejo (2026-09-02) — discreto, mesma linha de estilo
            do resto do comprovante, não fiscal (comercial e fiscal
            continuam independentes). */}
        <div className="row">
          <span>Modalidade</span>
          <span>{receipt.sale.sale_type === 'wholesale' ? 'Atacado' : 'Varejo'}</span>
        </div>
        {receipt.customer && (
          <div className="row">
            <span>Cliente</span>
            <span>{receipt.customer.name}</span>
          </div>
        )}

        <div className="divider" />

        {receipt.items.map((item) => (
          <div key={item.sale_item_id} className="item-line">
            <div className="row item-name">
              <span>{item.product_name}</span>
              <span>{formatCurrency(item.total_price)}</span>
            </div>
            {item.variation_label && <div className="item-detail">{item.variation_label}</div>}
            <div className="item-detail">
              {item.quantity}× {formatCurrency(item.unit_price)}
            </div>
          </div>
        ))}

        <div className="divider" />

        <div className="totals-row">
          <span>Subtotal</span>
          <span>{formatCurrency(receipt.totals.subtotal)}</span>
        </div>
        {receipt.totals.discount_amount > 0 && (
          <div className="totals-row">
            <span>Desconto</span>
            <span>-{formatCurrency(receipt.totals.discount_amount)}</span>
          </div>
        )}
        {receipt.totals.surcharge_amount > 0 && (
          <div className="totals-row">
            <span>Acréscimo</span>
            <span>+{formatCurrency(receipt.totals.surcharge_amount)}</span>
          </div>
        )}
        {receipt.totals.shipping_charged > 0 && (
          <div className="totals-row">
            <span>Frete</span>
            <span>{formatCurrency(receipt.totals.shipping_charged)}</span>
          </div>
        )}
        {receipt.totals.cashback_used > 0 && (
          <div className="totals-row">
            <span>Crédito usado</span>
            <span>-{formatCurrency(receipt.totals.cashback_used)}</span>
          </div>
        )}
        <div className="divider" />
        <div className="row grand-total">
          <span>TOTAL</span>
          <span>{formatCurrency(receipt.totals.total)}</span>
        </div>

        <div className="divider" />

        <div className="bold" style={{ marginBottom: '1mm' }}>Pagamento</div>
        {receipt.payments.map((p, idx) => (
          <div className="totals-row" key={idx}>
            <span>{PAYMENT_LABELS[p.method] ?? p.method}</span>
            <span>{formatCurrency(p.amount_tendered)}</span>
          </div>
        ))}

        <div className="divider" />

        {/*
          O receipt_token COMPLETO nunca aparece visualmente pro cliente —
          nem aqui nem na página pública /comprovante/[token]. Ele só vive no
          banco, na URL interna do QR e na busca interna (getReceiptByToken).
          O que aparece pro cliente, sempre, é só o código curto derivado
          (formatShortReceiptCode) — representação visual, não chave de
          autenticação, nunca substitui o token real.
        */}
        {qrSvg ? (
          <>
            <div className="qr-wrap" dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div className="center" style={{ margin: '1mm 0 2mm' }}>
              <div style={{ fontSize: '8pt', color: '#333' }}>Consulte sua compra</div>
              <div className="bold" style={{ fontSize: '10pt', letterSpacing: '1px', marginTop: '1mm' }}>
                Código curto: {formatShortReceiptCode(receipt.sale.receipt_token)}
              </div>
            </div>
          </>
        ) : (
          <div className="center" style={{ margin: '2mm 0' }}>
            <div style={{ fontSize: '8pt', color: '#333' }}>Consulte sua compra com o código abaixo</div>
            <div className="bold" style={{ fontSize: '10pt', letterSpacing: '1px', marginTop: '1mm' }}>
              Código: {formatShortReceiptCode(receipt.sale.receipt_token)}
            </div>
          </div>
        )}

        <div className="divider" />

        {/*
          Texto de política de troca — literal, informado explicitamente
          pelo usuário nesta revisão (não existe configuração de política de
          troca armazenada no ERP; não inventado aqui, é a regra de negócio
          real repassada em texto). Se um dia existir um campo próprio pra
          isso, este texto passa a vir de lá — hoje é fixo de propósito.
        */}
        <div className="bold" style={{ marginBottom: '1mm' }}>Trocas</div>
        <div style={{ fontSize: '8.5pt', color: '#333' }}>
          Trocas em até 7 dias mediante apresentação deste comprovante.
        </div>

        <div className="divider" />

        <div className="disclaimer center">
          Comprovante não fiscal.
          <br />
          Não substitui NF-e/NFC-e.
        </div>
      </div>
    </>
  )
}
