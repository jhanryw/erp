// DANFE NFC-e real (Fase Fiscal 7) — representação impressa da NFC-e JÁ
// AUTORIZADA, térmica (mesma largura útil ~72mm dentro da bobina 80mm da
// Epson TM-T20X-II usada pelo comprovante não-fiscal).
//
// Diferente de /vendas/[id]/comprovante (que é explicitamente NÃO fiscal):
// esta página só existe/renderiza quando há uma NFC-e com
// status='authorized' pra esta venda — GET puro, nunca emite nada (item 60
// do pedido). Reimpressão = navegar de novo pra esta mesma URL: os dados
// vêm de fiscal_documents/fiscal_document_items (snapshot imutável),
// nunca recalculados — nunca cria um documento novo nem reconsulta a Focus.
//
// ─── `?environment=` (fundação homologação↔produção, 2026-09-06) ───────────
//
// `getNfceDanfeData` agora exige `environment` explícito (uma venda pode
// ter NFC-e autorizada em homologação E em produção simultaneamente — ver
// migration 202609061000). Esta página lê `?environment=homologacao|
// producao` da querystring; qualquer valor ausente/inválido cai no
// default `'homologacao'` — hoje o único ambiente que realmente tem
// documentos autorizados (produção continua bloqueada em
// submitNfceHomologacao.ts), então o default preserva 100% do
// comportamento de todo link/bookmark existente sem querystring. Quem
// sabe explicitamente que quer o documento oficial (comprovante.tsx,
// depois que produção existir) passa `?environment=producao`.

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requirePageRole } from '@/lib/auth/requirePageRole'
import { getNfceDanfeData, formatAccessKey } from '@/services/fiscal/getNfceDanfeData'
import { formatCurrency } from '@/lib/utils/currency'
import { formatDateTime } from '@/lib/utils/date'
import QRCode from 'qrcode'
import { PrintTrigger } from '../comprovante/PrintTrigger'
import { PrintButton } from '../comprovante/PrintButton'

export const dynamic = 'force-dynamic'

const PAYMENT_LABELS: Record<string, string> = {
  pix: 'PIX',
  card: 'Cartão',
  cash: 'Dinheiro',
  credit_card: 'Cartão de Crédito',
  debit_card: 'Cartão de Débito',
  cashback: 'Crédito de Troca',
}

/** Nunca lança — mesma blindagem de generateReceiptQr.ts, mas aqui o conteúdo é o qrcode_url REAL da Focus, nunca construído localmente. */
async function generateFiscalQr(content: string): Promise<string | null> {
  try {
    return await QRCode.toString(content, { type: 'svg', margin: 2, width: 140 })
  } catch {
    return null
  }
}

