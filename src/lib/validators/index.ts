import { z } from 'zod'
import { validateCPF } from '@/lib/utils/cpf'
import { brazilDate } from '@/lib/utils/date'

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

// Preço de atacado — espelha a mesma regra de base_price/price_override
// (> 0 quando informado), nunca obrigatório. Ver
// supabase/migrations/202608311200_wholesale_retail_schema_foundation.sql.
export function wholesalePriceFieldSchema() {
  return z.preprocess(
    (v) => (v === '' || v == null ? null : Number(v)),
    z.number().positive('Preço de atacado deve ser maior que zero').nullable().optional(),
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
  wholesale_price: wholesalePriceFieldSchema(),
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
  // Fundação varejo/atacado (2026-08-31): CPF deixou de ser obrigatório
  // para o cadastro existir — customers.cpf já era nullable no banco desde
  // supabase/migrations/20260521_webhook_idempotency.sql, mas a validação
  // de aplicação ainda exigia o campo. Quando informado, continua validado
  // por dígito verificador (validateCPF) — nunca aceita CPF malformado.
  cpf: z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.string()
      .transform((v) => v.replace(/\D/g, ''))
      .refine(validateCPF, { message: 'CPF inválido' })
      .nullable(),
  ),
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
  // Fase Fiscal 5C — acréscimo individual do item, simétrico a
  // discount_amount (ver sale_items.surcharge_amount).
  surcharge_amount: z.number().min(0).default(0),
  // Preço de tabela no momento da venda — puramente informativo (nunca
  // entra em nenhum total), capturado automaticamente ao adicionar o item
  // ao carrinho. Pode ser null (ex.: item sem preço de catálogo resolvido).
  list_price_snapshot: z.number().min(0).nullable().optional(),
  total_price: z.number().min(0),
})

// ─── Destinatário/endereço de entrega (Fase Fiscal 5C) ────────────────────────
// Só exigido quando delivery_mode === 'delivery' — ver refine em saleSchema.
// Snapshot imutável: estes valores, não o cadastro atual de
// customer_addresses, é o que vira sale_recipients no momento da venda.
export const deliveryRecipientSchema = z.object({
  nome:       z.string().min(2, 'Nome do destinatário obrigatório'),
  cpf:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cnpj:       z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  telefone:   z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cep:        z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  logradouro: z.string().min(1, 'Logradouro obrigatório'),
  numero:     z.string().min(1, 'Número obrigatório'),
  complemento: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  bairro:     z.string().min(1, 'Bairro obrigatório'),
  municipio:  z.string().min(1, 'Município obrigatório'),
  uf:         z.string().length(2, 'UF deve ter 2 letras'),
  // Resolvido automaticamente (ViaCEP → resolveMunicipioIbge) — nunca
  // digitado pelo vendedor. Pode chegar null se as duas camadas falharem
  // (venda de entrega ainda pode ser CONCLUÍDA sem IBGE — só a emissão de
  // NF-e fica bloqueada por validateNfeReadiness, não a venda em si).
  municipio_ibge: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().regex(/^\d{7}$/).nullable().optional()),
  // Se o destinatário foi escolhido a partir de um customer_addresses já
  // existente — rastreabilidade (sale_recipients.source_address_id), nunca
  // fonte de verdade.
  customer_address_id: z.preprocess((v) => (v === '' || v == null ? null : v), z.number().int().positive().nullable().optional()),
  // Se true e não veio de um endereço já existente, a API também cria uma
  // linha reutilizável em customer_addresses (além do snapshot imutável).
  save_as_customer_address: z.boolean().default(false),
})

// ─── Destinatário fiscal (Fase Fiscal 6 — PDV comprovante/NFC-e/NF-e) ─────────
// Tudo opcional de propósito — pode ser só um CPF (NFC-e de balcão) ou um
// bloco PJ completo (NF-e). O que é obrigatório pra emitir de verdade é
// decidido na tentativa de emissão (validateNfeReadiness/
// validateNfceReadiness), nunca aqui — este schema nunca bloqueia o envio
// do formulário da venda.
export const fiscalRecipientSchema = z.object({
  nome:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cpf:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cnpj:               z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  inscricao_estadual: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  indicador_ie:       z.preprocess((v) => (v === '' || v == null ? null : v), z.union([z.literal(1), z.literal(2), z.literal(9)]).nullable().optional()),
  telefone:           z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  cep:                z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  logradouro:         z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  numero:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  complemento:        z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  bairro:             z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  municipio:          z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  uf:                 z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  municipio_ibge:     z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
  ibge_source:        z.preprocess((v) => (v === '' || v == null ? null : v), z.enum(['viacep', 'resolve_municipio_ibge', 'manual_confirmado']).nullable().optional()),
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
  // PDV atacado/varejo (2026-09-02) — modalidade COMERCIAL da venda,
  // escolhida explicitamente no Passo 0 (Itens), antes de buscar produtos.
  // sales_channel NÃO é um campo deste formulário — o PDV sempre grava
  // 'pos' no servidor, nunca escolhido pelo usuário (ver POST /api/vendas).
  sale_type:        z.enum(['retail', 'wholesale']).default('retail'),
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
  // Fase Fiscal 5C — obrigatório operacionalmente quando delivery_mode ===
  // 'delivery' (ver refine abaixo); ausente/ignorado em retirada.
  delivery_recipient: deliveryRecipientSchema.nullable().optional(),
  // Fase Fiscal 7 — Documento fiscal do fechamento do PDV. 'auto' (novo
  // default) deixa a emissão automática decidir (ver
  // resolveFiscalOperation, a partir da política em Configurações → Fiscal); 'none'/'nfce'/'nfe' continuam como
  // override explícito do operador.
  fiscal_document_type: z.enum(['auto', 'none', 'nfce', 'nfe']).default('auto'),
  fiscal_recipient:     fiscalRecipientSchema.nullable().optional(),
}).refine(
  (d) => d.delivery_mode !== 'delivery' || d.delivery_recipient != null,
  { message: 'Endereço de entrega obrigatório para venda com entrega.', path: ['delivery_recipient'] }
)

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

