/**
 * Snapshot fiscal em memória — Fase Fiscal 2A, seção 9 do pedido.
 *
 * Produz o formato exato de `fiscal_document_items` (mesma migration da
 * Fase 1) a partir do mesmo `FiscalDocumentContext` usado por
 * `buildNfePayload` — reaproveita as mesmas funções puras de `taxRules.ts`
 * pra CFOP/CSOSN, nunca duplica a regra.
 *
 * NENHUMA persistência acontece aqui — devolve os objetos prontos pra um
 * futuro `INSERT INTO fiscal_documents/fiscal_document_items`, só depois
 * que uma emissão real acontecer (fora de escopo desta fase). Chamar isso
 * hoje serve só pra montar/testar o snapshot em memória.
 */

import { resolveCfop, resolveIcmsCsosn, resolvePisCofinsCst, resolveIpiTreatment, resolveIbsCbsTestYear2026 } from '@/lib/fiscal/taxRules'
import { FiscalBuildError } from './buildNfePayload'
import type { FiscalDocumentContext } from './types'

export interface FiscalDocumentHeaderSnapshot {
  company_id: number
  sale_id: number
  document_type: 'nfe'
  provider: 'focus_nfe'
  environment: string
  provider_ref: string
  status: 'draft'
}

export interface FiscalDocumentItemSnapshot {
  sale_item_id: number
  product_id: number
  variation_id: number | null
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_amount: number
  total_amount: number
  ncm: string
  cest: string | null
  origem: number
  cfop: string
  csosn_cst: string
  tax_details: {
    icms_origem: number
    pis_cst: string
    cofins_cst: string
    ipi_cst: string
    ipi_codigo_enquadramento_legal: string
    ibs_cbs_situacao_tributaria: string
    ibs_cbs_classificacao_tributaria: string
    ibs_uf_aliquota: number
    ibs_mun_aliquota: number
    cbs_aliquota: number
    ibs_valor_total: number
    cbs_valor: number
  }
}

export interface FiscalDocumentSnapshot {
  header: FiscalDocumentHeaderSnapshot
  items: FiscalDocumentItemSnapshot[]
}

function requireField<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new FiscalBuildError(`buildFiscalDocumentSnapshot: campo obrigatório ausente — ${label}.`)
  }
  return value
}

export function buildFiscalDocumentSnapshot(ctx: FiscalDocumentContext): FiscalDocumentSnapshot {
  const crt = requireField(ctx.emitente.crt, 'emitente.crt')
  const originUf = requireField(ctx.emitente.uf, 'emitente.uf')
  const destinationUf = requireField(ctx.destinatario.uf, 'destinatario.uf')

  const items: FiscalDocumentItemSnapshot[] = ctx.items.map((item) => {
    const label = item.sku ?? `sale_item_id=${item.saleItemId}`
    const cfop = resolveCfop({ originUf, destinationUf, crt })
    const csosn = resolveIcmsCsosn(crt)
    const pisCofins = resolvePisCofinsCst(crt)
    const ipi = resolveIpiTreatment()
    const ibsCbs = resolveIbsCbsTestYear2026()

    return {
      sale_item_id: item.saleItemId,
      product_id: item.productId,
      variation_id: item.variationId,
      description: requireField(item.description, `items[${label}].description`),
      quantity: item.quantity,
      unit: requireField(item.unit, `items[${label}].unit`),
      unit_price: item.unitPrice,
      discount_amount: item.discountAmount,
      total_amount: Math.round((item.unitPrice * item.quantity - item.discountAmount) * 100) / 100,
      ncm: requireField(item.ncm, `items[${label}].ncm`),
      cest: item.cest,
      origem: requireField(item.origem, `items[${label}].origem`),
      cfop,
      csosn_cst: csosn,
      tax_details: {
        icms_origem: requireField(item.origem, `items[${label}].origem`),
        pis_cst: pisCofins.cst,
        cofins_cst: pisCofins.cst,
        ipi_cst: ipi.cst,
        ipi_codigo_enquadramento_legal: ipi.codigoEnquadramentoLegal,
        ibs_cbs_situacao_tributaria: ibsCbs.situacaoTributaria,
        ibs_cbs_classificacao_tributaria: ibsCbs.classificacaoTributaria,
        ibs_uf_aliquota: ibsCbs.aliquotaIbsUf,
        ibs_mun_aliquota: ibsCbs.aliquotaIbsMunicipio,
        cbs_aliquota: ibsCbs.aliquotaCbs,
        ibs_valor_total: ibsCbs.valorIbsItem,
        cbs_valor: ibsCbs.valorCbs,
      },
    }
  })

  return {
    header: {
      company_id: ctx.companyId,
      sale_id: ctx.saleId,
      document_type: 'nfe',
      provider: 'focus_nfe',
      environment: ctx.environment,
      provider_ref: ctx.providerRef,
      status: 'draft',
    },
    items,
  }
}
