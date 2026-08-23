/**
 * Builder puro do payload de NFC-e (Fase Fiscal 4E).
 *
 * Nenhuma chamada HTTP, nenhuma consulta a banco, nenhuma credencial —
 * recebe um `FiscalDocumentContext` já carregado e devolve o objeto Focus
 * pronto. Determinístico e testável isoladamente. Mesma filosofia
 * defensiva de `buildNfePayload.ts`: lança `FiscalBuildError` se um campo
 * REALMENTE obrigatório estiver ausente, mesmo que `validateNfceReadiness`
 * não tenha rodado antes.
 *
 * ─── O que é DIFERENTE de `buildNfePayload.ts` (evidência real, §4-5 do
 * relatório da Fase 4) ────────────────────────────────────────────────────
 *
 * NFC-e nunca exige destinatário — `nome_destinatario`/`cpf_destinatario`/
 * `cnpj_destinatario` são os ÚNICOS campos de destinatário que existem no
 * schema real, e nenhum é obrigatório. Não existe NENHUM campo de endereço
 * de destinatário no payload de NFC-e (confirmado por leitura completa do
 * schema `NFCeRequest`) — nunca chama `resolveMunicipioIbge`, nunca exige
 * CEP/logradouro/UF do destinatário.
 *
 * `presenca_comprador`/`local_destino`/`modalidade_frete` são
 * HARDCODED aqui, não lidos de `ctx.operation`: NFC-e só é usada por
 * `resolveFiscalDocumentType` pra vendas `pickup` presenciais (nunca
 * entrega, nunca site) — a operação é SEMPRE presencial (`presenca_
 * comprador='1'`), sempre dentro do próprio estado do emitente
 * (`local_destino='1'`, já que não há endereço de destino pra comparar
 * UF), e sempre sem frete (`modalidade_frete='9'`, retirada não tem
 * transporte). Validado defensivamente mesmo assim (não confia cegamente
 * em `ctx.operation` vir correto de um chamador futuro).
 *
 * `data_emissao` é gerado no momento da montagem (ISO 8601, `Date.now()`)
 * — campo obrigatório no schema de NFC-e sem equivalente explícito no de
 * NF-e (Focus preenche automaticamente pra NF-e; NFC-e exige no corpo).
 */

import { resolveIcmsCsosn, resolvePisCofinsCst, resolveIbsCbsTestYear2026, type Crt } from '@/lib/fiscal/taxRules'
import { resolveFormaPagamento, resolveBandeiraOperadora } from '@/lib/fiscal/paymentRules'
import { normalizeNcm } from '@/lib/fiscal/ncmRules'
import type { FocusNfceItemPayload, FocusNfcePayload, FocusFormaPagamentoNfce } from '@/lib/integrations/focus/nfcePayload.types'
import type { FiscalDocumentContext, FiscalSaleItemContext, FiscalPaymentContext } from './types'
import { FiscalBuildError } from './buildNfePayload'
import { applyOrderLevelAdjustments } from './allocateOrderAdjustments'

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === '') {
    throw new FiscalBuildError(`buildNfcePayload: campo obrigatório ausente — ${label}.`)
  }
  return value
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * CFOP fixo pra NFC-e balcão: 5102 (venda dentro do estado, mercadoria de
 * terceiros, sem ST) — nunca chama `resolveCfop` de `taxRules.ts` porque
 * aquela função decide entre estado interno/interestadual a partir de duas
 * UFs (emitente/destinatário), e NFC-e não tem UF de destinatário pra
 * comparar (venda presencial, sempre local_destino='1'). Válido pros dois
 * CRT suportados (1 e 4) — mesmo código em ambos os casos pra venda
 * interna, confirmado em `taxRules.ts` (`resolveCfop`: `interstate ? ... :
 * '5102'` é o mesmo pra CRT 1 e CRT 4 quando NÃO interestadual).
 */
export const NFCE_CFOP_INTERNO = '5102'

