'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Trash2, Plus, ChevronDown } from 'lucide-react'
import { productEditSchema, type ProductEditFormData } from '@/lib/validators'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ProductMediaManager } from '../../_components/product-media'

// ── Types ──────────────────────────────────────────────────────────────────────

type AttributeRow = {
  variation_type_id: number
  variation_value_id: number
  variation_types: { name: string; slug: string } | null
  variation_values: { value: string; slug: string } | null
}

type VariationRow = {
  id: number
  sku_variation: string
  cost_override: number | null
  price_override: number | null
  wholesale_price_override: number | null
  active: boolean
  product_variation_attributes: AttributeRow[]
}

// Edição in-place dos overrides de uma variação existente — valores como
// string (mesmo padrão de input controlado do resto do formulário) para
// permitir campo vazio sem virar "0". '' → null no submit (limpa o
// override); número → grava; nunca alterado se o usuário não tocar no campo.
type OverrideEdit = { price_override: string; wholesale_price_override: string }

type VariationValue = { id: number; value: string; slug: string; sku_code?: string | null }

type VariationType = {
  id: number
  name: string
  slug: string
  variation_values: VariationValue[]
}

type NewVariation = {
  key: string // client-only unique key
  sku_variation: string
  color_value_id: number | null
  size_value_id: number | null
  price_override: number | null
  cost_override: number | null
  wholesale_price_override: number | null
}

type CategoryAttributeLink = { required: boolean; active: boolean; variation_type: { slug: string } }

// ── Helpers ────────────────────────────────────────────────────────────────────

function attrLabel(v: VariationRow): string {
  // product_variation_attributes vem null/undefined (não []) quando a
  // variação não tem nenhum atributo (ex.: criada sem cor nem tamanho) —
  // mesmo padrão já tratado em outros 8+ pontos do projeto que consomem
  // este embed do Supabase.
  return (v.product_variation_attributes ?? [])
    .map((a) => a.variation_values?.value)
    .filter(Boolean)
    .join(' / ') || '—'
}

