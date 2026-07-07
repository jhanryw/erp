import { z } from 'zod'
import { validateCPF } from '@/lib/utils/cpf'

// ─── Campos fiscais de Produto (compartilhados) ───────────────────────────────
// Fonte única da regra de NCM/CEST/Origem — consumida aqui e pelos schemas
// server-side de criação/edição (src/app/api/produtos/route.ts e [id]/route.ts).
// Mensagem de erro é parametrizável para preservar o texto que cada consumidor
// já exibia antes desta extração (nenhum comportamento observável muda).
export function ncmFieldSchema(message?: string) {
  return z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().regex(/^\d{8}$/, message).nullable().optional(),
  )
}

export function cestFieldSchema(message?: string) {
  return z.preprocess(
    (v) => (v === '' || v == null ? null : String(v).trim()),
    z.string().regex(/^\d{2}\.\d{3}\.\d{2}$/, message).nullable().optional(),
  )
}

export function origemFieldSchema() {
  return z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().int().min(0).max(8).nullable().optional(),
  )
}

// ─── Produto ─────────────────────────────────────────────────────────────────
export const productSchema = z.object({
  name: z.string().min(2, 'Nome muito curto'),
  sku: z.string().min(2, 'SKU obrigatório').max(50),
  category_id: z.coerce.number().positive('Categoria obrigatória'),
  subcategory_id: z.coerce.number().nullable().optional(),
  collection_id: z.coerce.number().nullable().optional(),
  supplier_id: z.coerce.number().nullable().optional(),
  brand_id: z.coerce.number().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0, 'Custo deve ser ≥ 0'),
  base_price: z.coerce.number().positive('Preço deve ser > 0'),
  photo_url: z.string().url().nullable().optional(),
  active: z.boolean().default(true),
  ncm: ncmFieldSchema('NCM deve ter exatamente 8 dígitos'),
  cest: cestFieldSchema('Formato CEST: 00.000.00'),
  origem: origemFieldSchema(),
  unidade_med: z.string().max(10).default('UN'),
})

// ─── Fornecedor ───────────────────────────────────────────────────────────────
export const supplierSchema = z.object({
  name: z.string().min(2, 'Nome obrigatório'),
  document: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.preprocess(v => (v === '' || v == null ? null : v), z.string().length(2).nullable().optional()),
  notes: z.string().nullable().optional(),
  active: z.boolean().default(true),
})

// ─── Cliente ──────────────────────────────────────────────────────────────────
export const customerSchema = z.object({
  cpf: z
    .string()
    .transform((v) => v.replace(/\D/g, ''))
    .refine(validateCPF, { message: 'CPF inválido' }),
  name: z.string().min(3, 'Nome completo obrigatório'),
  phone: z.string().min(10, 'Telefone inválido').max(15),
  birth_date: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().length(2).nullable().optional(),
  origin: z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional(),
  notes: z.string().nullable().optional(),
})

// ─── Venda ───────────────────────────────────────────────────────────────────
export const saleItemSchema = z.object({
  product_variation_id: z.number().positive(),
  quantity: z.number().int().positive('Quantidade deve ser > 0'),
  unit_price: z.number().positive('Preço obrigatório'),
  unit_cost: z.number().min(0),
  discount_amount: z.number().min(0).default(0),
  total_price: z.number().min(0),
})

// ─── Pagamento individual (novo fluxo multi-pagamento) ────────────────────────
export const paymentEntrySchema = z.object({
  method:          z.enum(['pix', 'cash', 'credit_card', 'debit_card']),
  amount_tendered: z.number().positive(),
  change_amount:   z.number().min(0).default(0),
  change_method:   z.enum(['cash', 'pix']).optional(),
  net_amount:      z.number().positive(),
  installments:    z.number().int().min(1).max(12).default(1),
  card_brand:      z.string().optional(),
  acquirer:        z.string().optional(),
  metadata:        z.record(z.unknown()).default({}),
})
  .refine(d => d.amount_tendered >= d.net_amount,
    { message: 'Valor recebido deve ser ≥ valor cobrado' })
  .refine(d => Math.abs(d.amount_tendered - d.change_amount - d.net_amount) < 0.01,
    { message: 'Troco incoerente com os valores informados' })
  .refine(d => d.change_amount === 0 || d.change_method != null,
    { message: 'Informe a forma do troco' })
  .refine(d => d.change_amount === 0 || d.method === 'cash',
    { message: 'Troco só é permitido em dinheiro' })
  .refine(d => d.installments === 1 || d.method === 'credit_card',
    { message: 'Parcelamento só é permitido em cartão de crédito' })