function buildItemPayload(item: FiscalSaleItemContext, index: number, crt: Crt): FocusNfceItemPayload {
  const label = item.sku ?? `sale_item_id=${item.saleItemId}`

  const csosn = resolveIcmsCsosn(crt)
  const pisCofins = resolvePisCofinsCst(crt)
  const ibsCbs = resolveIbsCbsTestYear2026()

  const ncm = required(normalizeNcm(item.ncm), `items[${label}].ncm`)
  const unidade = required(item.unit, `items[${label}].unit`)
  const origem = required(item.origem, `items[${label}].origem`)

  return {
    numero_item: String(index + 1),
    codigo_produto: required(item.sku, `items[${label}].sku`),
    descricao: required(item.description, `items[${label}].description`),
    cfop: NFCE_CFOP_INTERNO,
    unidade_comercial: unidade,
    // Tributável = comercial — este ERP não modela unidade fiscal distinta
    // da comercial (ver comentário do arquivo/nfcePayload.types.ts).
    unidade_tributavel: unidade,
    quantidade_comercial: item.quantity,
    quantidade_tributavel: item.quantity,
    valor_unitario_comercial: item.unitPrice,
    valor_unitario_tributavel: item.unitPrice,
    valor_bruto: round2(item.unitPrice * item.quantity),
    ...(item.discountAmount > 0 ? { valor_desconto: round2(item.discountAmount) } : {}),
    codigo_ncm: ncm,

    icms_origem: String(origem),
    icms_situacao_tributaria: csosn,

    pis_situacao_tributaria: pisCofins.cst,
    pis_base_calculo: 0,
    pis_aliquota_porcentual: 0,
    pis_valor: 0,

    cofins_situacao_tributaria: pisCofins.cst,
    cofins_base_calculo: 0,
    cofins_aliquota_porcentual: 0,
    cofins_valor: 0,

    // IPI: DELIBERADAMENTE NÃO enviado — mod 65 (NFC-e) rejeita o grupo
    // IPI incondicionalmente (SEFAZ 742, achado real na venda 626), mesmo
    // com CST "não tributado". Ver nota completa em `nfcePayload.types.ts`.
    // NUNCA reintroduzir `ipi_situacao_tributaria`/
    // `ipi_codigo_enquadramento_legal` aqui — o tipo `FocusNfceItemPayload`
    // nem os declara mais, de propósito.

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
 * Monta `formas_pagamento[]` — reaproveita `resolveFormaPagamento`/
 * `resolveBandeiraOperadora` de `paymentRules.ts` (mesma tabela nacional
 * tPag/tBand da SEFAZ, compartilhada entre NF-e e NFC-e).
 *
 * ⚠️ CONFIRMAÇÃO PENDENTE (blocker antes da primeira emissão real de
 * homologação NFC-e com PIX): `pix→'20'` foi confirmado EMPIRICAMENTE só
 * pra NF-e, via 2 XMLs reais autorizados (Fase 2B) — nenhum XML de NFC-e
 * real foi usado como prova ainda. A tabela tPag é nacional/compartilhada
 * (mesma fonte SEFAZ), então reaproveitar é a melhor evidência disponível
 * agora, mas NÃO é confirmação específica de NFC-e. Ver relatório da Fase
 * 4, §7 e §14 (blockers). NÃO reimplementar com um código diferente sem
 * evidência — se a Focus rejeitar, o erro cai em `submission_error`
 * (retentável, mesmo mecanismo de reconciliação já testado), nunca uma
 * autorização incorreta.
 *
 * `indicador_pagamento` (indPag) NÃO existe no schema de NFC-e — confirmado
 * pela ausência total do campo em `FormaPagamentoNFCe` (diferente de NF-e).
 *
 * ─── Troco real (Fase Fiscal 4I, hardening pré-produção) ─────────────────
 * `valor_pagamento` (vPag) é o valor TENDERED (bruto, entregue pelo
 * cliente) — nunca o líquido pós-troco. Pra métodos sem troco (pix/
 * cartão), `amountTendered` é sempre igual a `netAmount` (invariante do
 * banco: `net_amount = amount_tendered - change_amount`, `change_amount`
 * só é != 0 pra dinheiro) — este código não precisa distinguir métodos,
 * só usa o valor certo em cada caso. `amountTendered` é OPCIONAL no tipo
 * (`FiscalPaymentContext`) por compatibilidade — ausente cai pra
 * `netAmount` (comportamento anterior a esta fase, ainda correto pra
 * pagamento sem troco). Ver `valor_troco` (documento) em
 * `buildNfcePayload` pra onde o troco em si é declarado — NUNCA aqui
 * (vPag nunca é líquido de troco quando há troco real).
 */
function buildFormaPagamentoPayload(payment: FiscalPaymentContext): FocusFormaPagamentoNfce {
  const bandeira = resolveBandeiraOperadora(payment.cardBrand)
  return {
    forma_pagamento: resolveFormaPagamento(payment.method),
    valor_pagamento: round2(payment.amountTendered ?? payment.netAmount),
    ...(bandeira ? { bandeira_operadora: bandeira } : {}),
  }
}

export function buildNfcePayload(ctx: FiscalDocumentContext): FocusNfcePayload {
  const emitenteCrt = required(ctx.emitente.crt, 'emitente.crt')
  const emitenteCnpj = required(ctx.emitente.cnpj, 'emitente.cnpj')

  if (ctx.items.length === 0) {
    throw new FiscalBuildError('buildNfcePayload: venda sem itens — nada para montar.')
  }
  if (ctx.payments.length === 0) {
    throw new FiscalBuildError('buildNfcePayload: venda sem pagamentos registrados — nada para montar em formas_pagamento.')
  }

  // Defesa própria contra um chamador que monte o contexto errado — NFC-e
  // só faz sentido pra operação presencial (ver comentário do arquivo).
  if (ctx.operation.presencaComprador !== 1 && ctx.operation.presencaComprador !== 4) {
    throw new FiscalBuildError(`buildNfcePayload: presencaComprador=${ctx.operation.presencaComprador} inválido pra NFC-e — só 1 (presencial) ou 4 (entrega a domicílio) são aceitos pela Focus.`)
  }

  const payload: FocusNfcePayload = {
    cnpj_emitente: emitenteCnpj,
    data_emissao: new Date().toISOString(),
    presenca_comprador: ctx.operation.presencaComprador === 4 ? '4' : '1',
    local_destino: '1',
    modalidade_frete: '9',
    natureza_operacao: ctx.operation.naturezaOperacao,

    ...(ctx.destinatario.nome ? { nome_destinatario: ctx.destinatario.nome } : {}),
    ...(ctx.destinatario.cpf ? { cpf_destinatario: ctx.destinatario.cpf } : {}),
    ...(ctx.destinatario.cnpj ? { cnpj_destinatario: ctx.destinatario.cnpj } : {}),
    ...(ctx.destinatario.cnpj ? { indicador_inscricao_estadual_destinatario: ctx.destinatario.inscricaoEstadual ? '1' : '2' } : {}),

    items: ctx.items.map((item, index) => buildItemPayload(item, index, emitenteCrt)),
    formas_pagamento: ctx.payments.map((payment) => buildFormaPagamentoPayload(payment)),
  }

  applyOrderLevelAdjustments(payload.items, {
    discountAmount: ctx.saleDiscountAmount,
    surchargeAmount: ctx.saleSurchargeAmount,
    shippingCharged: ctx.saleShippingCharged,
  })

  // vTroco (documento, sibling de formas_pagamento — confirmado por
  // leitura direta de campos.focusnfe.com.br/nfe/NotaFiscalXML.html,
  // mesmo bloco compartilhado NF-e/NFC-e) — soma do troco de TODOS os
  // pagamentos (na prática só dinheiro tem troco > 0). Omitido quando 0
  // (mesmo padrão de todos os campos opcionais deste builder).
  const troco = ctx.payments.reduce((sum, p) => sum + (p.changeAmount ?? 0), 0)
  if (troco > 0) payload.valor_troco = round2(troco)

  return payload
}