// ─── Media Hub — vínculo de mídia com entidade (POST /api/media/[publicId]/usages) ───
// `role` aceita aqui todo o vocabulário do banco (CHECK amplo); o subconjunto
// permitido por entity_type (ex: shipment só aceita 'proof') é regra de
// negócio contextual, validada no service — não faz sentido travar no Zod
// porque depende de outro campo do mesmo payload.
export const mediaUsageSchema = z.object({
  entity_type: z.enum(['product', 'product_variation', 'shipment', 'company']),
  entity_id: z.coerce.string().regex(/^\d+$/, 'entity_id deve ser um inteiro positivo'),
  role: z.enum(['primary', 'gallery', 'logo', 'banner', 'avatar', 'proof', 'attachment', 'document']).default('gallery'),
  position: z.coerce.number().int().min(0).optional(),
})

export type MediaUsageFormData = z.infer<typeof mediaUsageSchema>

// ─── Lançamento Financeiro ─────────────────────────────────────────────────────
// Fonte única consumida por novo/page.tsx, [id]/editar/page.tsx e pelas rotas
// server-side POST/PUT de /api/financeiro/lancamentos (Entrega 2 — correção
// Caixa × Financeiro).
//
// payment_method/paid_at são obrigatórios juntos para despesas (type='expense'):
// despesa lançada manualmente aqui é sempre um pagamento já feito — não existe
// "despesa pendente" neste fluxo (Contas a Pagar pertence a um módulo futuro).
//
// Para receitas (type='income') os dois campos são opcionais — uma venda pode
// ficar pendente de recebimento — mas nunca isolados: a constraint de banco
// fe_payment_method_paid_at_together exige os dois juntos ou nenhum, então o
// superRefine abaixo espelha essa regra também para receita, não só despesa.
//
// paid_at não pode ser data futura: comparação de string 'yyyy-MM-dd' contra
// brazilDate() (fuso fixo America/Fortaleza), mesmo formato de reference_date.
//
// cash_movement_id NÃO faz parte deste schema propositalmente — é preenchido
// só pela futura RPC de regularização (Entrega 3) ou pela futura automação do
// Caixa (Entrega 4), nunca pela API pública de lançamentos. .strict() garante
// que um payload tentando enviar esse campo (ou qualquer outro não previsto)
// seja rejeitado explicitamente, em vez de ser silenciosamente ignorado.
export const financeEntrySchema = z
  .object({
    type: z.enum(['income', 'expense']),
    category: z.enum([
      'sale', 'cashback_used', 'other_income',
      'stock_purchase', 'freight_cost', 'marketing',
      'rent', 'salaries', 'operational', 'taxes', 'other_expense',
    ]),
    description: z.string().min(2, 'Descrição obrigatória'),
    amount: z.coerce.number().positive('Valor deve ser > 0'),
    reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de competência inválida'),
    notes: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().nullable().optional()),
    payment_method: z.preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.enum(['cash', 'pix', 'credit_card', 'debit_card']).optional(),
    ),
    paid_at: z.preprocess(
      (v) => (v === '' || v == null ? undefined : v),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data de pagamento inválida').optional(),
    ),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.type === 'expense') {
      if (!data.payment_method) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payment_method'],
          message: 'Forma de pagamento obrigatória para despesas.',
        })
      }
      if (!data.paid_at) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['paid_at'],
          message: 'Data de pagamento obrigatória para despesas.',
        })
      }
    } else {
      // Receita: payment_method e paid_at podem ficar os dois vazios (venda
      // pendente), mas nunca só um dos dois — mesma regra de
      // fe_payment_method_paid_at_together, do lado do formulário.
      if (data.payment_method && !data.paid_at) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['paid_at'],
          message: 'Informe a data de recebimento para registrar o pagamento.',
        })
      }
      if (!data.payment_method && data.paid_at) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payment_method'],
          message: 'Informe a forma de pagamento para registrar o recebimento.',
        })
      }
    }
    if (data.paid_at && data.paid_at > brazilDate()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paid_at'],
        message: 'Data de pagamento não pode ser no futuro.',
      })
    }
  })

export type FinanceEntryFormData = z.infer<typeof financeEntrySchema>

// Normalização centralizada do par payment_method/paid_at antes de persistir
// em finance_entries — usada por POST e PUT de /api/financeiro/lancamentos.
// Existe porque `parsed.data.payment_method` pode ser `undefined` (campo não
// preenchido): espalhar isso direto num payload de update do supabase-js faz
// o JSON.stringify da requisição OMITIR a chave inteira, e o UPDATE então
// preserva o valor antigo da coluna em vez de limpá-la — é assim que uma
// edição "recebido → pendente" (só paid_at explicitamente nulado,
// payment_method omitido e mantido) violava fe_payment_method_paid_at_together.
// Forçar `?? null` nos dois campos, sempre juntos, elimina essa classe de bug.
export function normalizeFinanceEntryPayment(data: FinanceEntryFormData): {
  payment_method: FinanceEntryFormData['payment_method'] | null
  paid_at: string | null
} {
  return {
    payment_method: data.payment_method ?? null,
    paid_at: data.paid_at ?? null,
  }
}
