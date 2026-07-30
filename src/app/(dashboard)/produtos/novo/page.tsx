'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'

// ─── Tipos ────────────────────────────────────────────────────────────────────

type VariationValue = { id: number; value: string; slug: string; sku_code: string | null }
type VariationType  = { id: number; name: string; slug: string; variation_values: VariationValue[] }
type CategoryAttributeLink = { required: boolean; active: boolean; variation_type: { slug: string } }

const variantRowSchema = z.object({
  sku_variation:   z.string().min(1, 'SKU obrigatório'),
  color_value_id:  z.number().nullable().optional(),
  size_value_id:   z.number().nullable().optional(),
  color_label:     z.string().optional(),
  size_label:      z.string().optional(),
  price_override:  z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().positive().nullable().optional()),
  cost_override:   z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().min(0).nullable().optional()),
  initial_stock:   z.coerce.number().int().min(0).default(0),
})

const formSchema = z.object({
  name:        z.string().min(2, 'Nome obrigatório'),
  tipo:        z.string().min(1, 'Tipo obrigatório'),
  modelo:      z.string().min(1, 'Modelo obrigatório').optional(),
  modelo_value_id: z.number().int().positive().optional(),
  ano:         z.string().min(4, 'Ano obrigatório'),
  category_id: z.coerce.number({ invalid_type_error: 'Selecione uma categoria' }).int().positive('Selecione uma categoria'),
  supplier_id: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable().optional()),
  brand_id:    z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().positive().nullable().optional()),
  origin:      z.enum(['own_brand', 'third_party']),
  base_cost:   z.coerce.number().min(0),
  base_price:  z.coerce.number().positive('Preço obrigatório'),
  active:      z.boolean().default(true),
  variants:    z.array(variantRowSchema),
  ncm: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().regex(/^\d{8}$/, 'NCM deve ter exatamente 8 dígitos').nullable().optional(),
  ),
  cest: z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().regex(/^\d{2}\.\d{3}\.\d{2}$/, 'Formato CEST: 00.000.00').nullable().optional(),
  ),
  origem: z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().int().min(0).max(8).nullable().optional(),
  ),
  unidade_med: z.string().max(10).default('UN'),
})
// Obrigatoriedade de Modelo não é estática — depende do Tipo (Calcinha
// exige, Sex Shop não) e só é conhecida em runtime via modeloOptions
// (ver /api/produtos/modelo-options). Checada imperativamente em
// generateVariants(), mesmo padrão já usado para corRequired/tamanhoRequired
// — não dá pra expressar isso num schema estático sem acesso a esse estado.

type FormData = z.infer<typeof formSchema>

import { SKU_TIPO, SKU_MODELO, generateSKUFromCodes, normalizeKey } from '@/lib/sku/sku-map'
import { hasMinRole } from '@/types/roles'
import { useUserContext } from '@/components/layout/user-context'

// ─── Componente ───────────────────────────────────────────────────────────────

