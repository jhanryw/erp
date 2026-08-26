/**
 * Tipos compartilhados — Fase Fiscal 2A (payload NF-e).
 *
 * `FiscalDocumentContext` é o formato ÚNICO de entrada tanto pra
 * `validateFiscalReadiness` (pura, nunca lança, aceita dado ausente) quanto
 * pra `buildNfePayload` (pura, lança `FiscalBuildError` se um campo
 * obrigatório estiver ausente). Os campos vêm nullable de propósito — quem
 * carrega o contexto (`loadSaleFiscalContext`, I/O) reflete exatamente o
 * que existe no banco, nunca preenche placeholder. A validação roda ANTES
 * da montagem na orquestração real (rota de preview): só chama
 * `buildNfePayload` depois de confirmar ausência de erro bloqueante — mas
 * `buildNfePayload` continua defensivo por conta própria, nunca confia
 * cegamente em quem chama.
 */

import type { Crt } from '@/lib/fiscal/taxRules'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

export interface FiscalEmitenteContext {
  cnpj: string | null
  razaoSocial: string | null
  inscricaoEstadual: string | null
  crt: Crt | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  municipio: string | null
  municipioIbge: string | null
  uf: string | null
  cep: string | null
}

export interface FiscalDestinatarioContext {
  nome: string | null
  isAnonymous: boolean
  cpf: string | null
  /** PJ — sem fonte no schema hoje (`customers` não tem CNPJ), sempre null nesta fase. Campo existe pra não travar a arquitetura quando PJ for suportado. */
  cnpj: string | null
  /** IE do destinatário PJ — Fase Fiscal 6: vem de `sale_recipients.inscricao_estadual` quando capturada; `null` quando não informada (PF, ou PJ sem IE). */
  inscricaoEstadual: string | null
  /**
   * indIEDest explícito — Fase Fiscal 6. Capturado no momento em que o
   * operador informa os dados fiscais do destinatário (nunca inferido pelo
   * schema/loader). `null` = sem indicador explícito — `buildNfePayload`
   * cai na heurística legada (CNPJ+IE→1 contribuinte, CNPJ sem IE→2
   * isento, sem CNPJ→9 não contribuinte), preservada por compatibilidade
   * com qualquer linha `sale_recipients` anterior a esta fase.
   */
  indicadorIe: 1 | 2 | 9 | null
  telefone: string | null
  email: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  municipio: string | null
  municipioIbge: string | null
  uf: string | null
  cep: string | null
}

export interface FiscalSaleItemContext {
  saleItemId: number
  productId: number
  variationId: number | null
  description: string | null
  sku: string | null
  quantity: number
  unitPrice: number
  discountAmount: number
  unit: string | null
  ncm: string | null
  cest: string | null
  origem: number | null
}

export interface FiscalOperationContext {
  naturezaOperacao: string
  /** 0=não se aplica, 1=presencial, 2=não presencial/internet, 3=teleatendimento, 4=NFC-e entrega domicílio, 5=presencial fora do estabelecimento, 9=outros */
  presencaComprador: 0 | 1 | 2 | 3 | 4 | 5 | 9
  /** 0=por conta do emitente (CIF), 1=por conta do destinatário (FOB), 2=por conta de terceiros, 9=sem frete */
  modalidadeFrete: 0 | 1 | 2 | 9
  /**
   * indFinal — 0=não é consumidor final (revenda/insumo), 1=consumidor
   * final. Resolvido a partir do CNPJ do destinatário (ver
   * src/lib/fiscal/consumidorFinal.ts) — DELIBERADAMENTE independente de
   * sale_type (retail/wholesale): classificação comercial e indicador
   * fiscal são conceitos separados (fundação varejo/atacado, 2026-08-31).
   */
  consumidorFinal: 0 | 1
  /** indIntermed — 0=operação sem intermediador/marketplace, 1=com intermediador. Confirmado no XML real como 0 (loja própria, não marketplace). */
  indicadorIntermediador: 0 | 1
}

export interface FiscalFocusIntegrationContext {
  available: boolean
  reason: 'integration_not_found' | 'integration_disabled' | 'token_missing' | null
}

