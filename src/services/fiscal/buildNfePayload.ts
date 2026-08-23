/**
 * Builder puro do payload de NF-e (Fase Fiscal 2A, seção 8 do pedido).
 *
 * Nenhuma chamada HTTP, nenhuma consulta a banco, nenhuma credencial —
 * recebe um `FiscalDocumentContext` já carregado e devolve o objeto Focus
 * pronto (e o snapshot pra `fiscal_document_items`). Determinístico e
 * testável isoladamente.
 *
 * Defensivo por conta própria: lança `FiscalBuildError` se um campo
 * REALMENTE obrigatório estiver ausente, mesmo que o chamador não tenha
 * rodado `validateFiscalReadiness` antes — nunca monta um payload com
 * `null`/`undefined` disfarçado de dado real.
 */

import { resolveCfop, resolveIcmsCsosn, resolvePisCofinsCst, resolveIpiTreatment, resolveIbsCbsTestYear2026, type Crt } from '@/lib/fiscal/taxRules'
import { resolveFormaPagamento, resolveIndicadorPagamento, resolveBandeiraOperadora } from '@/lib/fiscal/paymentRules'
import { normalizeNcm } from '@/lib/fiscal/ncmRules'
import type { FocusNfeItemPayload, FocusNfePayload, FocusFormaPagamento } from '@/lib/integrations/focus/nfePayload.types'
import type { FiscalDocumentContext, FiscalSaleItemContext, FiscalPaymentContext } from './types'
import { applyOrderLevelAdjustments } from './allocateOrderAdjustments'

export class FiscalBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalBuildError'
  }
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === '') {
    throw new FiscalBuildError(`buildNfePayload: campo obrigatório ausente — ${label}.`)
  }
  return value
}