export default async function DanfeNfcePage({ params, searchParams }: { params: { id: string }; searchParams: { environment?: string } }) {
  const profile = await requirePageRole('usuario')
  const saleId = Number(params.id)
  if (!saleId || !profile.company_id) notFound()

  const environment = searchParams.environment === 'producao' ? 'producao' : 'homologacao'
  const result = await getNfceDanfeData({ saleId, companyId: profile.company_id, environment })
  // Nunca renderiza NADA daqui se não houver NFC-e AUTORIZADA pra esta
  // venda nesta empresa — inclusive pendente/rejeitada/cancelada cai aqui
  // (item 27/28 do pedido: nunca mostrar "autorizado" pra algo que não foi).
  if (!result.ok && result.reason === 'not_found') notFound()

  // Documento autorizado mas com dado local incompleto — item 8 do pedido:
  // NUNCA renderiza um DANFE aparentemente válido nesse caso. O erro já foi
  // logado dentro de getNfceDanfeData; aqui só comunica ao operador.
  if (!result.ok) {
    return (
      <div style={{ fontFamily: 'sans-serif', padding: 24, maxWidth: 480, margin: '0 auto' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, color: '#b91c1c' }}>
          Documento fiscal autorizado com dados locais incompletos
        </h1>
        <p style={{ fontSize: 13, color: '#555', marginTop: 8 }}>
          Esta NFC-e foi autorizada pela SEFAZ, mas faltam dados locais necessários pra montar o DANFE com segurança
          ({result.missing.join(', ')}). Não é seguro imprimir. Contate o time técnico antes de tentar novamente.
        </p>
        <Link href={`/vendas/${saleId}`} style={{ fontSize: 13, color: '#2563eb', display: 'inline-block', marginTop: 12 }}>
          ← Voltar para a venda
        </Link>
      </div>
    )
  }

  const danfe = result.data

  const qrSvg = danfe.fiscalDocument.qrcodeUrl ? await generateFiscalQr(danfe.fiscalDocument.qrcodeUrl) : null
  const isHomologacao = danfe.fiscalDocument.environment !== 'producao'
  const accessKeyFormatted = formatAccessKey(danfe.fiscalDocument.accessKey)

  return (
    <>
      <PrintTrigger />

      <style>{`
        /* Mesma área útil da Epson TM-T20X-II já validada pelo comprovante
           não-fiscal — 80mm de bobina, ~72mm realmente imprimível. */
        @page { size: 80mm auto; margin: 0; }
        body { margin: 0; padding: 0; background: white; }

        .danfe {
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
        .store-name { font-size: 12pt; font-weight: 900; letter-spacing: 0.5px; }
        .emitente-line { font-size: 8pt; color: #222; }
        .badge-homolog {
          margin: 1.5mm 0; padding: 1mm 2mm; border: 1.5px solid #000;
          display: inline-block; font-size: 8.5pt; font-weight: 700; letter-spacing: 0.5px;
        }
        .danfe-title { font-size: 9pt; font-weight: 700; margin: 1.5mm 0; }
        .row { display: flex; justify-content: space-between; gap: 4mm; }
        .item-line { margin: 1.5mm 0; }
        .item-name { font-weight: 700; }
        .item-detail { font-size: 8.5pt; color: #333; }
        .totals-row { display: flex; justify-content: space-between; margin: 0.5mm 0; }
        .grand-total { font-size: 11pt; font-weight: 900; }
        .qr-wrap { display: flex; justify-content: center; margin: 3mm 0 1mm; }
        .qr-wrap svg { width: 30mm; height: 30mm; }
        .fiscal-key { font-size: 8pt; word-break: break-all; text-align: center; margin: 1mm 0; }
        .consulta-url { font-size: 7pt; word-break: break-all; text-align: center; color: #333; }
        .disclaimer { font-size: 7.5pt; color: #333; margin-top: 2mm; }

        .screen-only {
          padding: 16px; background: #f5f5f5; display: flex; gap: 12px;
          align-items: center; font-family: Arial, sans-serif;
          border-bottom: 1px solid #ddd; margin-bottom: 16px;
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

      <div className="danfe">
        <div className="center">
          {isHomologacao && (
            <div className="badge-homolog">AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>
          )}
          <div className="store-name">{danfe.emitente.razaoSocial ?? 'Emitente não configurado'}</div>
          <div className="emitente-line">CNPJ {danfe.emitente.cnpj ?? '—'}</div>
          {danfe.emitente.inscricaoEstadual && (
            <div className="emitente-line">IE {danfe.emitente.inscricaoEstadual}</div>
          )}
          {danfe.emitente.logradouro && (
            <div className="emitente-line">
              {danfe.emitente.logradouro}, {danfe.emitente.numero ?? 'S/N'}
              {danfe.emitente.complemento ? ` - ${danfe.emitente.complemento}` : ''}
              {danfe.emitente.bairro ? ` - ${danfe.emitente.bairro}` : ''}
            </div>
          )}
          {danfe.emitente.municipio && (
            <div className="emitente-line">{danfe.emitente.municipio}/{danfe.emitente.uf} {danfe.emitente.cep ?? ''}</div>
          )}
          <div className="danfe-title">
            DANFE NFC-e — Documento Auxiliar da Nota Fiscal<br />de Consumidor Eletrônica
          </div>
        </div>

        <div className="divider" />

        <div className="row">
          <span>Venda</span>
          <span className="bold">{danfe.sale.sale_number}</span>
        </div>
        <div className="row">
          <span>Data</span>
          <span>{formatDateTime(danfe.sale.created_at)}</span>
        </div>
        {danfe.destinatario?.nome && (
          <div className="row">
            <span>Consumidor</span>
            <span>{danfe.destinatario.nome}</span>
          </div>
        )}
        {danfe.destinatario?.cpf && (
          <div className="row">
            <span>CPF</span>
            <span>{danfe.destinatario.cpf}</span>
          </div>
        )}
        {danfe.destinatario?.cnpj && (
          <div className="row">
            <span>CNPJ</span>
            <span>{danfe.destinatario.cnpj}</span>
          </div>
        )}
        {!danfe.destinatario?.nome && !danfe.destinatario?.cpf && !danfe.destinatario?.cnpj && (
          <div className="row">
            <span>Consumidor</span>
            <span>Não identificado</span>
          </div>
        )}

        <div className="divider" />

        {danfe.items.map((item, idx) => (
          <div key={idx} className="item-line">
            <div className="row item-name">
              <span>{item.description}</span>
              <span>{formatCurrency(item.total_amount)}</span>
            </div>
            <div className="item-detail">
              {item.quantity} {item.unit} × {formatCurrency(item.unit_price)}
              {item.discount_amount > 0 && ` (desc. ${formatCurrency(item.discount_amount)})`}
            </div>
          </div>
        ))}

        <div className="divider" />

        <div className="row grand-total">
          <span>TOTAL</span>
          <span>{formatCurrency(danfe.total)}</span>
        </div>

        <div className="divider" />

        <div className="bold" style={{ marginBottom: '1mm' }}>Forma de pagamento</div>
        {danfe.payments.map((p, idx) => (
          <div className="totals-row" key={idx}>
            <span>{PAYMENT_LABELS[p.method] ?? p.method}</span>
            <span>{formatCurrency(p.amount_tendered)}</span>
          </div>
        ))}
        {danfe.payments.some((p) => p.change_amount > 0) && (
          <div className="totals-row">
            <span>Troco</span>
            <span>{formatCurrency(danfe.payments.reduce((s, p) => s + p.change_amount, 0))}</span>
          </div>
        )}

        <div className="divider" />

        <div className="row">
          <span>Número/Série</span>
          <span className="bold">{danfe.fiscalDocument.number ?? '—'}/{danfe.fiscalDocument.series ?? '—'}</span>
        </div>
        {danfe.fiscalDocument.authorizationProtocol && (
          <div className="row">
            <span>Protocolo</span>
            <span>{danfe.fiscalDocument.authorizationProtocol}</span>
          </div>
        )}
        {danfe.fiscalDocument.authorizedAt && (
          <div className="row">
            <span>Autorização</span>
            <span>{formatDateTime(danfe.fiscalDocument.authorizedAt)}</span>
          </div>
        )}

        {accessKeyFormatted && (
          <>
            <div className="center" style={{ marginTop: '1.5mm' }}>Chave de acesso</div>
            <div className="fiscal-key bold">{accessKeyFormatted}</div>
          </>
        )}

        {qrSvg ? (
          <div className="qr-wrap" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        ) : danfe.fiscalDocument.qrcodeUrl ? (
          <div className="center" style={{ margin: '2mm 0' }}>QR Code indisponível — consulte pela URL abaixo</div>
        ) : null}

        {danfe.fiscalDocument.qrcodeUrl && (
          <div className="consulta-url">Consulte pela Chave de Acesso em: {danfe.fiscalDocument.qrcodeUrl}</div>
        )}

        <div className="divider" />

        <div className="disclaimer center">
          NFC-e — Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica.
          <br />
          Não permite aproveitamento de crédito de ICMS.
        </div>
      </div>
    </>
  )
}