function fmtCurrency(n: number | null) {
  if (n == null) return 'base'
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function EditarProdutoPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState<any[]>([])
  const [suppliers, setSuppliers] = useState<any[]>([])
  const [brands, setBrands] = useState<any[]>([])

  // Variation state
  const [variations, setVariations] = useState<VariationRow[]>([])
  const [toDelete, setToDelete] = useState<number[]>([])
  const [toAdd, setToAdd] = useState<NewVariation[]>([])
  const [variationTypes, setVariationTypes] = useState<VariationType[]>([])
  const [categoryAttributes, setCategoryAttributes] = useState<CategoryAttributeLink[]>([])
  // Overrides de preço varejo/atacado das variações EXISTENTES, indexado por
  // id — inicializado a partir do banco ao carregar, editado in-place.
  const [overrideEdits, setOverrideEdits] = useState<Record<number, OverrideEdit>>({})

  // Controls whether the "add variation" form is visible
  const [showAddVariation, setShowAddVariation] = useState(false)

  // New variation form fields (uncontrolled by RHF — managed via local state)
  const [newSku, setNewSku] = useState('')
  const [newColorId, setNewColorId] = useState<number | ''>('')
  const [newSizeId, setNewSizeId] = useState<number | ''>('')
  const [newPrice, setNewPrice] = useState('')
  const [newCost, setNewCost] = useState('')
  const [newWholesalePrice, setNewWholesalePrice] = useState('')

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ProductEditFormData>({
    resolver: zodResolver(productEditSchema),
  })

  const baseCost = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin = basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0
  const categoryId = watch('category_id')
  // wholesale_price pode ser legitimamente '' (produto sem atacado) — nunca
  // tratado como 0, senão a prévia de herança das variações mentiria.
  // watch() devolve o valor cru do input (pode ser string '' mesmo o tipo
  // do schema sendo number|null — RHF não converte até o zodResolver rodar
  // no submit), daí o `any` só nesta leitura de exibição.
  const wholesalePriceRaw = watch('wholesale_price') as any
  const wholesalePrice = wholesalePriceRaw != null && wholesalePriceRaw !== '' ? Number(wholesalePriceRaw) : null

  // Atributos obrigatórios da categoria atual do formulário (cor/tamanho
  // apenas — únicos variation_types com UI de seleção hoje). Sem
  // categoria, sem configuração, ou em falha de rede, fica em [] —
  // nunca bloqueia por causa disso (fail-open).
  useEffect(() => {
    if (!categoryId) { setCategoryAttributes([]); return }
    fetch(`/api/category-attributes?category_id=${categoryId}&active=true`)
      .then(r => r.json())
      .then(json => setCategoryAttributes(json.category_attributes ?? []))
      .catch(() => setCategoryAttributes([]))
  }, [categoryId])

  useEffect(() => {
    Promise.all([
      fetch('/api/categorias').then(r => r.json()),
      fetch('/api/fornecedores').then(r => r.json()),
      fetch('/api/marcas?active=true').then(r => r.json()),
      fetch(`/api/produtos/${params.id}`).then(r => r.json()),
      fetch('/api/variacoes').then(r => r.json()),
    ]).then(([catsJson, supsJson, brandsJson, prodJson, varJson]) => {
      setCategories(catsJson.categories ?? [])
      setSuppliers(supsJson.suppliers ?? [])
      setBrands(brandsJson.brands ?? [])
      setVariationTypes(varJson.types ?? [])

      const { product, error } = prodJson
      if (error || !product) {
        toast.error('Produto não encontrado')
        router.push('/produtos')
        return
      }

      const loadedVariations: VariationRow[] = prodJson.variations ?? []
      setVariations(loadedVariations)

      // '' quando null — nunca "0" (campo vazio ≠ preço zero).
      const initialEdits: Record<number, OverrideEdit> = {}
      for (const v of loadedVariations) {
        initialEdits[v.id] = {
          price_override: v.price_override != null ? String(v.price_override) : '',
          wholesale_price_override: v.wholesale_price_override != null ? String(v.wholesale_price_override) : '',
        }
      }
      setOverrideEdits(initialEdits)

      reset({
        name: product.name ?? '',
        sku: product.sku ?? '',
        category_id: product.category_id,
        supplier_id: product.supplier_id ?? undefined,
        brand_id: (product as any).brand_id ?? undefined,
        origin: product.origin ?? 'third_party',
        base_cost: product.base_cost ?? 0,
        base_price: product.base_price ?? 0,
        // Fundação varejo/atacado — '' quando null (sem preço de atacado
        // cadastrado), nunca 0 (que seria um preço inválido/diferente).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        wholesale_price: ((product as any).wholesale_price ?? '') as any,
        active: product.active ?? true,
        ncm:         (product as any).ncm  ?? '',
        cest:        (product as any).cest ?? '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        origem:      ((product as any).origem != null ? String((product as any).origem) : '') as any,
        unidade_med: (product as any).unidade_med ?? 'UN',
      })
      setLoading(false)
    })
  }, [params.id, reset, router])

  // ── Variation handlers ───────────────────────────────────────────────────────

  function markForDelete(id: number) {
    setToDelete(prev => [...prev, id])
    setVariations(prev => prev.filter(v => v.id !== id))
  }

  function updateOverrideEdit(variationId: number, field: keyof OverrideEdit, value: string) {
    setOverrideEdits(prev => ({
      ...prev,
      [variationId]: { ...(prev[variationId] ?? { price_override: '', wholesale_price_override: '' }), [field]: value },
    }))
  }

  function addVariation() {
    if (!newSku.trim()) {
      toast.error('Informe o SKU da variação')
      return
    }

    if (corRequired && newColorId === '') {
      toast.error('Cor é obrigatória para esta categoria', { description: 'Selecione uma cor antes de adicionar a variação.' })
      return
    }
    if (tamanhoRequired && newSizeId === '') {
      toast.error('Tamanho é obrigatório para esta categoria', { description: 'Selecione um tamanho antes de adicionar a variação.' })
      return
    }

    const duplicate =
      variations.some(v => v.sku_variation === newSku.trim()) ||
      toAdd.some(v => v.sku_variation === newSku.trim())

    if (duplicate) {
      toast.error('SKU de variação já existe neste produto')
      return
    }

    setToAdd(prev => [
      ...prev,
      {
        key: `new-${Date.now()}`,
        sku_variation: newSku.trim(),
        color_value_id: newColorId !== '' ? Number(newColorId) : null,
        size_value_id: newSizeId !== '' ? Number(newSizeId) : null,
        price_override: newPrice !== '' ? Number(newPrice) : null,
        cost_override: newCost !== '' ? Number(newCost) : null,
        wholesale_price_override: newWholesalePrice !== '' ? Number(newWholesalePrice) : null,
      },
    ])

    setNewWholesalePrice('')
    setNewSku('')
    setNewColorId('')
    setNewSizeId('')
    setNewPrice('')
    setNewCost('')
  }

  function removeToAdd(key: string) {
    setToAdd(prev => prev.filter(v => v.key !== key))
  }

  // ── Submit ───────────────────────────────────────────────────────────────────
  // PUT parcial: envia só os campos presentes no payload.
  // O backend faz merge com os valores atuais do banco.

  async function onSubmit(data: ProductEditFormData) {
    const payload: Record<string, unknown> = {}
    if (data.name        !== undefined) payload.name        = data.name
    if (data.sku         !== undefined) payload.sku         = data.sku
    if (data.category_id !== undefined) payload.category_id = Number(data.category_id)
    if (data.origin      !== undefined) payload.origin      = data.origin
    if (data.base_cost   !== undefined) payload.base_cost   = Number(data.base_cost)
    if (data.base_price  !== undefined) payload.base_price  = Number(data.base_price)
    if (data.active      !== undefined) payload.active      = data.active
    if ('supplier_id' in data) payload.supplier_id = data.supplier_id ? Number(data.supplier_id) : null
    if ('brand_id' in data) payload.brand_id = data.brand_id ? Number(data.brand_id) : null
    if (data.ncm         !== undefined) payload.ncm         = data.ncm
    if (data.cest        !== undefined) payload.cest        = data.cest
    if (data.origem      !== undefined) payload.origem      = data.origem
    if (data.unidade_med !== undefined) payload.unidade_med = data.unidade_med
    if (data.wholesale_price !== undefined) payload.wholesale_price = data.wholesale_price

    // Só inclui variações no payload se houver algo a fazer
    if (toDelete.length > 0) payload.variations_to_delete = toDelete
    if (toAdd.length > 0)    payload.variations_to_add    = toAdd.map(({ key: _key, ...v }) => v)

    // Overrides de variações EXISTENTES — só entra no payload quem
    // realmente mudou (compara com o valor original carregado do banco),
    // pra não gerar updates/ruído de auditoria em variação intocada.
    const variationsToUpdate = variations
      .map((v) => {
        const edit = overrideEdits[v.id]
        if (!edit) return null
        const newPrice = edit.price_override.trim() === '' ? null : Number(edit.price_override)
        const newWholesale = edit.wholesale_price_override.trim() === '' ? null : Number(edit.wholesale_price_override)
        const priceChanged = newPrice !== (v.price_override ?? null)
        const wholesaleChanged = newWholesale !== (v.wholesale_price_override ?? null)
        if (!priceChanged && !wholesaleChanged) return null
        return { id: v.id, price_override: newPrice, wholesale_price_override: newWholesale }
      })
      .filter((x): x is { id: number; price_override: number | null; wholesale_price_override: number | null } => x !== null)

    if (variationsToUpdate.length > 0) payload.variations_to_update = variationsToUpdate

    // Log de diagnóstico ANTES do fetch — sku_variation digitado é ignorado
    // pelo servidor (gerado lá a partir de tipo/modelo/ano + cor/tamanho),
    // por isso aqui também resolvemos o sku_code real de cada cor/tamanho
    // selecionado, para comparar com o SKU final logado no servidor.
    if (toAdd.length > 0) {
      console.info('[produtos/editar] enviando novas variações', {
        produtoId: params.id,
        variacoes: toAdd.map(v => ({
          key: v.key,
          skuDigitadoIgnoradoPeloServidor: v.sku_variation,
          color_value_id: v.color_value_id,
          size_value_id:  v.size_value_id,
          corCodigo:      colorType?.variation_values.find(vv => vv.id === v.color_value_id)?.sku_code ?? null,
          tamanhoCodigo:  sizeType?.variation_values.find(vv => vv.id === v.size_value_id)?.sku_code ?? null,
          price_override: v.price_override,
          cost_override:  v.cost_override,
        })),
      })
    }

    // Leitura robusta da resposta: nunca assume JSON válido. Cobre corpo
    // vazio, HTML (erro de framework antes da rota montar o JSON), e as
    // formas conhecidas de erro: {error: string}, {error: object}, {message},
    // ou erro cru do Supabase {code, message, details, hint}.
    let res: Response
    let rawResponse = ''
    let responseData: any = null
    try {
      res = await fetch(`/api/produtos/${params.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      rawResponse = await res.text()
      try {
        responseData = rawResponse ? JSON.parse(rawResponse) : null
      } catch {
        responseData = null
      }
    } catch (e) {
      console.error('[produtos/editar] falha de rede ao salvar', {
        produtoId: params.id,
        operacao:  'update',
        variacoes: { toDelete, toAdd: toAdd.map(v => v.sku_variation) },
        mensagem:  e instanceof Error ? e.message : String(e),
      })
      toast.error('Não foi possível salvar as alterações do produto.', {
        description: 'Falha de rede ao enviar os dados.',
      })
      return
    }

    if (!res.ok) {
      const errorMessage =
        (typeof responseData?.error === 'string' && responseData.error) ||
        (typeof responseData?.message === 'string' && responseData.message) ||
        (responseData?.error && typeof responseData.error === 'object'
          ? JSON.stringify(responseData.error)
          : null) ||
        (rawResponse && !responseData ? rawResponse.slice(0, 300) : null) ||
        `Erro HTTP ${res.status}`

      console.error('[produtos/editar] erro ao salvar', {
        produtoId:   params.id,
        operacao:    'update',
        variacoes:   { toDelete, toAdd: toAdd.map(v => v.sku_variation) },
        status:      res.status,
        statusText:  res.statusText,
        rawResponse,
        responseData,
        code:        responseData?.code    ?? null,
        details:     responseData?.details ?? null,
        hint:        responseData?.hint    ?? null,
      })
      toast.error('Não foi possível salvar as alterações do produto.', {
        description: errorMessage,
      })
      return
    }

    toast.success('Produto atualizado!')
    router.push(`/produtos/${params.id}`)
    router.refresh()
  }

  // ── Derived data ─────────────────────────────────────────────────────────────

  const colorType = variationTypes.find(t => t.slug === 'cor')
  const sizeType = variationTypes.find(t => t.slug === 'tamanho')

  const corRequired     = categoryAttributes.some(ca => ca.required && ca.variation_type?.slug === 'cor')
  const tamanhoRequired = categoryAttributes.some(ca => ca.required && ca.variation_type?.slug === 'tamanho')

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-muted">Carregando produto...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <Link href={`/produtos/${params.id}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Editar Produto</h2>
          <p className="text-sm text-text-muted">Altere as informações do produto</p>
        </div>
      </div>

      <ProductMediaManager productId={Number(params.id)} />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* ── Dados base ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary">Dados do produto</h3>

          {/* Nome + SKU */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Nome do produto"
              placeholder="Ex: Body de Renda Floral"
              error={errors.name?.message}
              {...register('name')}
            />
            <Input
              label="SKU"
              placeholder="Ex: BODY-RD-001"
              error={errors.sku?.message}
              {...register('sku')}
            />
          </div>

          {/* Categoria + Fornecedor + Marca */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select
              label="Categoria"
              error={errors.category_id?.message}
              {...register('category_id')}
            >
              <option value="">Selecione a categoria</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            <Select label="Fornecedor" {...register('supplier_id')}>
              <option value="">Sem fornecedor</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
            <Select label="Marca" {...register('brand_id')}>
              <option value="">Sem marca</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </Select>
          </div>

          {/* Origem */}
          <Select label="Origem do produto" {...register('origin')}>
            <option value="third_party">Terceiro (comprado de fornecedor)</option>
            <option value="own_brand">Marca Própria (produção interna)</option>
          </Select>

          {/* Custo / Preço / Margem */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Custo (R$)"
              type="number"
              step="0.01"
              min="0"
              placeholder="0,00"
              error={errors.base_cost?.message}
              {...register('base_cost')}
            />
            <Input
              label="Preço de Venda (R$)"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0,00"
              error={errors.base_price?.message}
              {...register('base_price')}
            />
            <div>
              <label className="label-base">Margem calculada</label>
              <div
                className={`input-base pointer-events-none font-semibold ${
                  margin >= 40
                    ? 'text-success'
                    : margin >= 25
                    ? 'text-warning'
                    : margin > 0
                    ? 'text-error'
                    : 'text-text-muted'
                }`}
              >
                {basePrice > 0 ? `${margin.toFixed(1)}%` : '—'}
              </div>
            </div>
          </div>

          {/* Preço de atacado (opcional) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Preço de atacado (R$)"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="Deixe vazio se não vende no atacado"
              error={errors.wholesale_price?.message}
              {...register('wholesale_price')}
            />
          </div>

          {/* Ativo */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="active"
              className="w-4 h-4 rounded border-border bg-bg-input accent-brand"
              {...register('active')}
            />
            <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">
              Produto ativo (visível nas vendas)
            </label>
          </div>
        </div>

        {/* ── Dados Fiscais ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary">
            Dados Fiscais <span className="text-xs font-normal text-text-muted">(opcional)</span>
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="NCM"
              placeholder="00000000"
              error={errors.ncm?.message}
              {...register('ncm')}
            />
            <Input
              label="CEST"
              placeholder="00.000.00"
              error={errors.cest?.message}
              {...register('cest')}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label-base">Origem da Mercadoria</label>
              <select className="input-base" {...register('origem')}>
                <option value="">Não informado</option>
                <option value="0">0 – Nacional</option>
                <option value="1">1 – Estrangeira (importação direta)</option>
                <option value="2">2 – Estrangeira (mercado interno)</option>
                <option value="3">3 – Nacional, mais de 40% conteúdo importado</option>
                <option value="4">4 – Nacional, processos básicos produtivos</option>
                <option value="5">5 – Nacional, até 40% conteúdo importado</option>
                <option value="6">6 – Estrangeira (importação direta, sem similar nacional)</option>
                <option value="7">7 – Estrangeira (mercado interno, sem similar nacional)</option>
                <option value="8">8 – Nacional, mais de 70% conteúdo importado</option>
              </select>
              {errors.origem && <p className="text-xs text-error mt-1">{errors.origem.message}</p>}
            </div>
            <div>
              <label className="label-base">Unidade de Medida</label>
              <select className="input-base" {...register('unidade_med')}>
                <option value="UN">UN – Unidade</option>
                <option value="PAR">PAR – Par</option>
                <option value="KG">KG – Quilograma</option>
                <option value="G">G – Grama</option>
                <option value="M">M – Metro</option>
                <option value="M2">M² – Metro Quadrado</option>
                <option value="L">L – Litro</option>
                <option value="CX">CX – Caixa</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── Variações existentes ── */}
        <div className="card p-6 space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">
            Variações existentes ({variations.length})
          </h3>

          {variations.length === 0 ? (
            <p className="text-sm text-text-muted">Nenhuma variação cadastrada.</p>
          ) : (
            <div className="divide-y divide-border">
              {variations.map((v) => {
                const edit = overrideEdits[v.id] ?? { price_override: '', wholesale_price_override: '' }
                return (
                  <div key={v.id} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <code className="text-xs text-text-primary">{v.sku_variation}</code>
                      <p className="text-xs text-text-muted mb-2">
                        {attrLabel(v)} · Custo: {fmtCurrency(v.cost_override)}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="label-base text-xs">Preço varejo específico</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            placeholder={basePrice > 0 ? `base: ${basePrice.toFixed(2)}` : 'usa o preço base'}
                            className="input-base text-xs py-1.5 w-full"
                            value={edit.price_override}
                            onChange={(e) => updateOverrideEdit(v.id, 'price_override', e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="label-base text-xs">Preço atacado específico</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            placeholder="opcional"
                            className="input-base text-xs py-1.5 w-full"
                            value={edit.wholesale_price_override}
                            onChange={(e) => updateOverrideEdit(v.id, 'wholesale_price_override', e.target.value)}
                          />
                          <p className="text-xs text-text-muted mt-1">
                            {edit.wholesale_price_override.trim() !== ''
                              ? ' '
                              : wholesalePrice != null
                              ? `Usando R$ ${wholesalePrice.toFixed(2)} do produto`
                              : 'Produto sem preço de atacado — item fica bloqueado no atacado'}
                          </p>
                        </div>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => markForDelete(v.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}

          {toDelete.length > 0 && (
            <p className="text-xs text-warning">
              {toDelete.length} variação(ões) marcada(s) para exclusão ao salvar.
            </p>
          )}
        </div>

        {/* ── Adicionar variação (colapsável) ── */}
        <div className="card overflow-hidden">
          {/* Cabeçalho — sempre visível, toggle ao clicar */}
          <button
            type="button"
            className="w-full flex items-center justify-between px-6 py-4 text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors"
            onClick={() => setShowAddVariation(prev => !prev)}
          >
            <span className="flex items-center gap-2">
              <Plus className="w-4 h-4" />
              Adicionar variação
            </span>
            <ChevronDown
              className={`w-4 h-4 text-text-muted transition-transform ${showAddVariation ? 'rotate-180' : ''}`}
            />
          </button>

          {/* Formulário — só renderiza quando expandido */}
          {showAddVariation && (
            <div className="px-6 pb-6 space-y-4 border-t border-border">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4">
                {/* SKU sem `required` — validado via addVariation() */}
                <Input
                  label="SKU da variação"
                  placeholder="Ex: BODY-RD-001-P-PRETO"
                  value={newSku}
                  onChange={e => setNewSku(e.target.value)}
                />

                {colorType && (
                  <div>
                    <label className="label-base">
                      Cor{corRequired && <span className="text-error"> *</span>}
                    </label>
                    <select
                      className="input-base"
                      value={newColorId}
                      onChange={e => setNewColorId(e.target.value !== '' ? Number(e.target.value) : '')}
                    >
                      <option value="">Sem cor</option>
                      {colorType.variation_values.map(vv => (
                        <option key={vv.id} value={vv.id}>{vv.value}</option>
                      ))}
                    </select>
                    {corRequired && <p className="text-xs text-error mt-1">Obrigatório para esta categoria</p>}
                  </div>
                )}

                {sizeType && (
                  <div>
                    <label className="label-base">
                      Tamanho{tamanhoRequired && <span className="text-error"> *</span>}
                    </label>
                    <select
                      className="input-base"
                      value={newSizeId}
                      onChange={e => setNewSizeId(e.target.value !== '' ? Number(e.target.value) : '')}
                    >
                      <option value="">Sem tamanho</option>
                      {sizeType.variation_values.map(vv => (
                        <option key={vv.id} value={vv.id}>{vv.value}</option>
                      ))}
                    </select>
                    {tamanhoRequired && <p className="text-xs text-error mt-1">Obrigatório para esta categoria</p>}
                  </div>
                )}

                <Input
                  label="Custo override (R$)"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Deixe vazio para usar o base"
                  value={newCost}
                  onChange={e => setNewCost(e.target.value)}
                />

                <Input
                  label="Preço override (R$)"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="Deixe vazio para usar o base"
                  value={newPrice}
                  onChange={e => setNewPrice(e.target.value)}
                />

                <Input
                  label="Atacado override (R$)"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder={wholesalePrice != null ? `Deixe vazio para usar R$ ${wholesalePrice.toFixed(2)}` : 'Deixe vazio (produto sem atacado)'}
                  value={newWholesalePrice}
                  onChange={e => setNewWholesalePrice(e.target.value)}
                />
              </div>

              <Button type="button" variant="outline" size="sm" onClick={addVariation}>
                <Plus className="h-4 w-4 mr-1" />
                Adicionar variação
              </Button>

              {/* Fila de novas variações */}
              {toAdd.length > 0 && (
                <div className="divide-y divide-border mt-2">
                  {toAdd.map((v) => (
                    <div key={v.key} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <code className="text-xs text-text-primary">{v.sku_variation}</code>
                        <p className="text-xs text-text-muted">
                          Custo: {v.cost_override != null ? `R$ ${v.cost_override}` : 'base'} · Preço:{' '}
                          {v.price_override != null ? `R$ ${v.price_override}` : 'base'} · Atacado:{' '}
                          {v.wholesale_price_override != null ? `R$ ${v.wholesale_price_override}` : 'herda do produto'}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeToAdd(v.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-error" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Ações ── */}
        <div className="flex gap-3">
          <Link href={`/produtos/${params.id}`} className="flex-1">
            <Button type="button" variant="secondary" className="w-full">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1">
            Salvar Alterações
          </Button>
        </div>
      </form>
    </div>
  )
}
