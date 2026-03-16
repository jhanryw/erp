'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Plus, Trash2, Search, ShoppingCart, ChevronRight, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { saleSchema, type SaleFormData } from '@/lib/validators'
import { formatCurrency, calcMargin } from '@/lib/utils/currency'
import { useDebounce } from '@/hooks/useDebounce'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useAuth } from '@/hooks/useAuth'

// Steps do fluxo
const STEPS = ['Cliente', 'Itens', 'Pagamento', 'Confirmar']

export default function NovaVendaPage() {
  const [step, setStep] = useState(0)
  const [customerSearch, setCustomerSearch] = useState('')
  const [productSearch, setProductSearch] = useState('')
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null)
  const [cashbackBalance, setCashbackBalance] = useState(0)
  const router = useRouter()
  const { user } = useAuth()
  const supabase = createClient()

  const debouncedCustomer = useDebounce(customerSearch, 300)
  const debouncedProduct = useDebounce(productSearch, 300)

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
      discount_amount: 0,
      cashback_used: 0,
      shipping_charged: 0,
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
      const { data } = await supabase
        .from('product_variations')
        .select(`
          id, sku_variation, price_override, cost_override,
          products:product_id (id, name, sku, base_price, base_cost),
          stock:product_variation_id (quantity)
        `)
        .ilike('sku_variation', `%${debouncedProduct}%`)
        .gt('stock.quantity', 0)
        .limit(8)
      return data ?? []
    },
    enabled: debouncedProduct.length >= 2,
  })

  async function selectCustomer(customer: any) {
    setSelectedCustomer(customer)
    setValue('customer_id', customer.id)
    setCustomerSearch(customer.name)

    // Buscar saldo de cashback
    const { data } = await supabase
      .from('v_cashback_balance')
      .select('available_balance')
      .eq('customer_id', customer.id)
      .single()
    setCashbackBalance(data?.available_balance ?? 0)
  }

  function addProduct(variation: any) {
    const product = variation.products
    const price = variation.price_override ?? product.base_price
    const cost = variation.cost_override ?? product.base_cost
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

  const items = watch('items')
  const discountAmount = watch('discount_amount') ?? 0
  const cashbackUsed = watch('cashback_used') ?? 0
  const shippingCharged = watch('shipping_charged') ?? 0

  const subtotal = items.reduce((s, item) => s + item.unit_price * item.quantity - item.discount_amount, 0)
  const total = Math.max(0, subtotal - discountAmount - cashbackUsed + shippingCharged)

  async function onSubmit(data: SaleFormData) {
    if (!user) return

    // Calcular totais
    const subtotalCalc = data.items.reduce(
      (s, i) => s + i.unit_price * i.quantity - i.discount_amount,
      0
    )

    const { data: sale, error } = await supabase
      .from('sales')
      .insert({
        customer_id: data.customer_id,
        seller_id: user.id,
        status: 'paid',
        subtotal: subtotalCalc,
        discount_amount: data.discount_amount ?? 0,
        cashback_used: data.cashback_used ?? 0,
        shipping_charged: data.shipping_charged ?? 0,
        total: Math.max(0, subtotalCalc - (data.discount_amount ?? 0) - (data.cashback_used ?? 0) + (data.shipping_charged ?? 0)),
        payment_method: data.payment_method,
        sale_origin: data.sale_origin,
        notes: data.notes,
        sale_date: new Date().toISOString().split('T')[0],
      })
      .select('id, sale_number')
      .single()

    if (error || !sale) {
      toast.error('Erro ao registrar venda', { description: error?.message })
      return
    }

    // Inserir itens
    const itemsPayload = data.items.map((item) => ({
      sale_id: sale.id,
      product_variation_id: item.product_variation_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      unit_cost: item.unit_cost,
      discount_amount: item.discount_amount ?? 0,
      total_price: item.unit_price * item.quantity - (item.discount_amount ?? 0),
    }))

    await supabase.from('sale_items').insert(itemsPayload)

    toast.success('Venda registrada!', {
      description: `Pedido ${sale.sale_number} criado com sucesso.`,
    })
    router.push(`/vendas/${sale.id}`)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Stepper */}
      <div className="flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold transition-colors ${
                i < step
                  ? 'bg-success text-white'
                  : i === step
                  ? 'bg-brand text-white'
                  : 'bg-bg-overlay text-text-muted'
              }`}
            >
              {i < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </div>
            <span
              className={`text-sm ${i === step ? 'text-text-primary font-medium' : 'text-text-muted'}`}
            >
              {s}
            </span>
            {i < STEPS.length - 1 && <ChevronRight className="w-4 h-4 text-text-muted" />}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit(onSubmit)}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Content area */}
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
                  />
                  {customers.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-lg shadow-modal z-10 overflow-hidden">
                      {customers.map((c: any) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => selectCustomer(c)}
                          className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-hover text-left transition-colors"
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
                        Cashback disponível:{' '}
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
                      className="text-xs text-text-muted hover:text-error"
                    >
                      Trocar
                    </button>
                  </div>
                )}

                <Button
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={!selectedCustomer}
                  className="w-full"
                >
                  Continuar
                </Button>
              </div>
            )}

            {/* Step 2: Itens */}
            {step === 1 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Adicionar Itens</h3>

                {/* Busca de produto */}
                <div className="relative">
                  <Input
                    label="Buscar produto por nome ou SKU"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    prefix={<Search className="w-4 h-4" />}
                    placeholder="Digite SKU ou nome..."
                  />
                  {products.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-bg-elevated border border-border rounded-lg shadow-modal z-10 overflow-hidden">
                      {products.map((v: any) => {
                        const p = v.products
                        const qty = v.stock?.quantity ?? 0
                        return (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => addProduct(v)}
                            className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-hover text-left transition-colors"
                          >
                            <div>
                              <p className="text-sm font-medium text-text-primary">{p?.name}</p>
                              <p className="text-xs text-text-muted font-mono">{v.sku_variation}</p>
                            </div>
                            <div className="text-right">
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
                  <div className="py-8 text-center text-sm text-text-muted">
                    Nenhum item adicionado
                  </div>
                ) : (
                  <div className="space-y-2">
                    {fields.map((field, i) => (
                      <div key={field.id} className="flex items-center gap-3 p-3 rounded-lg bg-bg-overlay">
                        <div className="flex-1">
                          <p className="text-sm font-medium text-text-primary">
                            Variação #{items[i]?.product_variation_id}
                          </p>
                          <p className="text-xs text-text-muted">
                            {formatCurrency(items[i]?.unit_price ?? 0)} × {items[i]?.quantity ?? 1}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const current = items[i]?.quantity ?? 1
                              if (current > 1) setValue(`items.${i}.quantity`, current - 1)
                            }}
                            className="w-6 h-6 rounded bg-bg-hover text-text-primary flex items-center justify-center text-sm"
                          >
                            −
                          </button>
                          <span className="text-sm font-medium w-6 text-center">
                            {items[i]?.quantity ?? 1}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const current = items[i]?.quantity ?? 1
                              setValue(`items.${i}.quantity`, current + 1)
                            }}
                            className="w-6 h-6 rounded bg-bg-hover text-text-primary flex items-center justify-center text-sm"
                          >
                            +
                          </button>
                        </div>
                        <p className="text-sm font-semibold text-text-primary w-20 text-right">
                          {formatCurrency((items[i]?.unit_price ?? 0) * (items[i]?.quantity ?? 1))}
                        </p>
                        <button
                          type="button"
                          onClick={() => remove(i)}
                          className="p-1 text-text-muted hover:text-error transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-3">
                  <Button type="button" variant="secondary" onClick={() => setStep(0)} className="flex-1">
                    Voltar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={fields.length === 0}
                    className="flex-1"
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
                    <Select label="Origem da Venda" {...field}>
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
                    {...register('discount_amount', { valueAsNumber: true })}
                  />
                  <Input
                    label="Frete cobrado (R$)"
                    type="number"
                    step="0.01"
                    min="0"
                    {...register('shipping_charged', { valueAsNumber: true })}
                  />
                </div>

                {cashbackBalance > 0 && (
                  <Input
                    label={`Cashback (disponível: ${formatCurrency(cashbackBalance)})`}
                    type="number"
                    step="0.01"
                    min="0"
                    max={cashbackBalance}
                    {...register('cashback_used', { valueAsNumber: true })}
                  />
                )}

                <Input
                  label="Observações"
                  placeholder="Opcional"
                  {...register('notes')}
                />

                <div className="flex gap-3">
                  <Button type="button" variant="secondary" onClick={() => setStep(1)} className="flex-1">
                    Voltar
                  </Button>
                  <Button type="button" onClick={() => setStep(3)} className="flex-1">
                    Revisar
                  </Button>
                </div>
              </div>
            )}

            {/* Step 4: Confirmar */}
            {step === 3 && (
              <div className="card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-text-primary">Confirmar Venda</h3>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between py-1.5 border-b border-border/50">
                    <span className="text-text-secondary">Cliente</span>
                    <span className="font-medium">{selectedCustomer?.name}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-border/50">
                    <span className="text-text-secondary">Itens</span>
                    <span className="font-medium">{fields.length} produto(s)</span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-text-secondary font-semibold">Total a pagar</span>
                    <span className="text-lg font-bold text-text-primary">{formatCurrency(total)}</span>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button type="button" variant="secondary" onClick={() => setStep(2)} className="flex-1">
                    Voltar
                  </Button>
                  <Button type="submit" loading={isSubmitting} className="flex-1">
                    <ShoppingCart className="w-4 h-4" />
                    Confirmar Venda
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar: resumo do carrinho */}
          <div className="card p-5 h-fit sticky top-20">
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
              {cashbackUsed > 0 && (
                <div className="flex justify-between text-success">
                  <span>Cashback</span>
                  <span>− {formatCurrency(cashbackUsed)}</span>
                </div>
              )}
              {shippingCharged > 0 && (
                <div className="flex justify-between text-text-secondary">
                  <span>Frete</span>
                  <span>+ {formatCurrency(shippingCharged)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-text-primary border-t border-border pt-2 mt-2">
                <span>Total</span>
                <span className="text-lg">{formatCurrency(total)}</span>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}
