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
import { computeSubtotal, computeGrandTotal, computeItemAdjustmentFromListPrice } from '@/lib/sales/pricing'
import { createAutoPrintController } from '@/lib/sales/autoPrintTab'
import { resolvePostSalePrintTarget } from '@/lib/sales/resolvePostSalePrintTarget'
import { DeliveryAddressForm, type DeliveryRecipientValue } from '@/components/vendas/DeliveryAddressForm'
import { FiscalRecipientFields, EMPTY_FISCAL_RECIPIENT, type FiscalRecipientValue } from '@/components/vendas/FiscalRecipientFields'
import { resolveFiscalDocumentType } from '@/lib/fiscal/resolveFiscalDocumentType'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProductSearchInput } from '@/components/vendas/ProductSearchInput'
import type { ProductSearchItem } from '@/components/vendas/ProductSearchInput'
import { SellerPicker } from '@/components/vendas/SellerPicker'
import { Select } from '@/components/ui/select'

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

// Fase Fiscal 5C — mínimo operacional pra CONCLUIR a venda de entrega
// (não é o mesmo mínimo exigido pra emitir NF-e, que inclui CPF/CNPJ e
// código IBGE — ver validateNfeReadiness/validateNfeDestinatario). Aqui só
// bloqueia avançar sem o suficiente pra entrega física acontecer.
function isDeliveryRecipientReady(recipient: DeliveryRecipientValue | null): boolean {
  if (!recipient) return false
  return Boolean(
    recipient.nome.trim() &&
    /^\d{8}$/.test(recipient.cep) &&
    recipient.logradouro.trim() &&
    recipient.numero.trim() &&
    recipient.bairro.trim() &&
    recipient.municipio.trim() &&
    /^[A-Za-z]{2}$/.test(recipient.uf)
  )
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

  // ── Modalidade da venda (PDV atacado/varejo, 2026-09-02) ─────────────────────
  // `saleTypeChosen` é distinto do valor em si: o form nasce com default
  // 'retail' (retrocompatibilidade/segurança), mas a UI exige uma escolha
  // EXPLÍCITA do vendedor antes de liberar o Passo 0 — não basta o default
  // silencioso valer como escolha.
  const [saleTypeChosen, setSaleTypeChosen] = useState(false)

  // ── Caixa ────────────────────────────────────────────────────────────────────
  const [cashSession, setCashSession] = useState<{ id: number; opened_at: string } | null | undefined>(undefined)

  // ── Endereço de entrega (Fase Fiscal 5C) ─────────────────────────────────────
  const [deliveryRecipient, setDeliveryRecipient] = useState<DeliveryRecipientValue | null>(null)
  // Fase Fiscal 6 — destinatário fiscal (NFC-e com CPF, ou NF-e completo).
  // Mesmo padrão de deliveryRecipient: estado local + useEffect sincroniza
  // pro form (evita re-render em cascata a cada tecla digitada nos campos
  // fiscais, que também usam FiscalRecipientFields em modo NF-e).
  const [fiscalRecipient, setFiscalRecipient] = useState<FiscalRecipientValue | null>(null)

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

  // Comprovante não fiscal — impressão automática ao finalizar (retirada e
  // entrega). Controller puro/testável em src/lib/sales/autoPrintTab.ts —
  // aqui só instancia com o window.open real do navegador.
  const autoPrintRef = useRef<ReturnType<typeof createAutoPrintController>>()
  if (!autoPrintRef.current) {
    autoPrintRef.current = createAutoPrintController({
      openBlankWindow: () => window.open('about:blank', '_blank'),
    })
  }
  const handleFinalizarClick = () => autoPrintRef.current!.handleFinalizarClick()
  // Validação do react-hook-form falhou (campo obrigatório faltando etc.) —
  // onSubmit nunca chega a rodar. Fecha a aba about:blank em vez de deixá-la
  // parada pra sempre.
  const handleFinalizarInvalid = () => autoPrintRef.current!.reset()

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
      delivery_recipient: null,
      // Fase Fiscal 7 — 'auto' é o default: a emissão fiscal é automática
      // ao finalizar (ver effectiveFiscalMode/resolveFiscalOperation
      // no servidor). 'none'/'nfce'/'nfe' continuam disponíveis como
      // override explícito do operador via os botões abaixo.
      fiscal_document_type: 'auto',
      fiscal_recipient: null,
      // PDV atacado/varejo (2026-09-02) — default seguro retrocompatível;
      // a UI exige escolha explícita antes de avançar do Passo 0 mesmo
      // assim (ver botão "Continuar" mais abaixo).
      sale_type: 'retail',
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

    const balRes = await fetch(`/api/cashback/balance?customer_id=${customer.id}`)
    const balJson = balRes.ok ? await balRes.json() : { available_balance: 0 }
    setCashbackBalance(balJson.available_balance ?? 0)
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
    // Fundação varejo/atacado (2026-08-31): CPF deixou de ser requisito
    // para cadastrar cliente — só validado quando o operador o informa.
    if (cpfClean.length > 0 && cpfClean.length !== 11) { toast.error('CPF inválido — informe 11 dígitos ou deixe em branco'); return }
    if (!newBirthDate)               { toast.error('Data de nascimento obrigatória'); return }

    setCreatingCustomer(true)
    try {
      const res = await fetch('/api/clientes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), phone: newPhone.trim(), cpf: cpfClean || null, birth_date: newBirthDate }),
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
    setDeliveryRecipient(null) // endereço pertence ao cliente anterior — nunca reaproveitar
  }

  // ── Handlers: modalidade da venda ─────────────────────────────────────────────
  // Decisão de UX (menor risco, conforme pedido): uma vez que o carrinho tem
  // ao menos 1 item, a modalidade trava — trocar exigiria recalcular preço
  // de cada item e decidir o que fazer com preço editado manualmente, o que
  // é ambíguo o suficiente pra preferir bloquear a inventar uma heurística.
  // O vendedor pode remover os itens (ou voltar) e escolher de novo.
  function handleSaleTypeChange(next: 'retail' | 'wholesale') {
    if (fields.length > 0 && next !== saleType) {
      toast.error('Não é possível trocar a modalidade com itens no carrinho', {
        description: 'Remova os itens adicionados para trocar entre Varejo e Atacado.',
      })
      return
    }
    setValue('sale_type', next)
    setSaleTypeChosen(true)
  }

  // ── Handlers: produto ─────────────────────────────────────────────────────────
  function addProduct(item: ProductSearchItem) {
    // PDV atacado/varejo (2026-09-02) — defesa em profundidade: o
    // ProductSearchInput já bloqueia a seleção de item sem preço de
    // atacado (com toast explicativo), mas nunca confiar só nisso — este
    // handler é a última linha antes de entrar no carrinho.
    if (item.price == null) {
      toast.error('Preço de atacado não cadastrado', {
        description: `"${item.product_name}" não pode ser adicionado em atacado sem preço cadastrado.`,
      })
      return
    }

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
      surcharge_amount: 0,
      // Fase Fiscal 5C — preço de tabela capturado no momento em que o
      // item entra no carrinho, congelado daqui pra frente (nunca lido de
      // volta do catálogo). unit_price continua sendo a única fonte da
      // verdade editável — este campo é só para exibir/derivar desconto ou
      // acréscimo implícito quando o vendedor mudar unit_price depois.
      list_price_snapshot: item.price,
      total_price:     item.price,
    })
  }

  // ── Handlers: preço negociado por item (Fase Fiscal 5C) ──────────────────────
  // Single source of truth = unit_price digitado pelo vendedor. discount_amount
  // e surcharge_amount de nível de ITEM continuam existindo no schema para o
  // caso raro de um ajuste explícito documentado separadamente (ex.: cupom
  // aplicado a um item específico) — mas o fluxo padrão desta tela é só
  // editar o preço vendido; desconto/acréscimo são DERIVADOS pra exibição
  // (computeItemAdjustmentFromListPrice), nunca uma segunda fonte digitável
  // aqui, pra não abrir espaço pra dupla contagem.
  function handleItemPriceChange(index: number, value: string) {
    const price = parseFloat(value)
    if (!Number.isFinite(price) || price <= 0) return
    setValue(`items.${index}.unit_price`, price)
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
  const saleType        = watch('sale_type') ?? 'retail'
  const fiscalDocumentType = watch('fiscal_document_type') ?? 'auto'

  // Sugestão (nunca obrigatória) de qual documento fiscal é o mais
  // adequado pra esta venda, calculada com a MESMA função pura usada no
  // servidor (nenhuma lógica fiscal duplicada) — usa os valores JÁ
  // escolhidos neste formulário (modo de entrega/origem), sem nenhuma
  // chamada de rede. O servidor é quem decide de verdade na hora de
  // emitir; isto é só uma pista visual pro operador.
  const fiscalRecommended = resolveFiscalDocumentType({ deliveryMode, saleOrigin: saleOrigin ?? null })

  // Fase Fiscal 7 — o que a emissão automática vai realmente tentar quando
  // `fiscal_document_type === 'auto'` (default). Espelha
  // `resolveFiscalOperation` no servidor só pra fins de exibição
  // (pista visual, nunca a decisão real — mesmo espírito de
  // `fiscalRecommended` acima): atacado nunca emite NFC-e sozinho (exceção
  // legal, ver comentário em resolveFiscalOperationDecision.ts), e um
  // resultado 'blocked' vira 'none' (nada será emitido automaticamente).
  const autoWillEmit: 'nfce' | 'nfe' | 'none' =
    saleType === 'wholesale' ? 'none' : fiscalRecommended === 'blocked' ? 'none' : fiscalRecommended

  // Modo fiscal EFETIVO pra fins de exibição/campos de destinatário — nunca
  // passa o literal 'auto' adiante (FiscalRecipientFields só aceita
  // 'nfce'/'nfe').
  const effectiveFiscalMode: 'none' | 'nfce' | 'nfe' =
    fiscalDocumentType === 'auto' ? autoWillEmit : fiscalDocumentType

  // Fase Fiscal 5C — single source of truth da aritmética de preço é
  // src/lib/sales/pricing.ts, o mesmo módulo que espelha a fórmula do RPC
  // (rpc_create_sale) e é coberto pelos testes de invariante da fase.
  // Nunca duplicar esta conta inline.
  const subtotal            = computeSubtotal(items.map((item) => ({
    unitPrice: item.unit_price, quantity: item.quantity,
    discountAmount: item.discount_amount, surchargeAmount: item.surcharge_amount ?? 0,
  })))
  const currentDiscountPct  = subtotal > 0 && discountAmount > 0 ? (discountAmount / subtotal) * 100 : 0
  const gross               = computeGrandTotal({
    subtotal, discountAmount, surchargeAmount, shippingCharged, cashbackUsed: 0,
  })
  const total = computeGrandTotal({ subtotal, discountAmount, surchargeAmount, shippingCharged, cashbackUsed })

  // Invalida o token de desconto se o valor mudar depois da autorização
  // Quando o crédito cobre 100% do valor, limpa pagamentos já adicionados
  // (evita que o RPC receba payments[sum=X] com total=0 e rejeite por divergência)
  useEffect(() => {
    if (total <= 0.009 && cashbackUsed > 0) {
      setPayments(prev => prev.length > 0 ? [] : prev)
    }
  }, [total, cashbackUsed])

  // Fase Fiscal 5C — sincroniza o estado do endereço de entrega (gerenciado
  // fora do react-hook-form, mesmo padrão já usado para `payments[]`) com o
  // campo `delivery_recipient` validado por saleSchema no submit.
  useEffect(() => {
    setValue('delivery_recipient', deliveryMode === 'delivery' ? deliveryRecipient : null)
  }, [deliveryRecipient, deliveryMode, setValue])

  // Fase Fiscal 6 — sincroniza o destinatário fiscal local pro form. Só
  // relevante quando o operador escolheu NFC-e/NF-e — 'none' nunca envia
  // nada (evita mandar um objeto fiscal_recipient parcial preenchido por
  // engano quando o operador troca de volta pra "Somente comprovante").
  useEffect(() => {
    setValue('fiscal_recipient', effectiveFiscalMode !== 'none' ? fiscalRecipient : null)
  }, [fiscalRecipient, effectiveFiscalMode, setValue])

  // Fase Fiscal 6 — quando o operador escolhe NF-e numa venda de ENTREGA
  // que já tem endereço preenchido, pré-carrega os campos fiscais com o
  // MESMO endereço (nunca obriga redigitar o que já foi informado) — só
  // uma vez, na troca pra 'nfe' com o destinatário fiscal ainda vazio;
  // depois disso o operador tem controle total (ex.: adicionar CNPJ/IE).
  // Puramente uma conveniência de UI — o servidor já faz este MESMO merge
  // de forma segura e independente (buildFiscalRecipientInput em
  // POST /api/vendas), então isto nunca é a única garantia de correção.
  useEffect(() => {
    if (effectiveFiscalMode === 'nfe' && deliveryMode === 'delivery' && deliveryRecipient && !fiscalRecipient) {
      setFiscalRecipient({
        ...EMPTY_FISCAL_RECIPIENT,
        nome: deliveryRecipient.nome, cpf: deliveryRecipient.cpf ?? null, cnpj: deliveryRecipient.cnpj ?? null,
        telefone: deliveryRecipient.telefone ?? null, cep: deliveryRecipient.cep, logradouro: deliveryRecipient.logradouro,
        numero: deliveryRecipient.numero, complemento: deliveryRecipient.complemento ?? null, bairro: deliveryRecipient.bairro,
        municipio: deliveryRecipient.municipio, uf: deliveryRecipient.uf, municipio_ibge: deliveryRecipient.municipio_ibge ?? null,
        ibge_source: (deliveryRecipient.ibge_source as FiscalRecipientValue['ibge_source']) ?? null,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFiscalMode, deliveryMode])

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
      autoPrintRef.current!.reset()
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
      autoPrintRef.current!.reset()
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
        }),
      })
      const text = await res.text()
      let json: Record<string, unknown>
      try {
        json = JSON.parse(text)
      } catch {
        submitting.current = false
        autoPrintRef.current!.reset()
        toast.error('Erro ao registrar venda', {
          description: res.status === 401 || res.status === 403
            ? 'Sessão expirada. Faça login novamente.'
            : 'Resposta inesperada do servidor. Tente novamente.',
        })
        return
      }
      if (!res.ok) {
        submitting.current = false
        autoPrintRef.current!.reset()
        // json.error pode ser objeto Zod — serializar para evitar React error #31
        const errMsg = typeof json.error === 'string'
          ? json.error
          : (json.error as any)?.formErrors?.[0] ?? JSON.stringify(json.error) ?? 'Erro desconhecido'
        toast.error('Erro ao registrar venda', { description: errMsg })
        return
      }
      const sale = json.sale as { id: number; sale_number: string }
      toast.success('Venda registrada!', {
        description: `Pedido ${sale.sale_number} criado com sucesso.`,
      })

      // Motor Fiscal Configurável — resultado da emissão (se alguma foi
      // tentada). Sempre INFORMATIVO, nunca bloqueia a navegação — a venda
      // já foi criada com sucesso independente do resultado fiscal.
      const fiscal = json.fiscal as { requested: 'nfce' | 'nfe'; status: string; reason: string | null } | undefined
      const fiscalPrint = json.fiscalPrint as { autoPrint: boolean; printNonFiscalReceipt: boolean } | undefined
      // Regra definitiva de impressão/QR Code — precedência (documento
      // fiscal recém-autorizado sempre vence sobre o comprovante não
      // fiscal) extraída pra função pura testável, ver resolvePostSalePrintTarget.ts.
      const printTarget = resolvePostSalePrintTarget({ saleId: sale.id, fiscal, fiscalPrint })
      const autoPrintedFiscal = printTarget.reason === 'fiscal_authorized'
      if (fiscal) {
        const label = fiscal.requested === 'nfce' ? 'NFC-e' : 'NF-e'
        if (fiscal.status === 'authorized') {
          // item 47 do pedido: auditei até onde o browser permite
          // automatizar a impressão do DANFE fiscal com segurança. Duas
          // abas about:blank pré-abertas no MESMO clique (uma pro
          // comprovante comercial, outra pro DANFE) teriam suporte
          // inconsistente entre navegadores e imprimiriam DOIS papéis na
          // MESMA impressora térmica simultaneamente. Por isso só UMA aba
          // é pré-aberta (autoPrintRef, abaixo) — sua URL final é decidida
          // pela POLÍTICA da empresa (fiscalPrint), nunca pelas duas ao
          // mesmo tempo. Se a política não mandar imprimir automaticamente,
          // o botão de ação no toast cobre o caso (1 clique, GET puro,
          // nunca reemite — ver getNfceDanfeData.ts).
          toast.success(
            autoPrintedFiscal ? `${label} autorizada! Imprimindo DANFE...` : `${label} autorizada!`,
            !autoPrintedFiscal && fiscal.requested === 'nfce' ? {
              action: { label: 'Imprimir DANFE', onClick: () => window.open(`/vendas/${sale.id}/nfce`, '_blank') },
            } : undefined,
          )
        } else if (fiscal.status === 'pending') {
          toast.info(`${label} enviada — processando na SEFAZ`, { description: 'Acompanhe o status na tela da venda.' })
        } else {
          toast.warning(`${label} não foi emitida agora`, {
            description: (fiscal.reason ?? 'Dados fiscais pendentes.') + ' Complete/tente novamente na tela da venda.',
          })
        }
      }

      // Impressão automática — controlada pela política da empresa
      // (Configurações → Fiscal), não mais hardcoded. A ÚNICA aba
      // about:blank pré-aberta no clique (autoPrintRef) é redirecionada
      // pra UM destino: o comprovante não fiscal (se a política pedir) OU
      // o DANFE NFC-e (se a política pedir emissão+impressão automática e
      // a NFC-e saiu autorizada agora) — nunca os dois na mesma aba/clique
      // (ver comentário acima). Se nenhum dos dois estiver ligado pra esta
      // operação (ex.: entrega — nem comprovante nem DANFE automáticos por
      // padrão), a aba pré-aberta é só fechada, sem imprimir nada.
      const printUrl = printTarget.url

      if (printUrl) {
        const printed = autoPrintRef.current!.redirectToReceipt(printUrl)
        if (!printed) {
          toast.info('Impressão automática não pôde ser aberta (pop-up bloqueado)', {
            description: 'Use os botões de impressão na página da venda.',
          })
        }
      } else {
        autoPrintRef.current!.reset()
      }

      router.push(`/vendas/${sale.id}`)
    } catch (err) {
      submitting.current = false
      autoPrintRef.current!.reset()
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

      {/* ── Badge de modalidade — visível em todos os passos, PDV atacado/varejo (2026-09-02) ── */}
      {saleTypeChosen && (
        <div className={`inline-flex items-center gap-1.5 text-xs font-bold tracking-wide px-2.5 py-1 rounded-full border ${
          saleType === 'wholesale'
            ? 'bg-purple-500/15 text-purple-400 border-purple-500/20'
            : 'bg-blue-500/15 text-blue-400 border-blue-500/20'
        }`}>
          {saleType === 'wholesale' ? 'ATACADO' : 'VAREJO'}
        </div>
      )}

      <form id="sale-form" onSubmit={handleSubmit(onSubmit, handleFinalizarInvalid)}>

        {/* ── Sticky bar mobile ──────────────────────────────────── */}
        <div className="lg:hidden fixed bottom-16 left-0 right-0 z-20 bg-bg-elevated/95 backdrop-blur-md border-t border-border shadow-elevated">
          {step === 3 ? (
            <div className="p-3">
              <Button
                type="submit"
                form="sale-form"
                onClick={handleFinalizarClick}
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

                {/* Modalidade da venda — PDV atacado/varejo (2026-09-02) */}
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-text-secondary">Tipo de Venda *</p>
                  <div className="flex gap-3">
                    {(
                      [
                        { value: 'retail',    label: 'VAREJO' },
                        { value: 'wholesale', label: 'ATACADO' },
                      ] as const
                    ).map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        disabled={fields.length > 0 && saleType !== value}
                        onClick={() => handleSaleTypeChange(value)}
                        className={`flex-1 py-3 rounded-lg border text-sm font-bold tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          saleType === value && saleTypeChosen
                            ? 'bg-brand text-white border-brand'
                            : 'bg-bg-overlay text-text-secondary border-border hover:border-brand/50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {fields.length > 0 && (
                    <p className="text-[11px] text-text-muted">
                      Remova os itens do carrinho para trocar a modalidade.
                    </p>
                  )}
                </div>

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
                  <ProductSearchInput onSelect={addProduct} saleType={saleType} disabled={!saleTypeChosen} />
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
                      const listPrice = items[i]?.list_price_snapshot ?? null
                      const maxStock = meta?.stock ?? Infinity
                      const atLimit  = qty >= maxStock
                      // Fase Fiscal 5C — single source of truth = unit_price;
                      // desconto/acréscimo são sempre DERIVADOS pra exibição,
                      // nunca uma segunda entrada digitável em paralelo (evita
                      // o vendedor calcular na mão e evita dupla contagem).
                      const adjustment = computeItemAdjustmentFromListPrice(price, listPrice)
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
                            </div>
                            <button
                              type="button"
                              onClick={() => remove(i)}
                              className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors flex-shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          {/* ── Preço original / preço vendido / desconto-acréscimo derivado ── */}
                          <div className="flex items-end gap-3 flex-wrap">
                            <div className="min-w-[7rem]">
                              <label className="text-[11px] text-text-muted block mb-0.5">
                                Preço vendido {listPrice != null && (
                                  <span className="text-text-muted/70">(tabela: {formatCurrency(listPrice)})</span>
                                )}
                              </label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0.01"
                                inputMode="decimal"
                                className="h-9 text-sm"
                                defaultValue={price}
                                onBlur={(e) => {
                                  handleItemPriceChange(i, e.target.value)
                                  const newPrice = parseFloat(e.target.value)
                                  if (Number.isFinite(newPrice) && newPrice > 0) {
                                    setValue(`items.${i}.total_price`, newPrice * qty - (items[i]?.discount_amount ?? 0) + (items[i]?.surcharge_amount ?? 0))
                                  }
                                }}
                              />
                            </div>
                            {(adjustment.desconto > 0 || adjustment.acrescimo > 0) && (
                              <p className={`text-xs font-medium pb-2 ${adjustment.desconto > 0 ? 'text-success' : 'text-warning'}`}>
                                {adjustment.desconto > 0
                                  ? `− ${formatCurrency(adjustment.desconto)} de desconto`
                                  : `+ ${formatCurrency(adjustment.acrescimo)} de acréscimo`}
                                {' '}/ unidade
                              </p>
                            )}
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
                    !saleTypeChosen ||
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
                    onClick={() => setStep(3)}
                    disabled={!canFinalize}
                    className="flex-1 h-11"
                  >
                    Continuar
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
                      <div className="absolute top-full left-0 right-0 mt-1 bg-bg-card border border-border rounded-lg shadow-modal z-30 overflow-hidden">
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

                {/* Fase Fiscal 5C — endereço de entrega, só para delivery_mode='delivery' */}
                {selectedCustomer && deliveryMode === 'delivery' && (
                  <DeliveryAddressForm
                    customerId={selectedCustomer.id}
                    defaultNome={selectedCustomer.name}
                    defaultCpf={selectedCustomer.cpf}
                    value={deliveryRecipient}
                    onChange={setDeliveryRecipient}
                  />
                )}

                <div className="flex gap-3 pt-1">
                  <Button type="button" variant="secondary" onClick={() => setStep(0)} className="flex-1 h-11">
                    Voltar
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setStep(2)}
                    disabled={!selectedCustomer || (deliveryMode === 'delivery' && !isDeliveryRecipientReady(deliveryRecipient))}
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
                    <span className="text-text-secondary">Tipo de Venda</span>
                    <span className={`font-bold tracking-wide ${saleType === 'wholesale' ? 'text-purple-400' : 'text-blue-400'}`}>
                      {saleType === 'wholesale' ? 'ATACADO' : 'VAREJO'}
                    </span>
                  </div>
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
                    <span className="font-medium text-right">
                      {deliveryMode === 'pickup' ? '📦 Retirada' : '🚚 Envio'}
                      {deliveryMode === 'delivery' && deliveryRecipient && (
                        <span className="block text-xs text-text-muted font-normal mt-0.5">
                          {deliveryRecipient.logradouro}, {deliveryRecipient.numero} — {deliveryRecipient.municipio}/{deliveryRecipient.uf}
                          {!deliveryRecipient.municipio_ibge && <span className="text-warning"> · sem IBGE</span>}
                        </span>
                      )}
                    </span>
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

                {/* ── Fase Fiscal 7 — Documento fiscal ─────────────────────────
                    Default agora é emissão AUTOMÁTICA ("auto") — a venda
                    não depende mais do vendedor lembrar de pedir nota. Os
                    3 botões são OVERRIDE explícito: "Sem nota" pula a
                    emissão de propósito, "NFC-e"/"NF-e" forçam um tipo
                    específico. Quando nenhum botão foi clicado (estado
                    'auto'), o botão correspondente ao que será emitido
                    automaticamente aparece destacado, só como indicação —
                    a decisão real é do servidor (resolveFiscalOperation). */}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-text-secondary">Documento fiscal</p>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'none' as const, label: 'Sem nota' },
                      { value: 'nfce' as const, label: 'NFC-e' },
                      { value: 'nfe' as const, label: 'NF-e' },
                    ]).map(({ value, label }) => {
                      const isActive = fiscalDocumentType === value
                        || (fiscalDocumentType === 'auto' && autoWillEmit === value)
                      return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setValue('fiscal_document_type', value)}
                        className={`relative py-2.5 rounded-lg border text-xs font-semibold transition-colors ${
                          isActive
                            ? 'bg-brand text-white border-brand'
                            : 'bg-bg-card border-border text-text-secondary hover:border-brand/40'
                        }`}
                      >
                        {label}
                        {value !== 'none' && value === fiscalRecommended && !isActive && (
                          <span className="absolute -top-1.5 -right-1.5 text-[9px] font-bold bg-emerald-500 text-white rounded-full px-1.5 py-0.5">
                            sugerido
                          </span>
                        )}
                      </button>
                      )
                    })}
                  </div>
                  {fiscalDocumentType === 'auto' && (
                    <p className="text-xs text-text-muted">
                      {autoWillEmit === 'none'
                        ? (saleType === 'wholesale'
                            ? 'Atacado: NFC-e não é emitida automaticamente — emita NF-e manualmente na tela da venda, se aplicável.'
                            : 'Não foi possível determinar automaticamente o documento fiscal — nenhuma nota será emitida ao finalizar. Escolha manualmente ou complete os dados da venda.')
                        : `Emissão automática de ${autoWillEmit === 'nfce' ? 'NFC-e' : 'NF-e'} ao finalizar a venda.`}
                    </p>
                  )}
                  {fiscalDocumentType === 'nfce' && saleType === 'wholesale' && (
                    <p className="text-xs text-warning">
                      ⚠ Venda de atacado — NFC-e não pode representar operação com geração de crédito fiscal ao comprador e não será emitida. Use NF-e.
                    </p>
                  )}
                  {fiscalDocumentType === 'nfce' && saleType !== 'wholesale' && fiscalRecommended !== 'nfce' && (
                    <p className="text-xs text-warning">
                      ⚠ Esta venda pode não ser elegível para NFC-e (modalidade/origem indicam {fiscalRecommended === 'nfe' ? 'NF-e' : 'verificação manual'}) — a emissão será tentada, mas pode ser recusada. Se recusada, emita NF-e depois na tela da venda.
                    </p>
                  )}
                  {effectiveFiscalMode !== 'none' && (
                    <FiscalRecipientFields mode={effectiveFiscalMode} value={fiscalRecipient} onChange={setFiscalRecipient} />
                  )}
                </div>

                {Object.keys(errors).length > 0 && (
                  <div className="rounded-lg bg-error/10 border border-error/30 p-3 text-xs text-error space-y-1">
                    <p className="font-semibold">Corrija os erros antes de continuar:</p>
                    {errors.customer_id     && <p>• Cliente: {errors.customer_id.message}</p>}
                    {errors.sale_origin     && <p>• Origem da venda: obrigatória — volte ao passo Itens e selecione.</p>}
                    {errors.delivery_recipient && <p>• Entrega: {errors.delivery_recipient.message ?? 'endereço de entrega incompleto'} — volte ao passo Cliente.</p>}
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
                    onClick={handleFinalizarClick}
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
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-text-primary">Resumo</h3>
              {saleTypeChosen && (
                <span className={`text-[11px] font-bold tracking-wide px-2 py-0.5 rounded-full ${
                  saleType === 'wholesale' ? 'bg-purple-500/15 text-purple-400' : 'bg-blue-500/15 text-blue-400'
                }`}>
                  {saleType === 'wholesale' ? 'ATACADO' : 'VAREJO'}
                </span>
              )}
            </div>
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
                  onClick={handleFinalizarClick}
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

    </div>
  )
}
