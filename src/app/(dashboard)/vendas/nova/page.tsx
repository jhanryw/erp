'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import {
  Plus, Trash2, Search, ShoppingCart, Check, ChevronRight, X,
  UserSearch, UserPlus, User,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { saleSchema, type SaleFormData, type PaymentEntry } from '@/lib/validators'
import { formatCurrency } from '@/lib/utils/currency'
import { useDebounce } from '@/hooks/useDebounce'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProductSearchInput } from '@/components/vendas/ProductSearchInput'
import type { ProductSearchItem } from '@/components/vendas/ProductSearchInput'
import { SellerPicker } from '@/components/vendas/SellerPicker'
import { Select } from '@/components/ui/select'
import { AuthorizationModal } from '@/components/auth/AuthorizationModal'

const STEPS = ['Itens', 'Cliente', 'Pagamento', 'Confirmar']

type PaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card'
type CustomerMode = 'search' | 'create' | 'anonymous'

const METHOD_LABELS: Record<string, string> = {
  pix:         'PIX',
  cash:        'Dinheiro',
  credit_card: 'Crédito',
  debit_card:  'Débito',
  cashback:    'Crédito de Troca',
}

export default function NovaVendaPage() {
  const [step, setStep] = useState(0)

  // ── Produto ──────────────────────────────────────────────────────────────────
  const [productNames, setProductNames] = useState<Record<number, string>>({})
  const [productMeta, setProductMeta]   = useState<Record<number, { sku: string; cor?: string; tamanho?: string; stock: number }>>({})

  // ── Cliente ──────────────────────────────────────────────────────────────────
  const [customerSearch, setCustomerSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<{
    id: number; name: string; cpf?: string | null; phone?: string | null
  } | null>(null)
  const [cashbackBalance, setCashbackBalance] = useState(0)
  const [customerMode, setCustomerMode] = useState<CustomerMode>('search')
  const [anonymousCustomerId, setAnonymousCustomerId] = useState<number | null>(null)
  // Criar cliente inline
  const [newName, setNewName]             = useState('')
  const [newPhone, setNewPhone]           = useState('')
  const [newCpf, setNewCpf]               = useState('')
  const [newBirthDate, setNewBirthDate]   = useState('')
  const [creatingCustomer, setCreatingCustomer] = useState(false)

  // ── Desconto vinculado R$ ↔ % ────────────────────────────────────────────────
  const [discountRaw, setDiscountRaw] = useState('')   // string no campo R$
  const [discountPct, setDiscountPct] = useState('')   // string no campo %

  // ── Vendedor responsável ─────────────────────────────────────────────────────
  const [responsibleSellerId, setResponsibleSellerId] = useState<number | null>(null)
  const [sellerBlockedError, setSellerBlockedError] = useState<string | null>(null)
  const [isLockedRole, setIsLockedRole] = useState(false)

  // ── Autorização de desconto ──────────────────────────────────────────────────
  const [showDiscountAuthModal, setShowDiscountAuthModal]         = useState(false)
  const [discountAuthTokenId, setDiscountAuthTokenId]             = useState<string | null>(null)
  const [authorizedAtDiscountAmount, setAuthorizedAtDiscountAmount] = useState<number | null>(null)

  // ── Caixa ────────────────────────────────────────────────────────────────────
  const [cashSession, setCashSession] = useState<{ id: number; opened_at: string } | null | undefined>(undefined)

  // ── Multi-pagamento ──────────────────────────────────────────────────────────
  const [payments, setPayments]               = useState<PaymentEntry[]>([])
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [draftMethod, setDraftMethod]         = useState<PaymentMethod>('pix')
  const [draftNetAmount, setDraftNetAmount]   = useState('')
  const [draftTendered, setDraftTendered]     = useState('')
  const [draftChangeMethod, setDraftChangeMethod] = useState<'cash' | 'pix'>('cash')
  const [draftInstallments, setDraftInstallments] = useState(1)
  const [draftCardBrand, setDraftCardBrand]   = useState('')
  const [draftAcquirer, setDraftAcquirer]     = useState('')

  const router      = useRouter()
  const submitting  = useRef(false)
  const supabase    = createClient()

  const debouncedCustomer = useDebounce(customerSearch, 300)

  // ── Inicialização ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/caixa')
      .then((r) => r.json())
      .then((j) => setCashSession(j.session ?? null))
      .catch(() => setCashSession(null))
  }, [])

  useEffect(() => {
    ;(supabase as any)
      .from('customers')
      .select('id')
      .eq('is_anonymous', true)
      .maybeSingle()
      .then(({ data }: { data: { id: number } | null }) => { if (data) setAnonymousCustomerId(data.id) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Form ─────────────────────────────────────────────────────────────────────
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SaleFormData>({
    resolver: zodResolver(saleSchema),
    defaultValues: {
      items: [],
      cashback_action:  'accumulate',
      discount_amount:  0,
      surcharge_amount: 0,
      cashback_used:    0,
      shipping_charged: 0,
      delivery_mode:    'delivery',
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  // ── Queries ──────────────────────────────────────────────────────────────────
  const { data: customers = [] } = useQuery({
    queryKey: ['customers-search', debouncedCustomer],
    queryFn: async () => {
      if (!debouncedCustomer) return []
      const { data } = await supabase
        .from('customers')
        .select('id, name, cpf, phone')
        .eq('is_anonymous', false)
        .or(`name.ilike.%${debouncedCustomer}%,cpf.ilike.%${debouncedCustomer}%,phone.ilike.%${debouncedCustomer}%`)
        .limit(5)
      return data ?? []
    },
    enabled: (debouncedCustomer?.length ?? 0) >= 2,
  })


  // ── Handlers: cliente ─────────────────────────────────────────────────────────
  async function selectCustomer(customer: any) {
    setSelectedCustomer(customer)
    setValue('customer_id', customer.id)
    setCustomerSearch(customer.name ?? '')

    const { data } = await supabase
      .from('v_cashback_balance')
      .select('available_balance')
      .eq('customer_id', customer.id)
      .maybeSingle() as unknown as { data: { available_balance: number } | null; error: any }
    setCashbackBalance(data?.available_balance ?? 0)
  }

  function selectAnonymous() {
    if (!anonymousCustomerId) {
      toast.error('Cliente avulso não configurado no sistema')
      return
    }
    setSelectedCustomer({ id: anonymousCustomerId, name: 'Cliente Avulso' })
    setValue('customer_id', anonymousCustomerId)
    setCashbackBalance(0)
    setValue('cashback_action', 'accumulate')
    setValue('cashback_used', 0)
  }

  async function createAndSelectCustomer() {
    const cpfClean = newCpf.replace(/\D/g, '')
    if (newName.trim().length < 2)  { toast.error('Nome deve ter ao menos 2 caracteres'); return }
    if (!newPhone.trim())            { toast.error('Telefone obrigatório'); return }
    if (cpfClean.length !== 11)     { toast.error('CPF inválido — informe 11 dígitos'); return }
    if (!newBirthDate)               { toast.error('Data de nascimento obrigatória'); return }

    setCreatingCustomer(true)
    try {
      const res = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), phone: newPhone.trim(), cpf: cpfClean, birth_date: newBirthDate }),
      })
      const json = await res.json()
      if (!res.ok) {
        const msg = typeof json.error === 'string'
          ? json.error
          : JSON.stringify(json.error?.formErrors ?? json.error ?? 'Erro desconhecido')
        toast.error('Erro ao criar cliente', { description: msg })
        return
      }
      await selectCustomer(json.customer)
      toast.success(`Cliente "${json.customer.name}" criado!`)
    } catch {
      toast.error('Erro ao criar cliente')
    } finally {
      setCreatingCustomer(false)
    }
  }

  function clearCustomer() {
    setSelectedCustomer(null)
    setCustomerSearch('')
    setCashbackBalance(0)
    setValue('customer_id', 0)
    setValue('cashback_action', 'accumulate')
    setValue('cashback_used', 0)
  }

  // ── Handlers: produto ─────────────────────────────────────────────────────────
  function addProduct(item: ProductSearchItem) {
    // Persist metadata (idempotent — safe to run even on duplicate)
    setProductNames((prev) => ({ ...prev, [item.variation_id]: item.product_name }))
    setProductMeta((prev) => ({
      ...prev,
      [item.variation_id]: {
        sku: item.sku,
        cor: item.cor ?? undefined,
        tamanho: item.tamanho ?? undefined,
        stock: item.stock,
      },
    }))

    // Check if this variation is already in the cart
    const existingIndex = items.findIndex((it) => it.product_variation_id === item.variation_id)
    if (existingIndex !== -1) {
      const currentQty = items[existingIndex].quantity ?? 1
      if (currentQty >= item.stock) {
        toast.warning(`Estoque máximo atingido para ${item.product_name} (${item.stock} un.)`)
        return
      }
      setValue(`items.${existingIndex}.quantity`, currentQty + 1)
      return
    }

    append({
      product_variation_id: item.variation_id,
      quantity:        1,
      unit_price:      item.price,
      unit_cost:       item.cost,
      discount_amount: 0,
      total_price:     item.price,
    })
  }

  // ── Handlers: desconto R$ ↔ % ────────────────────────────────────────────────
  function handleDiscountAmountChange(value: string) {
    setDiscountRaw(value)
    const amount = parseFloat(value) || 0
    setValue('discount_amount', amount)
    if (subtotal > 0 && amount > 0) {
      setDiscountPct(((amount / subtotal) * 100).toFixed(1))
    } else {
      setDiscountPct('')
    }
  }

  function handleDiscountPctChange(value: string) {
    setDiscountPct(value)
    const pct    = parseFloat(value) || 0
    const amount = Math.round((pct / 100) * subtotal * 100) / 100
    setValue('discount_amount', amount)
    setDiscountRaw(amount > 0 ? amount.toFixed(2) : '')
  }

  // ── Valores derivados ─────────────────────────────────────────────────────────
  const items           = watch('items')
  const discountAmount  = watch('discount_amount')  ?? 0
  const surchargeAmount = watch('surcharge_amount') ?? 0
  const cashbackUsed    = watch('cashback_used')    ?? 0
  const shippingCharged = watch('shipping_charged') ?? 0
  const deliveryMode    = watch('delivery_mode')
  const cashbackAction  = watch('cashback_action')  ?? 'accumulate'
  const saleOrigin      = watch('sale_origin')

  const subtotal            = items.reduce((s, item) => s + item.unit_price * item.quantity - item.discount_amount, 0)
  const currentDiscountPct  = subtotal > 0 && discountAmount > 0 ? (discountAmount / subtotal) * 100 : 0
  const gross               = Math.max(0, subtotal - discountAmount + shippingCharged + surchargeAmount)
  const total    = Math.max(0, gross - cashbackUsed)

  // Invalida o token de desconto se o valor mudar depois da autorização
  useEffect(() => {
    if (discountAuthTokenId !== null && authorizedAtDiscountAmount !== null) {
      if (Math.abs(discountAmount - authorizedAtDiscountAmount) > 0.01) {
        setDiscountAuthTokenId(null)
        setAuthorizedAtDiscountAmount(null)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discountAmount])

  // Quando o crédito cobre 100% do valor, limpa pagamentos já adicionados
  // (evita que o RPC receba payments[sum=X] com total=0 e rejeite por divergência)
  useEffect(() => {
    if (total <= 0.009 && cashbackUsed > 0) {
      setPayments(prev => prev.length > 0 ? [] : prev)
    }
  }, [total, cashbackUsed])

  const totalPaid     = payments.reduce((s, p) => s + p.net_amount, 0)
  const saldoRestante = total - totalPaid
  // Pode finalizar se: (a) pagamentos cobrem o total, OU
  // (b) total é zero porque foi 100% coberto por crédito/cashback
  const canFinalize   = total <= 0.009
    ? cashbackUsed > 0
    : payments.length > 0 && Math.abs(saldoRestante) < 0.01

  const draftNet    = parseFloat(draftNetAmount) || 0
  const draftTend   = parseFloat(draftTendered)  || 0
  const draftChange = draftMethod === 'cash' && draftTend > draftNet && draftNet > 0
    ? Math.round((draftTend - draftNet) * 100) / 100
    : 0

  // ── Handlers: pagamento ───────────────────────────────────────────────────────
  function openPaymentForm() {
    setDraftNetAmount(saldoRestante > 0 ? saldoRestante.toFixed(2) : '')
    setDraftTendered(saldoRestante > 0 ? saldoRestante.toFixed(2) : '')
    setDraftMethod('pix')
    setDraftInstallments(1)
    setDraftCardBrand('')
    setDraftAcquirer('')
    setDraftChangeMethod('cash')
    setShowPaymentForm(true)
  }

  function addPayment() {
    if (draftNet <= 0) { toast.error('Informe um valor maior que zero'); return }
    if (totalPaid + draftNet > total + 0.01) {
      toast.error('Pagamento excede o valor total da venda', {
        description: `Saldo restante: ${formatCurrency(saldoRestante)}`,
      })
      return
    }
    if (draftMethod === 'cash') {
      if (draftTend < draftNet) { toast.error('Valor entregue deve ser ≥ valor recebido'); return }
      if (draftChange > 0 && !draftChangeMethod) { toast.error('Informe a forma do troco'); return }
    }

    const entry: PaymentEntry = {
      method:          draftMethod,
      amount_tendered: draftMethod === 'cash' ? (draftTend > 0 ? draftTend : draftNet) : draftNet,
      change_amount:   draftChange,
      change_method:   draftChange > 0 ? draftChangeMethod : undefined,
      net_amount:      draftNet,
      installments:    draftInstallments,
      card_brand:      draftCardBrand || undefined,
      acquirer:        draftAcquirer  || undefined,
      metadata:        {},
    }
    setPayments((prev) => [...prev, entry])
    setShowPaymentForm(false)
  }

  function removePayment(idx: number) {
    setPayments((prev) => prev.filter((_, i) => i !== idx))
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  async function onSubmit(data: SaleFormData) {
    if (submitting.current) return
    if (!canFinalize) {
      toast.error('Pagamentos incompletos', {
        description: `Falta ${formatCurrency(saldoRestante)} para totalizar a venda.`,
      })
      return
    }
    submitting.current = true
    // Quando crédito cobre 100%: envia payments:[] (array vazio)
    // O RPC aceita [] quando total=0 — não insere sale_payments zerado
    const paymentsToSend = total <= 0.009 ? [] : payments
    const dominant = paymentsToSend.length > 0
      ? paymentsToSend.reduce((a, b) => b.net_amount > a.net_amount ? b : a)
      : { method: 'pix' }  // placeholder — total=0, método não importa

    if (!responsibleSellerId) {
      submitting.current = false
      toast.error('Selecione o vendedor responsável antes de confirmar a venda.')
      return
    }

    try {
      const res = await fetch('/api/vendas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          payment_method:                  dominant.method,
          payments:                        paymentsToSend,
          cash_session_id:                 cashSession ? cashSession.id : null,
          responsible_seller_id:           responsibleSellerId,
          discount_authorization_token_id: discountAuthTokenId ?? undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        submitting.current = false
        // json.error pode ser objeto Zod — serializar para evitar React error #31
        const errMsg = typeof json.error === 'string'
          ? json.error
          : (json.error?.formErrors?.[0] ?? JSON.stringify(json.error) ?? 'Erro desconhecido')
        toast.error('Erro ao registrar venda', { description: errMsg })
        return
      }
      toast.success('Venda registrada!', {
        description: `Pedido ${json.sale.sale_number} criado com sucesso.`,
      })
      router.push(`/vendas/${json.sale.id}`)
    } catch (err) {
      submitting.current = false
      toast.error('Erro inesperado', {
        description: err instanceof Error ? err.message : 'Verifique o console para detalhes.',
      })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl mx-auto space-y-5 pb-36 lg:pb-0">

      {/* ── Stepper ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => { if (i < step) setStep(i) }}
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors flex-shrink-0 ${
                i < step
                  ? 'bg-success text-white cursor-pointer hover:opacity-80'
                  : i === step
                  ? 'bg-brand text-white cursor-default'
                  : 'bg-bg-overlay text-text-muted cursor-default'
              }`}
            >
              {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </button>
            <span className={`text-sm hidden sm:inline ${i === step ? 'text-text-primary font-medium' : 'text-text-muted'}`}>
              {s}
            </span>
            {i === step && (
              <span className="text-sm font-medium text-text-primary sm:hidden">{s}</span>
            )}
            {i < STEPS.length - 1 && (
              <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
            )}
          </div>
        ))}
      </div>

      <form id="sale-form" onSubmit={handleSubmit(onSubmit)}>

        {/* ── Sticky bar mobile ──────────────────────────────────── */}
        <div className="lg:hidden fixed bottom-16 left-0 right-0 z-20 bg-bg-elevated/95 backdrop-blur-md border-t border-border shadow-elevated">
          {step === 3 ? (
            <div className="p-3">
              <Button
                type="submit"
                form="sale-form"
                loading={isSubmitting}
                disabled={!canFinalize}
                className="w-full h-12 text-base font-semibold"
              >
                <ShoppingCart className="w-5 h-5" />
                Confirmar Venda · {formatCurrency(total)}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-[11px] text-text-muted leading-none mb-0.5">
                  {fields.length === 0 ? 'Nenhum item' : `${fields.length} item${fields.length !== 1 ? 's' : ''}`}
                </p>
                <p className="text-xl font-bold text-text-primary tabular-nums">{formatCurrency(total)}</p>
              </div>
              {step === 2 && canFinalize && (
                <Button type="button" size="lg" onClick={() => setStep(3)}>
                  Próximo
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">

            {/* ════════════════════════════════════════
                STEP 0 — ITENS
            ════════════════════════════════════════ */}
            {step === 0 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Adicionar Itens</h3>

                {/* Vendedor responsável */}
                {sellerBlockedError ? (
                  <div className="rounded-lg bg-error/10 border border-error/30 p-3 text-sm text-error">
                    {sellerBlockedError}
                  </div>
                ) : (
                  <SellerPicker
                    value={responsibleSellerId}
                    onChange={setResponsibleSellerId}
                    onBlockedError={setSellerBlockedError}
                    onLockedChange={setIsLockedRole}
                  />
                )}

                {/* Modo de entrega */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-text-secondary">Modo de Entrega</p>
                  <div className="flex gap-3">
                    {[
                      { value: 'delivery', label: '🚚 Envio' },
                      { value: 'pickup',   label: '📦 Retirada' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setValue('delivery_mode', value as 'pickup' | 'delivery')}
                        className={`flex-1 py-3 rounded-lg border text-sm font-medium transition-colors ${
                          deliveryMode === value
                            ? 'bg-brand text-white border-brand'
                            : 'bg-bg-overlay text-text-secondary border-border hover:border-brand/50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Banner caixa fechado */}
                {deliveryMode === 'pickup' && cashSession === null && (
                  <div className="rounded-xl bg-warning/10 border border-warning/40 p-4 space-y-1">
                    <p className="text-sm font-semibold text-warning">Nenhum caixa aberto</p>
                    <p className="text-xs text-text-secondary">
                      Vendas de retirada exigem um caixa aberto.{' '}
                      <a href="/caixa" className="underline font-medium text-warning hover:text-warning/80">
                        Abrir caixa
                      </a>
                    </p>
                  </div>
                )}

                {/* Busca de produto */}
                <div>
                  <label className="label-base mb-1 block">Buscar produto por nome ou SKU</label>
                  <ProductSearchInput onSelect={addProduct} />
                </div>

                {/* Lista de itens */}
                {fields.length === 0 ? (
                  <div className="py-10 text-center text-sm text-text-muted">
                    <Plus className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    Nenhum item adicionado
                  </div>
                ) : (
                  <div className="space-y-2">
                    {fields.map((field, i) => {
                      const varId    = items[i]?.product_variation_id
                      const name     = productNames[varId] ?? `Variação #${varId}`
                      const meta     = productMeta[varId]
                      const qty      = items[i]?.quantity ?? 1
                      const price    = items[i]?.unit_price ?? 0
                      const maxStock = meta?.stock ?? Infinity
                      const atLimit  = qty >= maxStock
                      return (
                        <div key={field.id} className="p-3.5 rounded-xl bg-bg-overlay space-y-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-text-primary leading-snug truncate">{name}</p>
                              {meta && (
                                <p className="text-xs text-text-muted mt-0.5 flex flex-wrap gap-x-2">
                                  {meta.tamanho && <span>Tam: <span className="font-medium text-text-secondary">{meta.tamanho}</span></span>}
                                  {meta.cor     && <span>Cor: <span className="font-medium text-text-secondary">{meta.cor}</span></span>}
                                  {meta.sku     && <span className="font-mono">{meta.sku}</span>}
                                </p>
                              )}
                              <p className="text-xs text-text-muted mt-0.5">{formatCurrency(price)} / unidade</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => remove(i)}
                              className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors flex-shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => { if (qty > 1) setValue(`items.${i}.quantity`, qty - 1) }}
                                className="w-11 h-11 rounded-xl bg-bg-hover flex items-center justify-center text-xl font-bold hover:bg-bg-active touch-manipulation"
                              >−</button>
                              <span className="text-base font-bold w-8 text-center tabular-nums">{qty}</span>
                              <button
                                type="button"
                                disabled={atLimit}
                                onClick={() => {
                                  if (atLimit) {
                                    toast.warning(`Estoque máximo: ${maxStock} un.`)
                                    return
                                  }
                                  setValue(`items.${i}.quantity`, qty + 1)
                                }}
                                className="w-11 h-11 rounded-xl bg-bg-hover flex items-center justify-center text-xl font-bold hover:bg-bg-active touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed"
                              >+</button>
                            </div>
                            <p className="text-base font-bold tabular-nums">{formatCurrency(price * qty)}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* ── Origem da venda ──────────────────────────────── */}
                <Controller
                  control={control}
                  name="sale_origin"
                  render={({ field, fieldState }) => (
                    <Select
                      label="Origem da Venda *"
                      {...field}
                      value={field.value ?? ''}
                      error={fieldState.error?.message}
                    >
                      <option value="">Selecione a origem…</option>
                      <option value="instagram">Instagram</option>
                      <option value="referral">Indicação</option>
                      <option value="paid_traffic">Tráfego Pago</option>
                      <option value="website">Site</option>
                      <option value="store">Loja Física</option>
                      <option value="other">Outro</option>
                    </Select>
                  )}
                />

                <Button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={
                    !!sellerBlockedError ||
                    !responsibleSellerId ||
                    fields.length === 0 ||
                    !saleOrigin ||
                    (deliveryMode === 'pickup' && cashSession === null)
                  }
                  className="w-full h-11"
                >
                  Continuar
                </Button>
              </div>
            )}

            {/* ════════════════════════════════════════
                STEP 2 — PAGAMENTO
            ════════════════════════════════════════ */}
            {step === 2 && (
              <div className="card p-5 space-y-5">
                <h3 className="text-sm font-semibold text-text-primary">Pagamento e Resumo</h3>

                {/* ── Desconto: R$ + % vinculados ─────────────────── */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-text-secondary">Desconto</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Valor (R$)"
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={discountRaw}
                      onChange={(e) => handleDiscountAmountChange(e.target.value)}
                      placeholder="0,00"
                    />
                    <div className="relative">
                      <Input
                        label="Percentual (%)"
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        inputMode="decimal"
                        value={discountPct}
                        onChange={(e) => handleDiscountPctChange(e.target.value)}
                        placeholder="0,0"
                      />
                      {subtotal > 0 && discountAmount > 0 && (
                        <p className="text-[10px] text-text-muted mt-0.5">
                          = {formatCurrency(discountAmount)} sobre {formatCurrency(subtotal)}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* ── Frete + Acréscimo ─────────────────────────────── */}
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Frete (R$)"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    {...register('shipping_charged', { valueAsNumber: true })}
                  />
                  <Input
                    label="Acréscimo (R$)"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0,00"
                    inputMode="decimal"
                    {...register('surcharge_amount', { valueAsNumber: true })}
                  />
                </div>

                <Input label="Observações" placeholder="Opcional" {...register('notes')} />

                {/* ── Totalizador ──────────────────────────────────── */}
                <div className="rounded-xl bg-bg-overlay p-4 space-y-1.5">
                  {subtotal > 0 && (
                    <div className="flex justify-between text-sm text-text-secondary">
                      <span>Subtotal</span>
                      <span className="tabular-nums">{formatCurrency(subtotal)}</span>
                    </div>
                  )}
                  {discountAmount > 0 && (
                    <div className="flex justify-between text-sm text-success">
                      <span>Desconto</span>
                      <span className="tabular-nums">− {formatCurrency(discountAmount)}</span>
                    </div>
                  )}
                  {shippingCharged > 0 && (
                    <div className="flex justify-between text-sm text-text-secondary">
                      <span>Frete</span>
                      <span className="tabular-nums">+ {formatCurrency(shippingCharged)}</span>
                    </div>
                  )}
                  {surchargeAmount > 0 && (
                    <div className="flex justify-between text-sm text-warning">
                      <span>Acréscimo</span>
                      <span className="tabular-nums">+ {formatCurrency(surchargeAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold text-text-primary border-t border-border/50 pt-1.5 mt-1">
                    <span>Total</span>
                    <span className="text-lg tabular-nums">{formatCurrency(gross)}</span>
                  </div>
                </div>

                {/* ── Pagamentos registrados ───────────────────────── */}
                {payments.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-secondary">Pagamentos registrados</p>
                    {payments.map((p, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between p-3 rounded-lg bg-bg-overlay border border-border/50"
                      >
                        <div>
                          <p className="text-sm font-semibold text-text-primary">
                            {METHOD_LABELS[p.method]}
                            {p.installments && p.installments > 1 ? ` ${p.installments}×` : ''}
                            {p.card_brand ? ` · ${p.card_brand}` : ''}
                          </p>
                          <p className="text-xs text-text-muted">
                            {formatCurrency(p.net_amount)}
                            {p.change_amount > 0
                              ? ` · Troco: ${formatCurrency(p.change_amount)} (${p.change_method === 'pix' ? 'PIX' : 'dinheiro'})`
                              : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removePayment(idx)}
                          className="flex items-center justify-center w-8 h-8 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <div className={`flex justify-between text-sm font-bold pt-1 ${
                      canFinalize ? 'text-success' : saldoRestante < 0 ? 'text-error' : 'text-text-primary'
                    }`}>
                      <span>{canFinalize ? 'Venda quitada ✓' : saldoRestante < 0 ? 'Valor excedido' : 'Falta'}</span>
                      {!canFinalize && (
                        <span className="tabular-nums">{formatCurrency(Math.abs(saldoRestante))}</span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Formulário de novo pagamento ─────────────────── */}
                {showPaymentForm ? (
                  <div className="rounded-xl border border-brand/30 bg-brand/5 p-4 space-y-4">
                    <p className="text-sm font-semibold text-text-primary">Novo pagamento</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {(['pix', 'cash', 'credit_card', 'debit_card'] as PaymentMethod[]).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => { setDraftMethod(m); if (m !== 'credit_card') setDraftInstallments(1) }}
                          className={`py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                            draftMethod === m
                              ? 'bg-brand text-white border-brand'
                              : 'bg-bg-overlay border-border text-text-secondary hover:border-brand/50'
                          }`}
                        >
                          {METHOD_LABELS[m]}
                        </button>
                      ))}
                    </div>

                    <Input
                      label={draftMethod === 'cash' ? 'Valor cobrado (R$)' : 'Valor (R$)'}
                      type="number"
                      step="0.01"
                      min="0.01"
                      inputMode="decimal"
                      value={draftNetAmount}
                      onChange={(e) => {
                        setDraftNetAmount(e.target.value)
                        if (draftMethod !== 'cash') setDraftTendered(e.target.value)
                      }}
                    />

                    {draftMethod === 'cash' && (
                      <div className="space-y-3">
                        <Input
                          label="Valor entregue pelo cliente (R$)"
                          type="number"
                          step="0.01"
                          min={draftNetAmount || '0'}
                          inputMode="decimal"
                          value={draftTendered}
                          onChange={(e) => setDraftTendered(e.target.value)}
                        />
                        {draftChange > 0 && (
                          <div className="space-y-2">
                            <p className="text-sm text-text-secondary">
                              Troco: <span className="font-bold text-text-primary">{formatCurrency(draftChange)}</span>
                            </p>
                            <div className="flex gap-2">
                              {(['cash', 'pix'] as const).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => setDraftChangeMethod(m)}
                                  className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors touch-manipulation ${
                                    draftChangeMethod === m
                                      ? 'bg-brand text-white border-brand'
                                      : 'bg-bg-overlay border-border text-text-secondary hover:border-brand/50'
                                  }`}
                                >
                                  {m === 'cash' ? 'Dinheiro' : 'PIX'}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {draftMethod === 'credit_card' && (
                      <div className="space-y-1.5">
                        <p className="text-xs font-medium text-text-secondary">Parcelas</p>
                        <div className="flex gap-2 flex-wrap">
                          {[1, 2, 3, 4, 6, 12].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setDraftInstallments(n)}
                              className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors touch-manipulation ${
                                draftInstallments === n
                                  ? 'bg-brand text-white border-brand'
                                  : 'bg-bg-overlay border-border text-text-secondary hover:border-brand/50'
                              }`}
                            >
                              {n}×
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {(draftMethod === 'credit_card' || draftMethod === 'debit_card') && (
                      <div className="grid grid-cols-2 gap-3">
                        <Input label="Bandeira" placeholder="Visa, Mastercard..." value={draftCardBrand} onChange={(e) => setDraftCardBrand(e.target.value)} />
                        <Input label="Adquirente" placeholder="Stone, Cielo..." value={draftAcquirer} onChange={(e) => setDraftAcquirer(e.target.value)} />
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button type="button" variant="secondary" onClick={() => setShowPaymentForm(false)} className="flex-1">Cancelar</Button>
                      <Button type="button" onClick={addPayment} disabled={draftNet <= 0} className="flex-1">
                        <Plus className="w-4 h-4" />
                        Adicionar
                      </Button>
                    </div>
                  </div>
                ) : (
                  !canFinalize && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={openPaymentForm}
                      disabled={saldoRestante <= 0}
                      className="w-full"
                    >
                      <Plus className="w-4 h-4" />
                      Adicionar Pagamento{saldoRestante > 0 ? ` · ${formatCurrency(saldoRestante)}` : ''}
                    </Button>
                  )
                )}

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(1)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      if (isLockedRole && currentDiscountPct > 10 && !discountAuthTokenId) {
                        setShowDiscountAuthModal(true)
                        return
                      }
                      setStep(3)
                    }}
                    disabled={!canFinalize}
                    className="flex-1 h-11"
                  >
                    Continuar
                    {isLockedRole && currentDiscountPct > 10 && !discountAuthTokenId && (
                      <span className="ml-1 text-xs opacity-75">· requer autorização</span>
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* ════════════════════════════════════════
                STEP 1 — CLIENTE
            ════════════════════════════════════════ */}
            {step === 1 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Identificar Cliente</h3>

                {/* ── 3 modos ─────────────────────────────────────── */}
                {!selectedCustomer && (
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        { mode: 'search',    icon: <UserSearch className="w-4 h-4" />, label: 'Buscar' },
                        { mode: 'create',    icon: <UserPlus   className="w-4 h-4" />, label: 'Criar' },
                        { mode: 'anonymous', icon: <User       className="w-4 h-4" />, label: 'Avulso' },
                      ] as const
                    ).map(({ mode, icon, label }) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setCustomerMode(mode)}
                        className={`flex flex-col items-center gap-1.5 py-3 rounded-lg border text-sm font-medium transition-colors ${
                          customerMode === mode
                            ? 'bg-brand/10 border-brand text-brand'
                            : 'bg-bg-overlay border-border text-text-secondary hover:border-brand/40'
                        }`}
                      >
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>
                )}

                {/* ── Modo: buscar existente ───────────────────────── */}
                {!selectedCustomer && customerMode === 'search' && (
                  <div className="relative">
                    <Input
                      label="Buscar por nome, CPF ou telefone"
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      prefix={<Search className="w-4 h-4" />}
                      placeholder="Digite para buscar..."
                      autoComplete="off"
                    />
                    {customers.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-lg shadow-modal z-10 overflow-hidden">
                        {customers.map((c: any) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => selectCustomer(c)}
                            className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-bg-hover text-left transition-colors border-b border-border/50 last:border-0"
                          >
                            <div>
                              <p className="text-sm font-medium text-text-primary">{c.name}</p>
                              <p className="text-xs text-text-muted">{c.cpf}</p>
                            </div>
                            <span className="text-xs text-text-muted">{c.phone}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* ── Modo: criar novo ─────────────────────────────── */}
                {!selectedCustomer && customerMode === 'create' && (
                  <div className="space-y-3">
                    <Input
                      label="Nome *"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Nome completo"
                    />
                    <Input
                      label="Telefone *"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="(11) 99999-9999"
                      inputMode="tel"
                    />
                    <Input
                      label="CPF * (11 dígitos)"
                      value={newCpf}
                      onChange={(e) => setNewCpf(e.target.value)}
                      placeholder="000.000.000-00"
                      inputMode="numeric"
                    />
                    <Input
                      label="Data de Nascimento *"
                      type="date"
                      value={newBirthDate}
                      onChange={(e) => setNewBirthDate(e.target.value)}
                    />
                    <Button
                      type="button"
                      onClick={createAndSelectCustomer}
                      loading={creatingCustomer}
                      disabled={creatingCustomer}
                      className="w-full"
                    >
                      <UserPlus className="w-4 h-4" />
                      Criar e Usar Este Cliente
                    </Button>
                  </div>
                )}

                {/* ── Modo: avulso ──────────────────────────────────── */}
                {!selectedCustomer && customerMode === 'anonymous' && (
                  <div className="rounded-xl bg-bg-overlay border border-border p-4 space-y-3">
                    <p className="text-sm text-text-secondary">
                      Venda sem identificação de cliente. Não gera cashback e não aciona
                      automações de pós-venda (WhatsApp, e-mail, etc.).
                    </p>
                    <Button
                      type="button"
                      onClick={selectAnonymous}
                      className="w-full"
                      variant="secondary"
                    >
                      <User className="w-4 h-4" />
                      Usar Cliente Avulso
                    </Button>
                  </div>
                )}

                {/* ── Cliente selecionado ───────────────────────────── */}
                {selectedCustomer && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-lg bg-brand/10 border border-brand/20">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{selectedCustomer.name}</p>
                        {selectedCustomer.cpf && (
                          <p className="text-xs text-text-muted">{selectedCustomer.cpf}</p>
                        )}
                        {cashbackBalance > 0 && (
                          <p className="text-xs text-text-muted">
                            Cashback:{' '}
                            <span className="text-success font-semibold">{formatCurrency(cashbackBalance)}</span>
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={clearCustomer}
                        className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                      >
                        Trocar
                      </button>
                    </div>

                    {/* Cashback (só para clientes reais com saldo) */}
                    {cashbackBalance > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-text-secondary">
                          Cashback disponível:{' '}
                          <span className="text-success font-semibold">{formatCurrency(cashbackBalance)}</span>
                        </p>
                        <div className="flex gap-2">
                          {(
                            [
                              { value: 'accumulate', label: 'Acumular', desc: 'Gera crédito nesta compra' },
                              { value: 'use',        label: 'Usar saldo', desc: 'Aplica como desconto' },
                            ] as const
                          ).map(({ value, label, desc }) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => {
                                setValue('cashback_action', value)
                                if (value === 'accumulate') setValue('cashback_used', 0)
                              }}
                              className={`flex-1 p-3 rounded-lg border text-left text-sm transition-colors ${
                                cashbackAction === value
                                  ? 'bg-brand/10 border-brand'
                                  : 'bg-bg-overlay border-border hover:border-brand/40'
                              }`}
                            >
                              <p className={`font-semibold ${cashbackAction === value ? 'text-brand' : 'text-text-primary'}`}>
                                {label}
                              </p>
                              <p className="text-xs text-text-muted mt-0.5">{desc}</p>
                            </button>
                          ))}
                        </div>
                        {cashbackAction === 'use' && (
                          <Input
                            label={`Valor a usar (máx. ${formatCurrency(cashbackBalance)})`}
                            type="number"
                            step="0.01"
                            min="0"
                            max={cashbackBalance}
                            inputMode="decimal"
                            {...register('cashback_used', { valueAsNumber: true })}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(0)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={!selectedCustomer}
                    className="flex-1 h-11"
                  >
                    Continuar
                  </Button>
                </div>
              </div>
            )}

            {/* ════════════════════════════════════════
                STEP 3 — CONFIRMAR
            ════════════════════════════════════════ */}
            {step === 3 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Confirmar Venda</h3>

                <div className="space-y-0 divide-y divide-border/50 text-sm">
                  <div className="flex justify-between py-3">
                    <span className="text-text-secondary">Cliente</span>
                    <span className="font-medium">{selectedCustomer?.name}</span>
                  </div>
                  <div className="flex justify-between py-3">
                    <span className="text-text-secondary">Itens</span>
                    <span className="font-medium">{fields.length} produto(s)</span>
                  </div>
                  <div className="flex justify-between py-3">
                    <span className="text-text-secondary">Entrega</span>
                    <span className="font-medium">{deliveryMode === 'pickup' ? '📦 Retirada' : '🚚 Envio'}</span>
                  </div>
                  {subtotal > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Subtotal</span>
                      <span className="font-medium tabular-nums">{formatCurrency(subtotal)}</span>
                    </div>
                  )}
                  {discountAmount > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">
                        Desconto
                        {discountPct ? ` (${discountPct}%)` : ''}
                      </span>
                      <span className="font-medium text-success tabular-nums">− {formatCurrency(discountAmount)}</span>
                    </div>
                  )}
                  {shippingCharged > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Frete</span>
                      <span className="font-medium tabular-nums">+ {formatCurrency(shippingCharged)}</span>
                    </div>
                  )}
                  {surchargeAmount > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Acréscimo</span>
                      <span className="font-medium text-warning tabular-nums">+ {formatCurrency(surchargeAmount)}</span>
                    </div>
                  )}
                  {cashbackUsed > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Cashback usado</span>
                      <span className="font-medium text-success tabular-nums">− {formatCurrency(cashbackUsed)}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-3">
                    <span className="font-bold text-text-primary">Total a pagar</span>
                    <span className="text-xl font-bold tabular-nums">{formatCurrency(total)}</span>
                  </div>
                  {payments.length > 0 && (
                    <div className="py-3 space-y-1.5">
                      <p className="text-xs text-text-muted mb-2">Formas de pagamento</p>
                      {payments.map((p, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span className="text-text-secondary">
                            {METHOD_LABELS[p.method]}
                            {p.installments && p.installments > 1 ? ` ${p.installments}×` : ''}
                            {p.card_brand ? ` · ${p.card_brand}` : ''}
                          </span>
                          <span className="font-medium tabular-nums">{formatCurrency(p.net_amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {Object.keys(errors).length > 0 && (
                  <div className="rounded-lg bg-error/10 border border-error/30 p-3 text-xs text-error space-y-1">
                    <p className="font-semibold">Corrija os erros antes de continuar:</p>
                    {errors.customer_id     && <p>• Cliente: {errors.customer_id.message}</p>}
                    {errors.sale_origin     && <p>• Origem da venda: obrigatória — volte ao passo Itens e selecione.</p>}
                    {errors.items           && <p>• Itens: {typeof errors.items.message === 'string' ? errors.items.message : 'Verifique os itens'}</p>}
                    {errors.discount_amount && <p>• Desconto: {errors.discount_amount.message}</p>}
                    {!canFinalize           && <p>• Pagamentos: informe ao menos um pagamento que totalize o valor da venda.</p>}
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(2)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="submit"
                    loading={isSubmitting}
                    disabled={!canFinalize}
                    className="flex-1 h-11 hidden sm:flex"
                  >
                    <ShoppingCart className="w-4 h-4" />
                    Confirmar Venda
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Sidebar resumo (desktop only) ── */}
          <div className="hidden lg:block card p-5 h-fit sticky top-20">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Resumo</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-text-secondary">
                <span>Subtotal ({fields.length} itens)</span>
                <span className="tabular-nums">{formatCurrency(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-success">
                  <span>Desconto{discountPct ? ` (${discountPct}%)` : ''}</span>
                  <span className="tabular-nums">− {formatCurrency(discountAmount)}</span>
                </div>
              )}
              {shippingCharged > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Frete</span>
                  <span className="tabular-nums">+ {formatCurrency(shippingCharged)}</span>
                </div>
              )}
              {surchargeAmount > 0 && (
                <div className="flex justify-between text-warning">
                  <span>Acréscimo</span>
                  <span className="tabular-nums">+ {formatCurrency(surchargeAmount)}</span>
                </div>
              )}
              {cashbackUsed > 0 && (
                <div className="flex justify-between text-success">
                  <span>Cashback</span>
                  <span className="tabular-nums">− {formatCurrency(cashbackUsed)}</span>
                </div>
              )}
              <div className="flex justify-between text-text-secondary border-t border-border pt-2 mt-2 text-xs">
                <span>{deliveryMode === 'pickup' ? '📦 Retirada' : '🚚 Envio'}</span>
              </div>
              <div className="flex justify-between font-bold text-text-primary">
                <span>Total</span>
                <span className="text-lg tabular-nums">{formatCurrency(total)}</span>
              </div>

              {step >= 1 && selectedCustomer && (
                <div className="flex justify-between text-xs text-text-muted border-t border-border pt-2">
                  <span>Cliente</span>
                  <span className="font-medium text-text-secondary truncate max-w-[120px]">{selectedCustomer.name}</span>
                </div>
              )}

              {step >= 2 && (
                <div className={`flex justify-between text-sm font-medium border-t border-border pt-2 ${
                  canFinalize ? 'text-success' : 'text-text-muted'
                }`}>
                  <span>{canFinalize ? 'Quitado' : 'Falta'}</span>
                  <span className="tabular-nums">
                    {canFinalize ? '✓' : formatCurrency(saldoRestante)}
                  </span>
                </div>
              )}

              {step === 3 && (
                <Button
                  type="submit"
                  form="sale-form"
                  loading={isSubmitting}
                  disabled={!canFinalize}
                  className="w-full mt-2"
                >
                  <ShoppingCart className="w-4 h-4" />
                  Confirmar Venda
                </Button>
              )}
            </div>
          </div>
        </div>
      </form>

      <AuthorizationModal
        open={showDiscountAuthModal}
        action="approve_discount"
        title="Autorização necessária"
        description={`Desconto de ${currentDiscountPct.toFixed(1)}% requer aprovação de gerente (limite: 10%).`}
        resourceType="sale"
        discountPct={currentDiscountPct}
        discountAmount={discountAmount}
        onAuthorized={(tokenId) => {
          setDiscountAuthTokenId(tokenId)
          setAuthorizedAtDiscountAmount(discountAmount)
          setShowDiscountAuthModal(false)
          setStep(3)
        }}
        onCancel={() => setShowDiscountAuthModal(false)}
      />
    </div>
  )
}
