'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils/currency'
import { useCart } from '../_lib/CartContext'
import { useWholesaleBasePath } from '../_lib/WholesaleBasePathContext'
import { wholesaleHref } from '@/lib/wholesale/site-host'

interface RecipientForm {
  nome: string
  cpf: string
  cnpj: string
  telefone: string
  cep: string
  logradouro: string
  numero: string
  complemento: string
  bairro: string
  municipio: string
  uf: string
  municipio_ibge: string | null
  ibge_source: string | null
}

const EMPTY_RECIPIENT: RecipientForm = {
  nome: '', cpf: '', cnpj: '', telefone: '', cep: '', logradouro: '', numero: '', complemento: '', bairro: '', municipio: '', uf: '', municipio_ibge: null, ibge_source: null,
}

export function CheckoutClient({ customerName }: { customerName: string }) {
  const { items, totalDisplayValue, clear } = useCart()
  const router = useRouter()
  const basePath = useWholesaleBasePath()
  const [deliveryMode, setDeliveryMode] = useState<'pickup' | 'delivery'>('pickup')
  const [recipient, setRecipient] = useState<RecipientForm>({ ...EMPTY_RECIPIENT, nome: customerName })
  const [cepLoading, setCepLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [idempotencyKey] = useState(() => crypto.randomUUID())

  function patch(fields: Partial<RecipientForm>) {
    setRecipient((r) => ({ ...r, ...fields }))
  }

  async function lookupCep(cepRaw: string) {
    const cep = cepRaw.replace(/\D/g, '')
    if (cep.length !== 8) return
    setCepLoading(true)
    try {
      const res = await fetch(`/api/shipping/cep?cep=${cep}`)
      if (!res.ok) { toast.error('CEP não encontrado'); return }
      const data = await res.json()
      patch({
        cep,
        logradouro: data.street ?? recipient.logradouro,
        bairro: data.neighborhood ?? recipient.bairro,
        municipio: data.city ?? recipient.municipio,
        uf: data.state ?? recipient.uf,
        municipio_ibge: data.municipio_ibge ?? null,
        ibge_source: data.ibge_source ?? null,
      })
    } catch {
      toast.error('Erro ao consultar CEP')
    } finally {
      setCepLoading(false)
    }
  }

  async function handleSubmit() {
    if (deliveryMode === 'delivery' && (!recipient.logradouro || !recipient.numero || !recipient.cep || !recipient.bairro || !recipient.municipio || !recipient.uf)) {
      toast.error('Preencha o endereço de entrega completo.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/wholesale/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          items: items.map((i) => ({ variation_id: i.variationId, quantity: i.quantity })),
          delivery_mode: deliveryMode,
          delivery_recipient: deliveryMode === 'delivery' ? {
            nome: recipient.nome, cpf: recipient.cpf || null, cnpj: recipient.cnpj || null,
            telefone: recipient.telefone || null, cep: recipient.cep, logradouro: recipient.logradouro,
            numero: recipient.numero, complemento: recipient.complemento || null, bairro: recipient.bairro,
            municipio: recipient.municipio, uf: recipient.uf, municipio_ibge: recipient.municipio_ibge,
            ibge_source: recipient.ibge_source,
          } : null,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        if (json.unavailable_items?.length) {
          toast.error('Alguns itens não possuem mais a quantidade solicitada.', {
            description: `${json.unavailable_items.length} item(ns) precisam ser ajustados no carrinho.`,
          })
        } else {
          toast.error(typeof json.error === 'string' ? json.error : 'Falha ao concluir o pedido.')
        }
        return
      }
      clear()
      router.push(wholesaleHref(basePath, `/pedido/${json.sale_id}`))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid md:grid-cols-3 gap-8">
      <div className="md:col-span-2 space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-medium text-text-secondary">Entrega</p>
          <div className="grid grid-cols-2 gap-2">
            {(['pickup', 'delivery'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setDeliveryMode(mode)}
                className={`py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                  deliveryMode === mode ? 'bg-brand text-white border-brand' : 'bg-bg-card border-border text-text-secondary'
                }`}
              >
                {mode === 'pickup' ? '📦 Retirada' : '🚚 Entrega'}
              </button>
            ))}
          </div>
          {deliveryMode === 'delivery' && (
            <p className="text-xs text-text-muted">Frete a combinar com nosso time comercial após a confirmação do pedido.</p>
          )}
        </div>

        {deliveryMode === 'delivery' && (
          <div className="space-y-2.5 rounded-xl border border-border bg-bg-card p-4">
            <p className="text-sm font-semibold text-text-primary">Endereço de entrega</p>
            <div className="grid grid-cols-2 gap-2.5">
              <TextField label="Nome / Razão social *" value={recipient.nome} onChange={(v) => patch({ nome: v })} />
              <TextField label="Telefone" value={recipient.telefone} onChange={(v) => patch({ telefone: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <TextField label="CPF" value={recipient.cpf} onChange={(v) => patch({ cpf: v })} />
              <TextField label="CNPJ" value={recipient.cnpj} onChange={(v) => patch({ cnpj: v })} />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <TextField label="CEP *" value={recipient.cep} onChange={(v) => patch({ cep: v.replace(/\D/g, '').slice(0, 8) })} onBlur={() => lookupCep(recipient.cep)} suffix={cepLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined} />
              <TextField label="Número *" value={recipient.numero} onChange={(v) => patch({ numero: v })} />
            </div>
            <TextField label="Logradouro *" value={recipient.logradouro} onChange={(v) => patch({ logradouro: v })} />
            <TextField label="Complemento" value={recipient.complemento} onChange={(v) => patch({ complemento: v })} />
            <div className="grid grid-cols-3 gap-2.5">
              <div className="col-span-2"><TextField label="Município *" value={recipient.municipio} onChange={(v) => patch({ municipio: v })} /></div>
              <TextField label="UF *" value={recipient.uf} onChange={(v) => patch({ uf: v.toUpperCase() })} />
            </div>
            <TextField label="Bairro *" value={recipient.bairro} onChange={(v) => patch({ bairro: v })} />
          </div>
        )}

        <div className="rounded-xl border border-border bg-bg-card p-4 space-y-2 text-sm">
          <p className="font-semibold text-text-primary">Pagamento</p>
          <p className="text-text-muted">Pagamento combinado com nosso time comercial após a confirmação do pedido — nenhuma cobrança é feita neste momento.</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-bg-card p-4 space-y-3">
          <p className="text-sm font-semibold text-text-primary">Resumo</p>
          {items.map((i) => (
            <div key={i.variationId} className="flex justify-between text-xs text-text-secondary">
              <span className="truncate pr-2">{i.quantity}× {i.productName}</span>
              <span className="tabular-nums shrink-0">{formatCurrency(i.quantity * i.displayPrice)}</span>
            </div>
          ))}
          <div className="border-t border-border pt-2 flex justify-between text-sm font-semibold text-text-primary">
            <span>Total estimado</span>
            <span>{formatCurrency(totalDisplayValue)}</span>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting || items.length === 0}
            className="w-full py-2.5 rounded-lg bg-brand text-white font-medium hover:bg-brand-dark transition-colors disabled:opacity-50"
          >
            {submitting ? 'Enviando...' : 'Confirmar pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TextField({ label, value, onChange, onBlur, suffix }: { label: string; value: string; onChange: (v: string) => void; onBlur?: () => void; suffix?: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs font-medium text-text-secondary block mb-1">{label}</label>
      <div className="relative">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="w-full rounded-lg border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
        />
        {suffix && <div className="absolute right-2.5 top-1/2 -translate-y-1/2">{suffix}</div>}
      </div>
    </div>
  )
}