export type PaymentEntry = z.infer<typeof paymentEntrySchema>

export const saleSchema = z.object({
  customer_id:      z.number().positive('Cliente obrigatório'),
  // payment_method: mantido para compatibilidade — derivado do método dominante no submit
  payment_method:   z.enum(['pix', 'card', 'cash', 'credit_card', 'debit_card']).optional(),
  payments:         z.array(paymentEntrySchema).min(1).optional(),
  delivery_mode:    z.enum(['pickup', 'delivery']).default('delivery'),
  sale_origin:      z.preprocess(v => (v === '' || v == null ? undefined : v), z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other'], { required_error: 'Origem obrigatória', invalid_type_error: 'Selecione uma origem válida' })),
  // 'use'      → aplica saldo existente como desconto, não gera novo cashback
  // 'accumulate' → não usa saldo, gera cashback normalmente ao fechar a venda
  cashback_action:  z.enum(['use', 'accumulate']).default('accumulate'),
  discount_amount:  z.number().min(0).default(0),
  surcharge_amount: z.number().min(0).default(0),
  cashback_used:    z.number().min(0).default(0),
  shipping_charged: z.number().min(0).default(0),
  notes:            z.string().nullable().optional(),
  items:            z.array(saleItemSchema).min(1, 'Adicione pelo menos 1 item'),
})

// ─── Entrada de Estoque ───────────────────────────────────────────────────────
export const stockLotSchema = z.object({
  product_variation_id: z.number().positive('Variação obrigatória'),
  supplier_id: z.coerce.number().nullable().optional(),
  entry_type: z.enum(['purchase', 'own_production']),
  quantity_original: z.coerce.number().int().positive('Quantidade deve ser > 0'),
  unit_cost: z.coerce.number().min(0),
  freight_cost: z.coerce.number().min(0).default(0),
  tax_cost: z.coerce.number().min(0).default(0),
  entry_date: z.string(),
  notes: z.string().nullable().optional(),
  stock_location_id: z.coerce.number().int().positive().nullable().optional(),
})

// ─── Custo de Marketing ───────────────────────────────────────────────────────
// Categorias legado (rent, salaries, operational, taxes) não são aceitas em novas entradas.
// Permanecem no enum do banco para compatibilidade com dados históricos.
export const marketingCostSchema = z.object({
  category: z.enum(['paid_traffic', 'content', 'design', 'photos', 'influencers', 'tools', 'crm_automation', 'website_landing_page', 'events', 'gifts', 'packaging', 'agency_freelancer', 'other']),
  description: z.string().min(2, 'Descrição obrigatória'),
  amount: z.coerce.number().positive('Valor deve ser > 0'),
  cost_date: z.string(),
  campaign_id: z.coerce.number().nullable().optional(),
  is_recurring: z.boolean().default(false),
  notes: z.string().nullable().optional(),
})

// ─── Edição de Produto ────────────────────────────────────────────────────────
// Todos os campos opcionais: permite PUT parcial — só os campos enviados são
// atualizados. O backend faz merge com os valores atuais do banco.
// NÃO inclui variações: gerenciamento de variações é feito por endpoint separado.
export const productEditSchema = productSchema.partial()

export type ProductFormData = z.infer<typeof productSchema>
export type ProductEditFormData = z.infer<typeof productEditSchema>
export type SupplierFormData = z.infer<typeof supplierSchema>
export type CustomerFormData = z.infer<typeof customerSchema>
export type SaleFormData = z.infer<typeof saleSchema>
export type StockLotFormData = z.infer<typeof stockLotSchema>
export type MarketingCostFormData = z.infer<typeof marketingCostSchema>

// ─── Media Hub — metadado de upload (POST /api/media) ─────────────────────────
// Valida apenas os campos texto do multipart/form-data. O arquivo em si
// (mime/tamanho) é validado no service, não aqui — allowlist depende do
// bucket-alvo, que só é decidido depois que `visibility` já foi validada.
export const mediaUploadMetaSchema = z.object({
  visibility: z.enum(['public', 'private']).default('private'),
  alt_text: z.string().max(500).nullable().optional(),
})

export type MediaUploadMetaFormData = z.infer<typeof mediaUploadMetaSchema>
