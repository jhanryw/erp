'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Plus, Trash2, Search, ShoppingCart, Check, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { saleSchema, type SaleFormData } from '@/lib/validators'
import { formatCurrency } from '@/lib/utils/currency'
import { useDebounce } from '@/hooks/useDebounce'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

const STEPS = ['Cliente', 'Itens', 'Pagamento', 'Confirmar']

export default function NovaVendaPage() {
  const [step, setStep] = useState(0)
  const [customerSearch, setCustomerSearch] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [cashbackBalance, setCashbackBalance] = useState(0)
  // Guarda nome exibível por variation_id para mostrar na lista de itens
  const [productNames, setProductNames] = useState<Record<number, string>>({})
  const router = useRouter()
  const supabase = createClient()

  const debouncedCustomer = useDebounce(customerSearch, 300)
  const debouncedProduct  = useDebounce(productSearch, 300)

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
      payment_method: 'pix' as const,
      cashback_action: 'accumulate' as const,
      discount_amount: 0,
      surcharge_amount: 0,
      cashback_used: 0,
      shipping_charged: 0,
      delivery_mode: 'delivery',
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  // Busca de clientes
  const { data: customers = [] } = useQuery({
    queryKey: ['customers-search', debouncedCustomer],
    queryFn: async () => {
      if (!debouncedCustomer) return []
      const { data } = await supabase
        .from('customers')
        .select('id, name, cpf, phone')
        .or(`name.ilike.%${debouncedCustomer}%,cpf.ilike.%${debouncedCustomer}%,phone.ilike.%${debouncedCustomer}%`)
        .limit(5)
      return data ?? []
    },
    enabled: debouncedCustomer.length >= 2,
  })

  // Busca de produtos/variações
  const { data: products = [] } = useQuery({
    queryKey: ['products-search', debouncedProduct],
    queryFn: async () => {
      if (!debouncedProduct) return []

      const { data: matchingProducts } = await supabase
        .from('products')
        .select('id')
        .ilike('name', `%${debouncedProduct}%`)
        .limit(15)
      const productIds = (matchingProducts ?? []).map((p: any) => p.id)

      let query = supabase
        .from('product_variations')
        .select(`
          id, sku_variation, price_override, cost_override,
          products:product_id (id, name, sku, base_price, base_cost),
          stock(quantity)
        `)
        .limit(20)

      if (productIds.length > 0) {
        query = query.or(`sku_variation.ilike.%${debouncedProduct}%,product_id.in.(${productIds.join(',')})`)
      } else {
        query = query.ilike('sku_variation', `%${debouncedProduct}%`)
      }

      const { data } = await query

      return (data ?? []).filter((v: any) => {
        const qty = Array.isArray(v.stock)
          ? (v.stock[0]?.quantity ?? 0)
          : (v.stock?.quantity ?? 0)
        return qty > 0
      }).slice(0, 8)
    },
    enabled: debouncedProduct.length >= 2,
  })

  async function selectCustomer(customer: any) {
    setSelectedCustomer(customer)
    setValue('customer_id', customer.id)
    setCustomerSearch(customer.name)

    const { data } = await supabase
      .from('v_cashback_balance')
      .select('available_balance')
      .eq('customer_id', customer.id)
      .maybeSingle() as unknown as { data: { available_balance: number } | null; error: any }
    setCashbackBalance(data?.available_balance ?? 0)
  }

  function addProduct(variation: any) {
    const product = variation.products
    const price = variation.price_override ?? product.base_price
    const cost  = variation.cost_override  ?? product.base_cost
    // Guarda nome para exibição na lista
    setProductNames((prev) => ({
      ...prev,
      [variation.id]: product?.name ?? `Variação #${variation.id}`,
    }))
    append({
      product_variation_id: variation.id,
      quantity: 1,
      unit_price: price,
      unit_cost: cost,
      discount_amount: 0,
      total_price: price,
    })
    setProductSearch('')
  }

  const items          = watch('items')
  const discountAmount = watch('discount_amount')  ?? 0
  const surchargeAmount= watch('surcharge_amount') ?? 0
  const cashbackUsed   = watch('cashback_used')    ?? 0
  const shippingCharged= watch('shipping_charged') ?? 0
  const deliveryMode   = watch('delivery_mode')
  const cashbackAction = watch('cashback_action')  ?? 'accumulate'

  const subtotal = items.reduce((s, item) => s + item.unit_price * item.quantity - item.discount_amount, 0)
  const gross    = Math.max(0, subtotal - discountAmount + shippingCharged + surchargeAmount)
  const total    = Math.max(0, gross - cashbackUsed)

  async function onSubmit(data: SaleFormData) {
    try {
      const res = await fetch('/api/vendas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao registrar venda', { description: json.error ?? 'Erro desconhecido' })
        return
      }
      toast.success('Venda registrada!', {
        description: `Pedido ${json.sale.sale_number} criado com sucesso.`,
      })
      router.push(`/vendas/${json.sale.id}`)
    } catch (err) {
      console.error('[onSubmit] erro inesperado:', err)
      toast.error('Erro inesperado ao registrar venda', {
        description: err instanceof Error ? err.message : 'Verifique o console para detalhes.',
      })
    }
  }

  return (
    /* pb-36 no mobile: 64px tab bar + ~80px sticky bar */
    <div className="max-w-4xl mx-auto space-y-5 pb-36 lg:pb-0">

      {/* ── Stepper ─────────────────────────────────────────────
          Mobile: ícone + rótulo só da etapa ativa
          Desktop: tudo visível                                  */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5 sm:gap-2">
            <div
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-colors flex-shrink-0 ${
                i < step
                  ? 'bg-success text-white'
                  : i === step
                  ? 'bg-brand text-white'
                  : 'bg-bg-overlay text-text-muted'
              }`}
            >
              {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </div>
            {/* Desktop: sempre visível / Mobile: só a etapa ativa */}
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

        {/* ── Sticky bar mobile (acima do bottom tab bar) ──────
            Mostra total nas etapas 0-2 e botão Confirmar na 3  */}
        <div className="lg:hidden fixed bottom-16 left-0 right-0 z-20 bg-bg-elevated/95 backdrop-blur-md border-t border-border shadow-elevated">
          {step === 3 ? (
            <div className="p-3">
              <Button
                type="submit"
                form="sale-form"
                loading={isSubmitting}
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
                  {fields.length === 0
                    ? 'Nenhum item'
                    : `${fields.length} item${fields.length !== 1 ? 's' : ''}`}
                </p>
                <p className="text-xl font-bold text-text-primary tabular-nums">
                  {formatCurrency(total)}
                </p>
              </div>
              {step === 2 && (
                <Button
                  type="button"
                  size="lg"
                  onClick={() => setStep(3)}
                  disabled={fields.length === 0}
                >
                  Revisar
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ── Área de conteúdo ── */}
          <div className="lg:col-span-2 space-y-4">

            {/* Step 1: Cliente */}
            {step === 0 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Selecionar Cliente</h3>
                <div className="relative">
                  <Input
                    label="Buscar por nome, CPF ou telefone"
                    value={customerSearch}
                    onChange={(e) => setCustomerSearch(e.target.value)}
                    prefix={<Search className="w-4 h-4" />}
                    placeholder="Digite para buscar..."
                    autoComplete="off"
                    inputMode="text"
                  />
                  {customers.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-lg shadow-modal z-10 overflow-hidden">
                      {customers.map((c: any) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectCustomer(c)}
                          className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-bg-hover text-left transition-colors"
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

                {selectedCustomer && (
                  <div className="flex items-center justify-between p-3 rounded-lg bg-brand/10 border border-brand/20">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{selectedCustomer.name}</p>
                      <p className="text-xs text-text-muted">
                        Cashback:{' '}
                        <span className="text-success font-semibold">{formatCurrency(cashbackBalance)}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCustomer(null)
                        setCustomerSearch('')
                        setValue('customer_id', 0)
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs text-text-muted hover:text-error hover:bg-error/10 transition-colors"
                    >
                      Trocar
                    </button>
                  </div>
                )}

                <Button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={!selectedCustomer}
                  className="w-full h-11"
                >
                  Continuar
                </Button>
              </div>
            )}

            {/* Step 2: Itens */}
            {step === 1 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Adicionar Itens</h3>

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

                {/* Busca de produto */}
                <div className="relative">
                  <Input
                    label="Buscar produto por nome ou SKU"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    prefix={<Search className="w-4 h-4" />}
                    placeholder="Digite SKU ou nome..."
                    autoComplete="off"
                  />
                  {products.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-lg shadow-modal z-10 overflow-hidden">
                      {products.map((v: any) => {
                        const p = v.products
                        const qty = Array.isArray(v.stock)
                          ? (v.stock[0]?.quantity ?? 0)
                          : (v.stock?.quantity ?? 0)
                        return (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => addProduct(v)}
                            className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-bg-hover text-left transition-colors border-b border-border/50 last:border-0"
                          >
                            <div className="flex-1 min-w-0 mr-3">
                              <p className="text-sm font-medium text-text-primary truncate">{p?.name}</p>
                              <p className="text-xs text-text-muted font-mono">{v.sku_variation}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-sm font-semibold text-text-primary">
                                {formatCurrency(v.price_override ?? p?.base_price)}
                              </p>
                              <p className={`text-xs ${qty > 3 ? 'text-success' : qty > 0 ? 'text-warning' : 'text-error'}`}>
                                {qty} em estoque
                              </p>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
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
                      const varId = items[i]?.product_variation_id
                      const name  = productNames[varId] ?? `Variação #${varId}`
                      const qty   = items[i]?.quantity ?? 1
                      const price = items[i]?.unit_price ?? 0
                      return (
                        <div key={field.id} className="p-3.5 rounded-xl bg-bg-overlay space-y-2.5">
                          {/* Linha superior: nome + delete */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold text-text-primary leading-snug truncate">
                                {name}
                              </p>
                              <p className="text-xs text-text-muted mt-0.5">
                                {formatCurrency(price)} / unidade
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => remove(i)}
                              className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors flex-shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Linha inferior: +/- e total */}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {/* Botões +/- com área de toque 44px */}
                              <button
                                type="button"
                                onClick={() => { if (qty > 1) setValue(`items.${i}.quantity`, qty - 1) }}
                                className="w-11 h-11 rounded-xl bg-bg-hover text-text-primary flex items-center justify-center text-xl font-bold transition-colors hover:bg-bg-active touch-manipulation"
                              >
                                −
                              </button>
                              <span className="text-base font-bold text-text-primary w-8 text-center tabular-nums">
                                {qty}
                              </span>
                              <button
                                type="button"
                                onClick={() => setValue(`items.${i}.quantity`, qty + 1)}
                                className="w-11 h-11 rounded-xl bg-bg-hover text-text-primary flex items-center justify-center text-xl font-bold transition-colors hover:bg-bg-active touch-manipulation"
                              >
                                +
                              </button>
                            </div>
                            <p className="text-base font-bold text-text-primary tabular-nums">
                              {formatCurrency(price * qty)}
                            </p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(0)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={fields.length === 0}
                    className="flex-1 h-11"
                  >
                    Continuar
                  </Button>
                </div>
              </div>
            )}

            {/* Step 3: Pagamento */}
            {step === 2 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Pagamento e Resumo</h3>

                <Controller
                  control={control}
                  name="payment_method"
                  render={({ field }) => (
                    <Select label="Forma de Pagamento" required {...field}>
                      <option value="pix">PIX</option>
                      <option value="card">Cartão</option>
                      <option value="cash">Dinheiro</option>
                    </Select>
                  )}
                />

                <Controller
                  control={control}
                  name="sale_origin"
                  render={({ field }) => (
                    <Select label="Origem da Venda" {...field} value={field.value ?? ''}>
                      <option value="">Não informado</option>
                      <option value="instagram">Instagram</option>
                      <option value="referral">Indicação</option>
                      <option value="paid_traffic">Tráfego Pago</option>
                      <option value="website">Site</option>
                      <option value="store">Loja Física</option>
                      <option value="other">Outro</option>
                    </Select>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Desconto (R$)"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    {...register('discount_amount', { valueAsNumber: true })}
                  />
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

                {cashbackBalance > 0 && (
                  <div className="space-y-3">
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

                <Input
                  label="Observações"
                  placeholder="Opcional"
                  {...register('notes')}
                />

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(1)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  {/* Botão Revisar — oculto no mobile pois a sticky bar assume */}
                  <Button
                    type="button"
                    onClick={() => setStep(3)}
                    className="flex-1 h-11 hidden sm:flex"
                  >
                    Revisar
                  </Button>
                </div>
              </div>
            )}

            {/* Step 4: Confirmar */}
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
                      <span className="font-medium">{formatCurrency(subtotal)}</span>
                    </div>
                  )}
                  {discountAmount > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Desconto</span>
                      <span className="font-medium text-success">− {formatCurrency(discountAmount)}</span>
                    </div>
                  )}
                  {shippingCharged > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Frete</span>
                      <span className="font-medium">+ {formatCurrency(shippingCharged)}</span>
                    </div>
                  )}
                  {surchargeAmount > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Acréscimo</span>
                      <span className="font-medium text-warning">+ {formatCurrency(surchargeAmount)}</span>
                    </div>
                  )}
                  {cashbackUsed > 0 && (
                    <div className="flex justify-between py-3">
                      <span className="text-text-secondary">Cashback usado</span>
                      <span className="font-medium text-success">− {formatCurrency(cashbackUsed)}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-3">
                    <span className="font-bold text-text-primary">Total a pagar</span>
                    <span className="text-xl font-bold text-text-primary tabular-nums">
                      {formatCurrency(total)}
                    </span>
                  </div>
                </div>

                {Object.keys(errors).length > 0 && (
                  <div className="rounded-lg bg-error/10 border border-error/30 p-3 text-xs text-error space-y-1">
                    <p className="font-semibold">Corrija os erros antes de continuar:</p>
                    {errors.customer_id    && <p>• Cliente: {errors.customer_id.message}</p>}
                    {errors.payment_method && <p>• Forma de pagamento: {errors.payment_method.message}</p>}
                    {errors.items          && <p>• Itens: {typeof errors.items.message === 'string' ? errors.items.message : 'Verifique os itens'}</p>}
                    {errors.discount_amount&& <p>• Desconto: {errors.discount_amount.message}</p>}
                    {errors.surcharge_amount&&<p>• Acréscimo: {errors.surcharge_amount.message}</p>}
                    {errors.cashback_used  && <p>• Cashback: {errors.cashback_used.message}</p>}
                    {errors.shipping_charged&&<p>• Frete: {errors.shipping_charged.message}</p>}
                  </div>
                )}

                {/* Botões — visíveis no desktop; no mobile a sticky bar assume o Confirmar */}
                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(2)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="submit"
                    loading={isSubmitting}
                    className="flex-1 h-11 hidden sm:flex"
                  >
                    <ShoppingCart className="w-4 h-4" />
                    Confirmar Venda
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Sidebar resumo do carrinho (desktop only) ── */}
          <div className="hidden lg:block card p-5 h-fit sticky top-20">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Resumo</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-text-secondary">
                <span>Subtotal ({fields.length} itens)</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex justify-between text-success">
                  <span>Desconto</span>
                  <span>− {formatCurrency(discountAmount)}</span>
                </div>
              )}
              {shippingCharged > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Frete</span>
                  <span>+ {formatCurrency(shippingCharged)}</span>
                </div>
              )}
              {surchargeAmount > 0 && (
                <div className="flex justify-between text-warning">
                  <span>Acréscimo</span>
                  <span>+ {formatCurrency(surchargeAmount)}</span>
                </div>
              )}
              {cashbackUsed > 0 && (
                <div className="flex justify-between text-success">
                  <span>Cashback</span>
                  <span>− {formatCurrency(cashbackUsed)}</span>
                </div>
              )}
              <div className="flex justify-between text-text-secondary border-t border-border pt-2 mt-2 text-xs">
                <span>{deliveryMode === 'pickup' ? '📦 Retirada' : '🚚 Envio'}</span>
              </div>
              <div className="flex justify-between font-bold text-text-primary">
                <span>Total</span>
                <span className="text-lg tabular-nums">{formatCurrency(total)}</span>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