function resolveLocalDestino(originUf: string, destinationUf: string): 1 | 2 {
  return originUf.trim().toUpperCase() === destinationUf.trim().toUpperCase() ? 1 : 2
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function buildItemPayload(item: FiscalSaleItemContext, index: number, crt: Crt, originUf: string, destinationUf: string): FocusNfeItemPayload {
  const label = item.sku ?? `sale_item_id=${item.saleItemId}`

  const cfop = resolveCfop({ originUf, destinationUf, crt })
  const csosn = resolveIcmsCsosn(crt)
  const pisCofins = resolvePisCofinsCst(crt)
  const ipi = resolveIpiTreatment()
  const ibsCbs = resolveIbsCbsTestYear2026()

  return {
    numero_item: index + 1,
    codigo_produto: required(item.sku, `items[${label}].sku`),
    descricao: required(item.description, `items[${label}].description`),
    cfop,
    unidade_comercial: required(item.unit, `items[${label}].unit`),
    quantidade_comercial: item.quantity,
    valor_unitario_comercial: item.unitPrice,
    valor_bruto: round2(item.unitPrice * item.quantity),
    ...(item.discountAmount > 0 ? { valor_desconto: round2(item.discountAmount) } : {}),
    // Normalizado (nunca a string bruta) — se `validateFiscalReadiness` não
    // rodou antes (chamador direto, ou defesa própria do builder),
    // `normalizeNcm` devolve null pra NCM malformado e `required` lança
    // `FiscalBuildError` — nunca envia pontuação/formato inválido à Focus.
    codigo_ncm: required(normalizeNcm(item.ncm), `items[${label}].ncm`),
    ...(item.cest ? { cest: item.cest } : {}),
    codigo_barras_comercial: 'SEM GTIN',

    icms_origem: required(item.origem, `items[${label}].origem`),
    icms_situacao_tributaria: csosn,

    // Confirmado por XML real (Fase 2B): sempre presentes e zerados, nunca omitidos.
    pis_situacao_tributaria: pisCofins.cst,
    pis_base_calculo: 0,
    pis_aliquota_porcentual: 0,
    pis_valor: 0,

    cofins_situacao_tributaria: pisCofins.cst,
    cofins_base_calculo: 0,
    cofins_aliquota_porcentual: 0,
    cofins_valor: 0,

    ipi_situacao_tributaria: ipi.cst,
    ipi_codigo_enquadramento_legal: ipi.codigoEnquadramentoLegal,

    ibs_cbs_situacao_tributaria: ibsCbs.situacaoTributaria,
    ibs_cbs_classificacao_tributaria: ibsCbs.classificacaoTributaria,
    ibs_cbs_base_calculo: ibsCbs.baseCalculo,
    ibs_uf_aliquota: ibsCbs.aliquotaIbsUf,
    ibs_uf_valor: ibsCbs.valorIbsUf,
    ibs_mun_aliquota: ibsCbs.aliquotaIbsMunicipio,
    ibs_mun_valor: ibsCbs.valorIbsMunicipio,
    ibs_valor_total: ibsCbs.valorIbsItem,
    cbs_aliquota: ibsCbs.aliquotaCbs,
    cbs_valor: ibsCbs.valorCbs,
  }
}

/**
 * Fase Fiscal 3A — monta uma entrada de `formas_pagamento[]`. Nunca inclui
 * `tipo_integracao`/`cnpj_credenciadora`/`numero_autorizacao`/
 * `cnpj_beneficiario`/`id_terminal_pagamento` (ver comentário completo em
 * nfePayload.types.ts) — este ERP não tem dado fiscal confiável de
 * credenciadora/integração. `resolveFormaPagamento` propaga
 * `FiscalRuleNotImplementedError` pra método não suportado (ex.: 'card'
 * legado) — nunca capturado aqui, sobe pro chamador (submitNfeHomologacao/
 * preview) tratar explicitamente.
 */
/**
 * Troco real (Fase Fiscal 4I, hardening pré-produção) — `valor_pagamento`
 * (vPag) é o TENDERED (bruto, entregue pelo cliente), nunca o líquido
 * pós-troco. `amountTendered` cai pra `netAmount` quando ausente (mesmo
 * padrão de `buildNfcePayload.ts`) — correto pra pagamento sem troco.
 * Campo confirmado compartilhado NF-e/NFC-e (`formas_pagamento`, mesmo
 * tipo `FormaPagamentoXML`, "Forma de pagamento para NF-e e NFC-e" —
 * campos.focusnfe.com.br/nfe/NotaFiscalXML.html).
 */
function buildFormaPagamentoPayload(payment: FiscalPaymentContext): FocusFormaPagamento {
  const bandeira = resolveBandeiraOperadora(payment.cardBrand)
  return {
    forma_pagamento: resolveFormaPagamento(payment.method),
    valor_pagamento: round2(payment.amountTendered ?? payment.netAmount),
    indicador_pagamento: resolveIndicadorPagamento(),
    ...(bandeira ? { bandeira_operadora: bandeira } : {}),
  }
}

/**
 * 1=contribuinte ICMS (informar IE), 2=contribuinte isento de inscrição,
 * 9=não contribuinte. Hoje `customers` só suporta PF (cnpj/IE sempre
 * null), então isto sempre resolve pra 9 na prática — mas a lógica é
 * genérica de propósito (seção 14 do pedido: não hardcode o builder pra
 * CPF), pronta pro dia em que um destinatário PJ existir: CNPJ+IE
 * presentes → contribuinte; CNPJ sem IE → isento. A distinção exata entre
 * 1 e 2 pra um caso PJ real depende de regra de negócio ainda não
 * definida — quando PJ for implementado de fato, revisar esta função.
 */
function resolveIndicadorIeDestinatario(cnpj: string | null, inscricaoEstadual: string | null): 1 | 2 | 9 {
  if (!cnpj) return 9
  return inscricaoEstadual ? 1 : 2
}

export function buildNfePayload(ctx: FiscalDocumentContext): FocusNfePayload {
  const emitenteUf = required(ctx.emitente.uf, 'emitente.uf')
  const emitenteCrt = required(ctx.emitente.crt, 'emitente.crt')
  const emitenteCnpj = required(ctx.emitente.cnpj, 'emitente.cnpj')
  const destinatarioUf = required(ctx.destinatario.uf, 'destinatario.uf')

  if (ctx.items.length === 0) {
    throw new FiscalBuildError('buildNfePayload: venda sem itens — nada para montar.')
  }
  if (ctx.payments.length === 0) {
    throw new FiscalBuildError('buildNfePayload: venda sem pagamentos registrados — nada para montar em formas_pagamento.')
  }

  const documentoDestinatario = ctx.destinatario.cpf ?? ctx.destinatario.cnpj
  required(documentoDestinatario, 'destinatario.cpf/cnpj')

  const payload: FocusNfePayload = {
    natureza_operacao: ctx.operation.naturezaOperacao,
    presenca_comprador: ctx.operation.presencaComprador,
    local_destino: resolveLocalDestino(emitenteUf, destinatarioUf),
    modalidade_frete: ctx.operation.modalidadeFrete,
    consumidor_final: ctx.operation.consumidorFinal,
    indicador_intermediario: ctx.operation.indicadorIntermediador,

    cnpj_emitente: emitenteCnpj,
    regime_tributario_emitente: emitenteCrt,

    nome_destinatario: required(ctx.destinatario.nome, 'destinatario.nome'),
    ...(ctx.destinatario.cpf ? { cpf_destinatario: ctx.destinatario.cpf } : {}),
    ...(ctx.destinatario.cnpj ? { cnpj_destinatario: ctx.destinatario.cnpj } : {}),
    ...(ctx.destinatario.telefone ? { telefone_destinatario: ctx.destinatario.telefone } : {}),
    ...(ctx.destinatario.email ? { email_destinatario: ctx.destinatario.email } : {}),
    logradouro_destinatario: required(ctx.destinatario.logradouro, 'destinatario.logradouro'),
    numero_destinatario: required(ctx.destinatario.numero, 'destinatario.numero'),
    ...(ctx.destinatario.complemento ? { complemento_destinatario: ctx.destinatario.complemento } : {}),
    bairro_destinatario: required(ctx.destinatario.bairro, 'destinatario.bairro'),
    municipio_destinatario: required(ctx.destinatario.municipio, 'destinatario.municipio'),
    // Preferência forte, mantida como obrigatória de propósito — nunca
    // emitir sem o código IBGE resolvido com segurança (seção 5 do pedido
    // da Fase 2B). Resolvido por `resolveMunicipioIbge` (cache + API
    // pública do IBGE), nunca hardcoded. É plausível que a Focus consiga
    // derivar isso internamente de município+UF sem este campo — não
    // confirmado e não usado como fallback (ver nota completa em
    // nfePayload.types.ts, campo `codigo_municipio_destinatario`).
    codigo_municipio_destinatario: required(ctx.destinatario.municipioIbge, 'destinatario.municipioIbge'),
    uf_destinatario: destinatarioUf,
    cep_destinatario: required(ctx.destinatario.cep, 'destinatario.cep'),
    ...(ctx.destinatario.inscricaoEstadual ? { inscricao_estadual_destinatario: ctx.destinatario.inscricaoEstadual } : {}),
    indicador_inscricao_estadual_destinatario: resolveIndicadorIeDestinatario(ctx.destinatario.cnpj, ctx.destinatario.inscricaoEstadual),

    items: ctx.items.map((item, index) => buildItemPayload(item, index, emitenteCrt, emitenteUf, destinatarioUf)),
    formas_pagamento: ctx.payments.map((payment) => buildFormaPagamentoPayload(payment)),
  }

  // Fase Fiscal 4I (hardening pré-produção) — mesmo rateio determinístico
  // de desconto/acréscimo/frete de PEDIDO já usado em `buildNfcePayload.ts`
  // (ver `allocateOrderAdjustments.ts` pra prova matemática). Campos
  // confirmados compartilhados NF-e/NFC-e (mesmo tipo complexo `det/prod`).
  applyOrderLevelAdjustments(payload.items, {
    discountAmount: ctx.saleDiscountAmount,
    surchargeAmount: ctx.saleSurchargeAmount,
    shippingCharged: ctx.saleShippingCharged,
  })

  // vTroco — mesmo campo documento-level confirmado compartilhado (ver
  // `buildNfcePayload.ts` pra evidência completa).
  const troco = ctx.payments.reduce((sum, p) => sum + (p.changeAmount ?? 0), 0)
  if (troco > 0) payload.valor_troco = round2(troco)

  return payload
}