export default function NovoProdutoPage() {
  const router = useRouter()
  const { userRole } = useUserContext()
  useEffect(() => { if (!hasMinRole(userRole, 'gerente')) router.replace('/') }, [userRole, router])
  if (!hasMinRole(userRole, 'gerente')) return null


  const [categories,  setCategories]  = useState<{ id: number; name: string; product_type_id: number | null }[]>([])
  const [suppliers,   setSuppliers]   = useState<{ id: number; name: string }[]>([])
  const [brands,      setBrands]      = useState<{ id: number; name: string }[]>([])
  const [varTypes,    setVarTypes]    = useState<VariationType[]>([])
  const [categoryAttributes, setCategoryAttributes] = useState<CategoryAttributeLink[]>([])
  const [modeloOptions, setModeloOptions] = useState<{ governed: boolean; required: boolean; tipoSkuCode?: string; productTypeId?: number; values: VariationValue[] }>({ governed: false, required: false, values: [] })
  const [selColors,     setSelColors]     = useState<VariationValue[]>([])
  const [selSizes,      setSelSizes]      = useState<VariationValue[]>([])
  const [generated,     setGenerated]     = useState(false)
  const [newColorInput, setNewColorInput] = useState('')
  const [newSizeInput,  setNewSizeInput]  = useState('')
  const [addingColor,   setAddingColor]   = useState(false)
  const [addingSize,    setAddingSize]    = useState(false)

  const { register, handleSubmit, watch, control, setValue, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { origin: 'third_party', base_cost: 0, active: true, variants: [] },
  })

  // Lock explícito contra double-submit — cobre a janela entre o clique e
  // isSubmitting virar true, e impede retry acidental durante resposta lenta.
  const submittingRef = useRef(false)

  const { fields, replace } = useFieldArray({ control, name: 'variants' })

  const tipo = watch('tipo')
  const modelo = watch('modelo')
  const modeloValueId = watch('modelo_value_id')
  const ano = watch('ano')
  const categoryId = watch('category_id')

  // Carregar dados iniciais
  useEffect(() => {
    fetch('/api/categorias').then(r => r.json()).then(({ categories }) => setCategories(categories ?? []))
    fetch('/api/fornecedores').then(r => r.json()).then(({ suppliers }) => setSuppliers(suppliers ?? []))
    fetch('/api/marcas?active=true').then(r => r.json()).then(({ brands }) => setBrands(brands ?? []))
    fetch('/api/variacoes').then(r => r.json()).then(({ types }) => setVarTypes(types ?? []))
  }, [])

  // Modelo dinâmico por Tipo (Fase G acelerada — hoje só Calcinha tem
  // Modelo governado via type_attributes). Troca de Tipo sempre limpa a
  // seleção anterior de Modelo (texto e id) pra nunca ficar com um valor
  // de um Tipo diferente do que está selecionado agora.
  useEffect(() => {
    setValue('modelo', undefined)
    setValue('modelo_value_id', undefined)
    if (!tipo) { setModeloOptions({ governed: false, required: false, values: [] }); return }
    fetch(`/api/produtos/modelo-options?tipo=${encodeURIComponent(tipo)}`)
      .then(r => r.json())
      .then(json => setModeloOptions({
        governed: !!json.governed,
        required: !!json.required,
        tipoSkuCode: json.tipoSkuCode,
        productTypeId: json.productTypeId,
        values: json.values ?? [],
      }))
      .catch(() => setModeloOptions({ governed: false, required: false, values: [] }))
  }, [tipo, setValue])

  // Atributos obrigatórios da categoria selecionada (cor/tamanho apenas —
  // únicos variation_types com UI de seleção hoje). Sem categoria
  // selecionada, sem configuração para ela, ou em caso de falha de rede,
  // fica em [] — mantém o comportamento atual (nada obrigatório).
  useEffect(() => {
    if (!categoryId) { setCategoryAttributes([]); return }
    fetch(`/api/category-attributes?category_id=${categoryId}&active=true`)
      .then(r => r.json())
      .then(json => setCategoryAttributes(json.category_attributes ?? []))
      .catch(() => setCategoryAttributes([]))
  }, [categoryId])

  const colorType  = varTypes.find(t => t.slug === 'cor')
  const sizeType   = varTypes.find(t => t.slug === 'tamanho')
  const otherTypes = varTypes.filter(t => t.slug !== 'cor' && t.slug !== 'tamanho')

  // Categorias visíveis: se o Tipo selecionado já tem categorias reais
  // ligadas (product_type_id preenchido — hoje só Sex Shop), mostra só
  // essas, escondendo as legadas (evita categorizar um produto de Sex Shop
  // como "Calcinha" por engano). Se o Tipo ainda não tem nenhuma categoria
  // ligada (Calcinha e todo o resto, ainda sem backfill), cai de volta na
  // lista legada completa — nunca fica vazio por falta de backfill.
  const categoriesForTipo = categories.filter(c => c.product_type_id != null && c.product_type_id === modeloOptions.productTypeId)
  const visibleCategories = categoriesForTipo.length > 0
    ? categoriesForTipo
    : categories.filter(c => c.product_type_id == null)

  const corRequired     = categoryAttributes.some(ca => ca.required && ca.variation_type?.slug === 'cor')
  const tamanhoRequired = categoryAttributes.some(ca => ca.required && ca.variation_type?.slug === 'tamanho')

  // Gerar matriz de variantes
  const generateVariants = useCallback(() => {
    const hasColors = selColors.length > 0
    const hasSizes  = selSizes.length > 0

    // Produto sem Cor nem Tamanho é um caso válido (lubrificante, óleo de
    // massagem) — gera uma única linha neutra, não bloqueia mais. Segue
    // pra baixo em vez de retornar cedo.

    if (!tipo) {
      toast.error('Selecione o Tipo do produto antes de gerar SKUs')
      return
    }

    if (corRequired && !hasColors) {
      toast.error('Cor é obrigatória para esta categoria', { description: 'Selecione ao menos uma cor antes de gerar a matriz.' })
      return
    }
    if (tamanhoRequired && !hasSizes) {
      toast.error('Tamanho é obrigatório para esta categoria', { description: 'Selecione ao menos um tamanho antes de gerar a matriz.' })
      return
    }

    // Prévia de SKU — usa o sku_code já resolvido pelo banco (via /api/variacoes).
    // Se ainda não houver código atribuído para o valor, mostra um placeholder:
    // o SKU real é sempre calculado pelo servidor no momento do submit, nunca
    // a partir deste campo (a prévia não é enviada ao backend).
    function previewSku(corCode: string | null | undefined, tamanhoCode: string | null | undefined): string {
      if (corCode === null || tamanhoCode === null) return '(gerado ao salvar)'
      try {
        if (modeloOptions.governed) {
          // Caminho dinâmico: prévia simples por concatenação (mesma forma
          // final TTMMCCTTAA) — o SKU real é sempre recalculado no servidor.
          const modeloValue = modeloOptions.values.find(v => v.id === modeloValueId)
          if (!modeloOptions.tipoSkuCode || !modeloValue?.sku_code || !corCode || !tamanhoCode) return '(gerado ao salvar)'
          return `${modeloOptions.tipoSkuCode}${modeloValue.sku_code}${corCode}${tamanhoCode}${ano?.slice(-2) ?? ''}`
        }
        return generateSKUFromCodes({ tipo, modelo: modelo!, corCode: corCode ?? undefined, tamanhoCode: tamanhoCode ?? undefined, ano })
      } catch {
        return '(gerado ao salvar)'
      }
    }

    const rows: FormData['variants'] = []

    if (hasColors && hasSizes) {
      selColors.forEach(color => {
        selSizes.forEach(size => {
          rows.push({
            sku_variation:  previewSku(color.sku_code, size.sku_code),
            color_value_id: color.id,
            size_value_id:  size.id,
            color_label:    color.value,
            size_label:     size.value,
            price_override: null,
            cost_override:  null,
            initial_stock:  0,
          })
        })
      })
    } else if (hasColors) {
      selColors.forEach(color => {
        rows.push({
          sku_variation:  previewSku(color.sku_code, undefined),
          color_value_id: color.id,
          size_value_id:  null,
          color_label:    color.value,
          size_label:     undefined,
          price_override: null,
          cost_override:  null,
          initial_stock:  0,
        })
      })
    } else if (hasSizes) {
      selSizes.forEach(size => {
        rows.push({
          sku_variation:  previewSku(undefined, size.sku_code),
          color_value_id: null,
          size_value_id:  size.id,
          color_label:    undefined,
          size_label:     size.value,
          price_override: null,
          cost_override:  null,
          initial_stock:  0,
        })
      })
    } else {
      // Produto simples — sem Cor nem Tamanho (lubrificante, óleo de
      // massagem). Uma única variação interna com códigos neutros ('00'),
      // nunca aparece como Cor/Tamanho falso na interface.
      rows.push({
        sku_variation:  previewSku(undefined, undefined),
        color_value_id: null,
        size_value_id:  null,
        color_label:    undefined,
        size_label:     undefined,
        price_override: null,
        cost_override:  null,
        initial_stock:  0,
      })
    }

    replace(rows)
    setGenerated(true)
    toast.success(`${rows.length} variante${rows.length > 1 ? 's' : ''} gerada${rows.length > 1 ? 's' : ''}`)
  }, [selColors, selSizes, tipo, modelo, modeloValueId, modeloOptions, ano, replace, corRequired, tamanhoRequired])

  function toggleColor(v: VariationValue) {
    setSelColors(prev => prev.find(c => c.id === v.id) ? prev.filter(c => c.id !== v.id) : [...prev, v])
    setGenerated(false)
  }

  function toggleSize(v: VariationValue) {
    setSelSizes(prev => prev.find(s => s.id === v.id) ? prev.filter(s => s.id !== v.id) : [...prev, v])
    setGenerated(false)
  }

  async function addNewVariationValue(
    rawValue: string,
    typeId: number | undefined,
    existing: VariationValue[],
    onAdd: (v: VariationValue) => void,
    setInput: (s: string) => void,
    setLoading: (b: boolean) => void,
  ) {
    const trimmed = rawValue.trim()
    if (!trimmed || !typeId) return

    const key = normalizeKey(trimmed)

    // Se já está nos variation_values do banco, apenas seleciona
    const found = existing.find(v => normalizeKey(v.value) === key)
    if (found) {
      onAdd(found)
      setInput('')
      return
    }

    // Novo — persiste no banco
    setLoading(true)
    try {
      const res = await fetch('/api/variacoes/valores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variation_type_id: typeId, value: trimmed }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error('Erro ao adicionar valor', { description: json.error })
        return
      }
      const newVal = json.value as VariationValue
      setVarTypes(prev => prev.map(t =>
        t.id === typeId ? { ...t, variation_values: [...t.variation_values, newVal] } : t,
      ))
      onAdd(newVal)
      setInput('')
      toast.success(`"${trimmed}" adicionado`)
    } finally {
      setLoading(false)
    }
  }

  function handleAddColor() {
    addNewVariationValue(
      newColorInput, colorType?.id,
      colorType?.variation_values ?? [],
      v => { setSelColors(prev => prev.some(c => c.id === v.id) ? prev : [...prev, v]); setGenerated(false) },
      setNewColorInput, setAddingColor,
    )
  }

  function handleAddSize() {
    addNewVariationValue(
      newSizeInput, sizeType?.id,
      sizeType?.variation_values ?? [],
      v => { setSelSizes(prev => prev.some(s => s.id === v.id) ? prev : [...prev, v]); setGenerated(false) },
      setNewSizeInput, setAddingSize,
    )
  }

  // Submit
  async function onSubmit(data: FormData) {
    if (submittingRef.current) return
    submittingRef.current = true

    try {
      if (data.variants.length === 0) {
        toast.error('Gere ao menos uma variante antes de salvar')
        return
      }

      const res = await fetch('/api/produtos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          category_id: Number(data.category_id),
          supplier_id: data.supplier_id ? Number(data.supplier_id) : null,
          brand_id:    data.brand_id ? Number(data.brand_id) : null,
          base_cost:   Number(data.base_cost),
          base_price:  Number(data.base_price),
        }),
      })

      const json = await res.json()

      if (res.status === 409) {
        // Produto já existe — oferece link para editar o existente
        toast.error('Produto duplicado', {
          description: json.error,
          action: json.existingId
            ? { label: 'Ver produto', onClick: () => router.push(`/produtos/${json.existingId}`) }
            : undefined,
        })
        return
      }

      if (!res.ok) {
        toast.error('Erro ao cadastrar produto', { description: json.error })
        return
      }

      toast.success('Produto cadastrado com sucesso!')
      router.refresh()
      router.push(`/produtos/${json.product.id}`)
    } finally {
      submittingRef.current = false
    }
  }

  const baseCost  = Number(watch('base_cost')) || 0
  const basePrice = Number(watch('base_price')) || 0
  const margin    = basePrice > 0 ? ((basePrice - baseCost) / basePrice) * 100 : 0

  return (
    <div className="max-w-5xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/produtos">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Novo Produto</h2>
          <p className="text-sm text-text-muted">Preencha os dados e gere a grade de variantes</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">

        {/* ── Seção 1: Dados do Produto ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">Informações do Produto</h3>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <Input label="Nome do produto" required placeholder="Ex: Body de Renda Floral" error={errors.name?.message} {...register('name')} />
            <Select label="Tipo" required error={errors.tipo?.message} {...register('tipo')}>
              <option value="">Selecione...</option>
              {Object.keys(SKU_TIPO).map(k => <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.replace(/_/g, ' ').slice(1)}</option>)}
            </Select>
            {modeloOptions.governed ? (
              // Caminho dinâmico (Fase G acelerada — hoje só Calcinha): valores
              // vêm de variation_values via type_attributes, não do mapa
              // estático. modelo_value_id é o que o servidor usa pra resolver
              // o segmento MM do SKU; "modelo" (texto) fica de fora do form.
              <Select
                label="Modelo"
                required={modeloOptions.required}
                error={errors.modelo?.message}
                disabled={!tipo}
                value={watch('modelo_value_id') ?? ''}
                onChange={e => setValue('modelo_value_id', e.target.value ? Number(e.target.value) : undefined)}
              >
                <option value="">Selecione...</option>
                {modeloOptions.values.map(v => (
                  <option key={v.id} value={v.id}>{v.value}</option>
                ))}
              </Select>
            ) : (
              <Select label="Modelo" required error={errors.modelo?.message} {...register('modelo')} disabled={!tipo}>
                <option value="">Selecione...</option>
                {tipo ? (
                  (() => {
                    const tt = SKU_TIPO[tipo as keyof typeof SKU_TIPO]
                    const models = SKU_MODELO[tt]
                    if (!models) return <option value="" disabled>Sem modelos disponíveis para este tipo</option>

                    return Object.keys(models).map(k => (
                      <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.replace(/_/g, ' ').slice(1)}</option>
                    ))
                  })()
                ) : null}
              </Select>
            )}
            <Select label="Ano" required error={errors.ano?.message} {...register('ano')}>
              <option value="">Selecione...</option>
              <option value="2023">2023</option>
              <option value="2024">2024</option>
              <option value="2025">2025</option>
              <option value="2026">2026</option>
            </Select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Select label="Categoria" required error={errors.category_id?.message} {...register('category_id')}>
              <option value="">Selecione a categoria</option>
              {visibleCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select label="Fornecedor" {...register('supplier_id')}>
              <option value="">Sem fornecedor</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select label="Marca" {...register('brand_id')}>
              <option value="">Sem marca</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>

          <Select label="Origem do produto" required {...register('origin')}>
            <option value="third_party">Terceiro (comprado de fornecedor)</option>
            <option value="own_brand">Marca Própria (produção interna)</option>
          </Select>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input label="Custo base (R$)" type="number" step="0.01" min="0" placeholder="0,00" error={errors.base_cost?.message} {...register('base_cost')} />
            <Input label="Preço de venda base (R$)" required type="number" step="0.01" min="0.01" placeholder="0,00" error={errors.base_price?.message} {...register('base_price')} />
            <div>
              <label className="label-base">Margem calculada</label>
              <div className={`input-base pointer-events-none font-semibold ${margin >= 40 ? 'text-success' : margin >= 25 ? 'text-warning' : margin > 0 ? 'text-error' : 'text-text-muted'}`}>
                {basePrice > 0 ? `${margin.toFixed(1)}%` : '—'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input type="checkbox" id="active" defaultChecked className="w-4 h-4 rounded border-border bg-bg-input accent-brand" {...register('active')} />
            <label htmlFor="active" className="text-sm text-text-primary cursor-pointer">Produto ativo (visível nas vendas)</label>
          </div>
        </div>

        {/* ── Seção 1b: Dados Fiscais ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">
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

        {/* ── Seção 2: Seleção de Atributos ── */}
        <div className="card p-6 space-y-5">
          <h3 className="text-sm font-semibold text-text-primary border-b border-border pb-3">Grade de Variantes</h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {/* Cores */}
            {colorType && (
              <div>
                <label className="label-base mb-2 block">
                  Cores{corRequired && <span className="text-error"> *</span>} <span className="text-text-muted font-normal">(clique para selecionar)</span>
                </label>
                {corRequired && <p className="text-xs text-error -mt-1 mb-2">Obrigatório para esta categoria</p>}
                <div className="flex flex-wrap gap-2">
                  {colorType.variation_values.map(v => {
                    const active = selColors.some(c => c.id === v.id)
                    return (
                      <button key={v.id} type="button" onClick={() => toggleColor(v)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${active ? 'bg-brand text-white border-brand' : 'bg-bg-overlay text-text-secondary border-border hover:border-brand'}`}>
                        {v.value}
                      </button>
                    )
                  })}
                </div>
                {selColors.length > 0 && <p className="text-xs text-text-muted mt-2">{selColors.length} cor{selColors.length > 1 ? 'es' : ''} selecionada{selColors.length > 1 ? 's' : ''}</p>}
                {/* Adicionar nova cor */}
                <datalist id="cores-validas">
                  {(colorType?.variation_values ?? []).map(v => <option key={v.id} value={v.value} />)}
                </datalist>
                <div className="flex gap-2 mt-3">
                  <input
                    list="cores-validas"
                    value={newColorInput}
                    onChange={e => setNewColorInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddColor() } }}
                    placeholder="Outra cor... (ex: Cinza, Coral)"
                    className="input-base text-sm flex-1"
                  />
                  <Button type="button" variant="secondary" size="sm" loading={addingColor} onClick={handleAddColor}>
                    <Plus className="w-3 h-3" />
                    Adicionar
                  </Button>
                </div>
              </div>
            )}

            {/* Tamanhos */}
            {sizeType && (
              <div>
                <label className="label-base mb-2 block">
                  Tamanhos{tamanhoRequired && <span className="text-error"> *</span>} <span className="text-text-muted font-normal">(clique para selecionar)</span>
                </label>
                {tamanhoRequired && <p className="text-xs text-error -mt-1 mb-2">Obrigatório para esta categoria</p>}
                <div className="flex flex-wrap gap-2">
                  {sizeType.variation_values.map(v => {
                    const active = selSizes.some(s => s.id === v.id)
                    return (
                      <button key={v.id} type="button" onClick={() => toggleSize(v)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${active ? 'bg-brand text-white border-brand' : 'bg-bg-overlay text-text-secondary border-border hover:border-brand'}`}>
                        {v.value}
                      </button>
                    )
                  })}
                </div>
                {selSizes.length > 0 && <p className="text-xs text-text-muted mt-2">{selSizes.length} tamanho{selSizes.length > 1 ? 's' : ''} selecionado{selSizes.length > 1 ? 's' : ''}</p>}
                {/* Adicionar novo tamanho */}
                <datalist id="tamanhos-validos">
                  {(sizeType?.variation_values ?? []).map(v => <option key={v.id} value={v.value} />)}
                </datalist>
                <div className="flex gap-2 mt-3">
                  <input
                    list="tamanhos-validos"
                    value={newSizeInput}
                    onChange={e => setNewSizeInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddSize() } }}
                    placeholder="Outro tamanho... (ex: PP, XGG)"
                    className="input-base text-sm flex-1"
                  />
                  <Button type="button" variant="secondary" size="sm" loading={addingSize} onClick={handleAddSize}>
                    <Plus className="w-3 h-3" />
                    Adicionar
                  </Button>
                </div>
              </div>
            )}

            {/* Outros tipos de variação */}
            {otherTypes.map(type => (
              <div key={type.id}>
                <label className="label-base mb-2 block">{type.name}</label>
                <div className="flex flex-wrap gap-2">
                  {type.variation_values.map(v => (
                    <span key={v.id} className="px-3 py-1.5 rounded-full text-xs font-medium border border-border bg-bg-overlay text-text-muted">{v.value}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Botão gerar */}
          <div className="flex items-center gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={generateVariants} disabled={!tipo}>
              <RefreshCw className="w-4 h-4" />
              {generated ? 'Regerar Matriz' : selColors.length === 0 && selSizes.length === 0 ? 'Gerar Produto Simples' : 'Gerar Matriz de Variantes'}
            </Button>
            {generated && (
              <span className="text-sm text-text-muted">{fields.length} variante{fields.length > 1 ? 's' : ''} • clique em "Regerar" para atualizar após mudar seleção</span>
            )}
          </div>
        </div>

        {/* ── Seção 3: Tabela de Variantes ── */}
        {fields.length > 0 && (
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">
                Matriz de SKUs <span className="text-text-muted font-normal">({fields.length} variantes)</span>
              </h3>
              <p className="text-xs text-text-muted">Preço/custo em branco = usa o valor base do produto</p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-bg-overlay border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted">Variante</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-48">SKU</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-32">Custo (R$)</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-32">Preço (R$)</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-muted w-28">Estoque Inicial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {fields.map((field, idx) => (
                    <tr key={field.id} className="hover:bg-bg-overlay/50 transition-colors">
                      {/* Label da variante */}
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1">
                          {field.color_label && (
                            <span className="px-2 py-0.5 rounded-full bg-brand/10 text-brand text-xs font-medium">{field.color_label}</span>
                          )}
                          {field.size_label && (
                            <span className="px-2 py-0.5 rounded-full bg-bg-overlay border border-border text-text-secondary text-xs font-medium">{field.size_label}</span>
                          )}
                          {!field.color_label && !field.size_label && (
                            <span className="text-xs text-text-muted italic">Produto simples (sem variação)</span>
                          )}
                        </div>
                      </td>

                      {/* SKU */}
                      <td className="px-4 py-2">
                        <input
                          readOnly
                          className="input-base text-xs font-mono py-1.5 w-full bg-bg-overlay/50 cursor-not-allowed text-text-muted"
                          {...register(`variants.${idx}.sku_variation`)}
                        />
                        {errors.variants?.[idx]?.sku_variation && (
                          <p className="text-xs text-error mt-0.5">{errors.variants[idx]?.sku_variation?.message}</p>
                        )}
                      </td>

                      {/* Custo override */}
                      <td className="px-4 py-2">
                        <input
                          type="number" step="0.01" min="0"
                          placeholder={`${baseCost.toFixed(2)}`}
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.cost_override`)}
                        />
                      </td>

                      {/* Preço override */}
                      <td className="px-4 py-2">
                        <input
                          type="number" step="0.01" min="0"
                          placeholder={`${basePrice.toFixed(2)}`}
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.price_override`)}
                        />
                      </td>

                      {/* Estoque inicial */}
                      <td className="px-4 py-2">
                        <input
                          type="number" min="0"
                          className="input-base text-xs py-1.5 w-full"
                          {...register(`variants.${idx}.initial_stock`)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Linha de totais */}
            <div className="px-5 py-3 border-t border-border bg-bg-overlay flex items-center gap-6 text-xs text-text-muted">
              <span><strong className="text-text-primary">{fields.length}</strong> variantes</span>
              <span><strong className="text-text-primary">{selColors.length}</strong> cores × <strong className="text-text-primary">{selSizes.length || 1}</strong> tamanhos</span>
            </div>
          </div>
        )}

        {/* ── Ações ── */}
        <div className="flex gap-3">
          <Link href="/produtos" className="flex-1">
            <Button type="button" variant="secondary" className="w-full">Cancelar</Button>
          </Link>
          <Button type="submit" loading={isSubmitting} className="flex-1" disabled={fields.length === 0 || isSubmitting}>
            <Plus className="w-4 h-4" />
            Salvar Produto ({fields.length} variante{fields.length !== 1 ? 's' : ''})
          </Button>
        </div>

      </form>
    </div>
  )
}
