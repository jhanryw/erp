import { createAdminClient } from '@/lib/supabase/admin'
import { notFound } from 'next/navigation'
import { PrintTrigger } from './PrintTrigger'

export const dynamic = 'force-dynamic'

const PAYMENT_LABELS: Record<string, string> = {
  pix:         'PIX',
  card:        'Cartão',
  cash:        'Dinheiro',
  credit_card: 'Cartão de Crédito',
  debit_card:  'Cartão de Débito',
}

async function getSaleForPrint(id: string) {
  const admin = createAdminClient()

  const { data: sale } = await (admin as any)
    .from('sales')
    .select(`
      id,
      sale_number,
      status,
      total,
      payment_method,
      customers (
        id,
        name,
        phone
      ),
      shipments (
        delivery_mode,
        customer_addresses (
          street,
          number,
          complement,
          neighborhood,
          city,
          state,
          cep
        )
      )
    `)
    .eq('id', Number(id))
    .single()

  if (!sale) return null

  // Verificar se já tem pagamento registrado
  const { count: paymentsCount } = await (admin as any)
    .from('sale_payments')
    .select('id', { count: 'exact', head: true })
    .eq('sale_id', Number(id))

  const isPaid = sale.status === 'paid' ||
                 sale.status === 'shipped' ||
                 sale.status === 'delivered' ||
                 (paymentsCount && paymentsCount > 0)

  return { sale, isPaid: !!isPaid }
}

function formatPhone(phone: string | null) {
  if (!phone) return null
  const d = phone.replace(/\D/g, '')
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`
  return phone
}

function formatCEP(cep: string | null) {
  if (!cep) return ''
  const d = cep.replace(/\D/g, '')
  if (d.length === 8) return `${d.slice(0,5)}-${d.slice(5)}`
  return cep
}

export default async function ImprimirEtiquetaPage({ params }: { params: { id: string } }) {
  const result = await getSaleForPrint(params.id)
  if (!result) notFound()

  const { sale, isPaid } = result
  const customer = sale.customers
  const shipment = Array.isArray(sale.shipments) ? sale.shipments[0] : sale.shipments
  const address  = shipment?.customer_addresses
    ? (Array.isArray(shipment.customer_addresses) ? shipment.customer_addresses[0] : shipment.customer_addresses)
    : null

  const addressLine1 = address
    ? `${address.street}, ${address.number}${address.complement ? ` - ${address.complement}` : ''}`
    : null
  const addressLine2 = address
    ? `${address.neighborhood} · CEP ${formatCEP(address.cep)}`
    : null
  const addressLine3 = address
    ? `${address.city} - ${address.state}`
    : null

  return (
    <>
      {/* Auto-print ao abrir */}
      <PrintTrigger />

      <style>{`
        @page {
          size: A4;
          margin: 8mm;
        }

        body {
          margin: 0;
          padding: 0;
          background: white;
        }

        .labels-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 6mm;
          width: 100%;
        }

        .label {
          border: 1.5px solid #222;
          border-radius: 4px;
          padding: 5mm 6mm;
          font-family: Arial, Helvetica, sans-serif;
          font-size: 9pt;
          color: #000;
          page-break-inside: avoid;
          break-inside: avoid;
          background: white;
        }

        .label-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #555;
          padding-bottom: 3mm;
          margin-bottom: 3mm;
        }

        .label-logo {
          height: 18px;
          width: auto;
          filter: grayscale(100%) contrast(200%) brightness(0);
        }

        .label-logo-text {
          font-size: 13pt;
          font-weight: 900;
          letter-spacing: 2px;
          color: #000;
          text-transform: uppercase;
        }

        .sale-number {
          font-size: 7.5pt;
          color: #444;
          font-family: monospace;
        }

        .label-field {
          margin-bottom: 2mm;
          line-height: 1.4;
        }

        .label-field strong {
          font-weight: 700;
        }

        .payment-badge {
          margin-top: 4mm;
          padding: 2mm 3mm;
          border-radius: 3px;
          font-size: 9.5pt;
          font-weight: 700;
          text-align: center;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .payment-badge.paid {
          border: 1.5px solid #000;
          background: #000;
          color: #fff;
        }

        .payment-badge.pending {
          border: 2px solid #000;
          background: #fff;
          color: #000;
        }

        .no-address {
          font-style: italic;
          color: #777;
          font-size: 8pt;
        }

        /* Botão de imprimir — visível só na tela */
        .screen-only {
          padding: 16px;
          background: #f5f5f5;
          display: flex;
          gap: 12px;
          align-items: center;
          font-family: Arial, sans-serif;
          border-bottom: 1px solid #ddd;
        }

        .btn-print {
          padding: 8px 20px;
          background: #000;
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
        }

        .btn-back {
          padding: 8px 16px;
          background: transparent;
          color: #555;
          border: 1px solid #ccc;
          border-radius: 6px;
          font-size: 14px;
          cursor: pointer;
          text-decoration: none;
        }

        @media print {
          .screen-only { display: none !important; }
          .labels-grid { gap: 4mm; }
        }
      `}</style>

      {/* Barra de ações (visível só na tela) */}
      <div className="screen-only">
        <button className="btn-print" onClick={() => window.print()}>
          🖨️ Imprimir
        </button>
        <a href={`/vendas/${params.id}`} className="btn-back">
          ← Voltar para a venda
        </a>
        <span style={{ fontSize: 13, color: '#888' }}>
          Salve <code>logo-santtorini.png</code> em <code>/public/</code> para o logo aparecer.
        </span>
      </div>

      {/* Grade de etiquetas — repete 4x para preencher a folha */}
      <div className="labels-grid">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="label">
            {/* Cabeçalho */}
            <div className="label-header">
              {/* Se o arquivo de logo existir, mostra ele; senão, texto */}
              <span className="label-logo-text">SANTTORINI</span>
              <span className="sale-number">#{sale.sale_number}</span>
            </div>

            {/* Cliente */}
            <div className="label-field">
              <strong>{customer?.name ?? '—'}</strong>
            </div>

            {customer?.phone && (
              <div className="label-field">
                📞 {formatPhone(customer.phone)}
              </div>
            )}

            {/* Endereço */}
            {addressLine1 ? (
              <>
                <div className="label-field">{addressLine1}</div>
                <div className="label-field">{addressLine2}</div>
                <div className="label-field">{addressLine3}</div>
              </>
            ) : (
              <div className="label-field no-address">Endereço não cadastrado</div>
            )}

            {/* Pagamento */}
            <div className={`payment-badge ${isPaid ? 'paid' : 'pending'}`}>
              {isPaid
                ? '✓ PAGO'
                : `COBRAR: ${PAYMENT_LABELS[sale.payment_method] ?? sale.payment_method}`}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
