import { z } from 'zod'
import { validateCPF } from '@/lib/utils/cpf'

// ─── Produto ─────────────────────────────────────────────────────────────────
export const productSchema = z.object({
  name: z.string().min(2, 'Nome muito curto'),
  sku: z.string().min(2, 'SKU obrigatório').max(50),
  category_id: z.coerce.number().positive('Categoria obrigatória'),
  subcategory_id: z.coerce.number().nullable().optional(),
  collection_id: z.coerce.number().nullable().optional(),
  supplier_id: z.coerce.number().nullable().optional(),
  origin: z.enum(['own_brand', 'third_party']),
  base_cost: z.coerce.number().min(0, 'Custo deve ser ≥ 0'),
  base_price: z.coerce.number().positive('Preço deve ser > 0'),
  photo_url: z.string().url().nullable().optional(),
  active: z.boolean().default(true),
})

// ─── Variação de Produto ──────────────────────────────────────────────────────
// Cada variação combina até 4 dimensões: cor × tamanho × modelo × tecido
export const productVariationSchema = z.object({
  product_id: z.number().positive(),
  sku_variation: z.string().min(2, 'SKU da variação obrigatório').max(80),
  color: z.string().max(50).nullable().optional(),
  size: z.string().max(20).nullable().optional(),
  model: z.string().max(50).nullable().optional(),
  fabric: z.string().max(50).nullable().optional(),
  cost_override: z.coerce.number().min(0).nullable().optional(),
  price_override: z.coerce.number().min(0).nullable().optional(),
  photo_url: z.string().url().nullable().optional(),
  active: z.boolean().default(true),
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

export const saleSchema = z.object({
  customer_id: z.number().positive('Cliente obrigatório'),
  payment_method: z.enum(['pix', 'card', 'cash']),
  sale_origin: z.enum(['instagram', 'referral', 'paid_traffic', 'website', 'store', 'other']).nullable().optional(),
  discount_amount: z.number().min(0).default(0),
  cashback_used: z.number().min(0).default(0),
  shipping_charged: z.number().min(0).default(0),
  notes: z.string().nullable().optional(),
  items: z.array(saleItemSchema).min(1, 'Adicione pelo menos 1 item'),
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
export type ProductVariationFormData = z.infer<typeof productVariationSchema>
export type SupplierFormData = z.infer<typeof supplierSchema>
export type CustomerFormData = z.infer<typeof customerSchema>
export type SaleFormData = z.infer<typeof saleSchema>
export type StockLotFormData = z.infer<typeof stockLotSchema>
export type MarketingCostFormData = z.infer<typeof marketingCostSchema>