/**
 * Um pagamento da venda (`sale_payments`) — Fase Fiscal 3A. `method` é o
 * valor bruto de `sale_payments.method` ('pix'/'cash'/'credit_card'/
 * 'debit_card'/'card' legado) — a tradução pro código fiscal (tPag)
 * acontece em `paymentRules.ts`, nunca aqui (este é só o dado carregado,
 * não interpretado). `installments` deliberadamente NÃO existe neste tipo
 * — confirmado que não há campo fiscal equivalente; fica só em
 * `sale_payments` mesmo.
 */
export interface FiscalPaymentContext {
  method: string
  netAmount: number
  cardBrand: string | null
  /**
   * `sale_payments.amount_tendered` — valor efetivamente entregue pelo
   * cliente (bruto, ANTES do troco) — Fase Fiscal 4I (hardening
   * pré-produção, troco real). Fiscalmente é o valor que vai em
   * `valor_pagamento`/vPag (nunca `netAmount` quando há troco — ver
   * `buildNfcePayload.ts`/`buildNfePayload.ts`, `buildFormaPagamentoPayload`).
   * OPCIONAL por compatibilidade: quando ausente/undefined, os builders
   * caem pra `netAmount` (correto pra pagamento sem troco, que é o único
   * cenário testado antes desta fase). `loadSaleFiscalContext.ts` sempre
   * popula este campo a partir do banco real.
   */
  amountTendered?: number
  /**
   * `sale_payments.change_amount` — troco devolvido NESTE pagamento.
   * Invariante do banco: `netAmount = amountTendered - changeAmount`
   * (`20260522_rpc_create_sale_payments.sql`). Normalmente só `method:
   * 'cash'` tem valor > 0. OPCIONAL — ausente/undefined tratado como 0
   * (nenhum troco) pelos builders.
   */
  changeAmount?: number
}

export interface FiscalDocumentContext {
  saleId: number
  companyId: number
  providerRef: string
  environment: FocusEnvironment
  /** sales.status no momento da carga — usado por validateFiscalReadiness pra bloquear emissão de venda cancelled/returned (Fase Fiscal 3A). */
  saleStatus: string
  /** sales.total — usado pra validar que a soma dos pagamentos bate com o total da venda (Fase Fiscal 3A). */
  saleTotal: number
  /**
   * `sales.discount_amount` — desconto no NÍVEL DO PEDIDO, DISTINTO do
   * desconto por item (`FiscalSaleItemContext.discountAmount`, já
   * capturado em `sale_items.discount_amount`). Achado real (Fase Fiscal
   * 4H, venda 626, rejeição SEFAZ 866): nenhum builder propagava este
   * valor pro payload, então a soma dos itens não batia com
   * `formas_pagamento` sempre que a venda tinha acréscimo/frete/desconto
   * de pedido. Ver `buildNfcePayload.ts` pra como isso é representado no
   * payload real (campo `valor_desconto`, nível de item, único nível que
   * o schema NFe/NFCe suporta).
   */
  saleDiscountAmount: number
  /**
   * `sales.surcharge_amount` — acréscimo genérico do PEDIDO (ex.: taxa de
   * serviço/juros), SEMANTICAMENTE DISTINTO de `saleShippingCharged`
   * (auditado no schema/RPC real — `20260627_rpc_create_sale_v4.sql`:
   * `p_surcharge_amount`/`p_shipping_charged` são parâmetros SEPARADOS,
   * ambos somados independentemente em `v_gross`). NUNCA presumir que um
   * cobre o outro.
   */
  saleSurchargeAmount: number
  /**
   * `sales.shipping_charged` — frete cobrado do cliente. Ver nota de
   * `saleSurchargeAmount` sobre a distinção real dos dois campos.
   */
  saleShippingCharged: number
  emitente: FiscalEmitenteContext
  destinatario: FiscalDestinatarioContext
  items: FiscalSaleItemContext[]
  payments: FiscalPaymentContext[]
  operation: FiscalOperationContext
  focusIntegration: FiscalFocusIntegrationContext
}

export interface FiscalValidationError {
  code: string
  field?: string
  message: string
}
