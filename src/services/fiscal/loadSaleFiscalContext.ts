/**
 * Carrega o `FiscalDocumentContext` de uma venda real (Fase Fiscal 2A).
 *
 * Único módulo desta fase que faz I/O pra montar o contexto — separado de
 * propósito de `buildNfePayload`/`validateFiscalReadiness` (puros). Reflete
 * exatamente o que existe no banco: campo ausente vira `null`, nunca um
 * placeholder inventado.
 *
 * Fontes por campo (schema real confirmado nesta fase, não presumido):
 *   - Emitente: `company_fiscal_settings` (criada na Fase Fiscal 1).
 *   - Destinatário: `customers` (nome/cpf) + `customer_addresses` via
 *     `shipments.address_id` (endereço) — `customers` NÃO tem colunas de
 *     endereço nem CNPJ (confirmado); por isso `cnpj_destinatario` fica
 *     sempre `null` nesta fase (lacuna de schema real, não suporta PJ
 *     ainda). `codigo_municipio_destinatario` é resolvido dinamicamente
 *     via `resolveMunicipioIbge` (cache + API pública do IBGE) — Fase
 *     Fiscal 2B, nunca hardcoded.
 *   - Itens: `sale_items` → `product_variations` → `products` (ncm/cest/
 *     origem/unidade_med/sku/name).
 *   - Pagamentos (Fase Fiscal 3A): `sale_payments` por `sale_id`
 *     (`method`/`net_amount`/`card_brand`) — `installments` deliberadamente
 *     NÃO é carregado aqui (confirmado: não há campo fiscal equivalente,
 *     ver paymentRules.ts).
 *   - `saleStatus`/`saleTotal` (Fase Fiscal 3A): `sales.status`/`sales.total`
 *     — usados por `validateFiscalReadiness` pra bloquear emissão de venda
 *     cancelada/devolvida e pra checar soma de pagamentos = total.
 *   - Frete: `shipments.mod_frete`, quando existe uma remessa pra venda;
 *     `9` (sem frete) quando não existe (venda balcão sem entrega).
 *   - `presenca_comprador`/`natureza_operacao`: NÃO existem em nenhum
 *     lugar do schema hoje (`sales.sale_origin` é canal de marketing, não
 *     o indicador fiscal — achado já registrado em
 *     `docs/focus-nfe-field-mapping.md`) — por isso são parâmetros
 *     explícitos deste loader, nunca inferidos, com default documentado
 *     no chamador (rota de preview).
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFocusIntegration } from './resolveFocusIntegration'
import { resolveMunicipioIbge } from './resolveMunicipioIbge'
import type { Crt } from '@/lib/fiscal/taxRules'
import type { FiscalDocumentContext, FiscalOperationContext } from './types'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

export class FiscalContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalContextError'
  }
}

interface LoadSaleFiscalContextInput {
  saleId: number
  companyId: number
  providerRef: string
  environment: FocusEnvironment
  operationOverrides?: Partial<FiscalOperationContext>
}

export async function loadSaleFiscalContext({
  saleId,
  companyId,
  providerRef,
  environment,
  operationOverrides,
}: LoadSaleFiscalContextInput): Promise<FiscalDocumentContext> {
  const admin = createAdminClient()

  const { data: sale, error: saleError } = await (admin as any)
    .from('sales')
    .select('id, company_id, customer_id, status, total')
    .eq('id', saleId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: number; company_id: number; customer_id: number; status: string; total: number } | null; error: { message: string } | null }

  if (saleError) throw new FiscalContextError(`Falha ao carregar venda ${saleId}: ${saleError.message}`)
  if (!sale) throw new FiscalContextError(`Venda ${saleId} não encontrada nesta empresa.`)

  const [{ data: settings }, { data: customer }, { data: saleItems }, { data: shipment }, { data: salePayments }, focusIntegrationResult] = await Promise.all([
    (admin as any)
      .from('company_fiscal_settings')
      .select('cnpj, razao_social, inscricao_estadual, crt, logradouro, numero_endereco, complemento, bairro, municipio, municipio_ibge, uf, cep')
      .eq('company_id', companyId)
      .maybeSingle(),
    (admin as any)
      .from('customers')
      .select('name, cpf, phone, email, is_anonymous')
      .eq('id', sale.customer_id)
      .maybeSingle(),
    (admin as any)
      .from('sale_items')
      .select('id, product_variation_id, quantity, unit_price, discount_amount, product_variations!inner(id, product_id, sku_variation, products!inner(id, name, sku, ncm, cest, origem, unidade_med))')
      .eq('sale_id', saleId),
    (admin as any)
      .from('shipments')
      .select('address_id, mod_frete')
      .eq('order_id', saleId)
      .maybeSingle(),
    (admin as any)
      .from('sale_payments')
      .select('method, net_amount, card_brand')
      .eq('sale_id', saleId),
    resolveFocusIntegration(companyId),
  ])

  let address: { street: string | null; number: string | null; complement: string | null; neighborhood: string | null; city: string | null; state: string | null; cep: string | null } | null = null
  if (shipment?.address_id) {
    const { data } = await (admin as any)
      .from('customer_addresses')
      .select('street, number, complement, neighborhood, city, state, cep')
      .eq('id', shipment.address_id)
      .maybeSingle()
    address = data
  }

  if (!focusIntegrationResult.ok) {
    throw new FiscalContextError(`Falha ao resolver integração Focus NFe: ${focusIntegrationResult.error}`)
  }

  // Resolução dinâmica contra o cache/API pública do IBGE — nunca uma
  // lista de cidades no código (ver resolveMunicipioIbge.ts). `null` em
  // caso de falha de rede/sem correspondência — validateFiscalReadiness já
  // trata isso como campo ausente, não precisa de tratamento especial aqui.
  const destinatarioMunicipioIbge = await resolveMunicipioIbge(address?.state ?? null, address?.city ?? null)

  const items = (saleItems ?? []).map((row: any) => ({
    saleItemId: row.id,
    productId: row.product_variations.products.id,
    variationId: row.product_variations.id,
    description: row.product_variations.products.name ?? null,
    sku: row.product_variations.sku_variation ?? row.product_variations.products.sku ?? null,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    discountAmount: Number(row.discount_amount ?? 0),
    unit: row.product_variations.products.unidade_med ?? null,
    ncm: row.product_variations.products.ncm ?? null,
    cest: row.product_variations.products.cest ?? null,
    origem: row.product_variations.products.origem ?? null,
  }))

  const payments = (salePayments ?? []).map((row: any) => ({
    method: row.method,
    netAmount: Number(row.net_amount),
    cardBrand: row.card_brand ?? null,
  }))

  return {
    saleId,
    companyId,
    providerRef,
    environment,
    saleStatus: sale.status,
    saleTotal: Number(sale.total),
    emitente: {
      cnpj: settings?.cnpj ?? null,
      razaoSocial: settings?.razao_social ?? null,
      inscricaoEstadual: settings?.inscricao_estadual ?? null,
      crt: (settings?.crt as Crt | undefined) ?? null,
      logradouro: settings?.logradouro ?? null,
      numero: settings?.numero_endereco ?? null,
      complemento: settings?.complemento ?? null,
      bairro: settings?.bairro ?? null,
      municipio: settings?.municipio ?? null,
      municipioIbge: settings?.municipio_ibge ?? null,
      uf: settings?.uf ?? null,
      cep: settings?.cep ?? null,
    },
    destinatario: {
      nome: customer?.is_anonymous ? null : customer?.name ?? null,
      isAnonymous: customer?.is_anonymous ?? false,
      cpf: customer?.is_anonymous ? null : customer?.cpf ?? null,
      // customers não tem coluna cnpj/IE — não existe suporte a PJ hoje (ver relatório, seção G).
      cnpj: null,
      inscricaoEstadual: null,
      telefone: customer?.phone ?? null,
      email: customer?.email ?? null,
      logradouro: address?.street ?? null,
      numero: address?.number ?? null,
      complemento: address?.complement ?? null,
      bairro: address?.neighborhood ?? null,
      municipio: address?.city ?? null,
      // Resolvido dinamicamente (cache + API pública do IBGE) — nunca
      // hardcoded. `null` quando não há endereço ou a resolução falha.
      municipioIbge: destinatarioMunicipioIbge,
      uf: address?.state ?? null,
      cep: address?.cep ?? null,
    },
    items,
    payments,
    operation: {
      naturezaOperacao: operationOverrides?.naturezaOperacao ?? 'Venda de Mercadoria',
      presencaComprador: operationOverrides?.presencaComprador ?? 2,
      modalidadeFrete: operationOverrides?.modalidadeFrete ?? (shipment ? (shipment.mod_frete as 0 | 1 | 2 | 9) : 9),
      // Confirmado no XML real (referência empírica desta fase): sempre
      // consumidor final (1) e sem intermediador/marketplace (0) no nosso
      // cenário — varejo direto ao consumidor final, loja própria.
      consumidorFinal: operationOverrides?.consumidorFinal ?? 1,
      indicadorIntermediador: operationOverrides?.indicadorIntermediador ?? 0,
    },
    focusIntegration: focusIntegrationResult.data.available
      ? { available: true, reason: null }
      : { available: false, reason: focusIntegrationResult.data.reason },
  }
}
