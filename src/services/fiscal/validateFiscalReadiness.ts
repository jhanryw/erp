/**
 * Validações locais antes de qualquer emissão real (Fase Fiscal 2A, seção
 * 11 do pedido). Módulo PURO — só examina o `FiscalDocumentContext` já
 * carregado, nenhuma chamada de rede/banco, nunca lança (sempre devolve a
 * lista de erros, vazia quando tudo está pronto).
 *
 * Roda ANTES de `buildNfePayload` na orquestração real — o preview mostra
 * os dois resultados juntos (payload best-effort + lista de erros), mas
 * `readyToTransmit` (nenhuma nota real deve ser enviada) depende só desta
 * função retornar `[]`.
 */

import { resolveFormaPagamento } from '@/lib/fiscal/paymentRules'
import { FiscalRuleNotImplementedError, SUPPORTED_CRT } from '@/lib/fiscal/taxRules'
import { normalizeNcm } from '@/lib/fiscal/ncmRules'
import type { FiscalDocumentContext, FiscalValidationError } from './types'

/** sales.status que nunca deveriam gerar uma NF-e nova — Fase Fiscal 3A. */
const SALE_STATUS_BLOCKS_EMISSION = new Set(['cancelled', 'returned'])

/** Tolerância de arredondamento pra comparação de centavos — Fase Fiscal 3A. */
const PAYMENT_TOTAL_TOLERANCE = 0.01

function err(code: string, message: string, field?: string): FiscalValidationError {
  return { code, field, message }
}

export function validateFiscalReadiness(ctx: FiscalDocumentContext): FiscalValidationError[] {
  const errors: FiscalValidationError[] = []

  // ─── Estado da venda (Fase Fiscal 3A) ───────────────────────────────────
  // Nunca faz sentido fiscal emitir NF-e nova pra uma venda já cancelada ou
  // devolvida — achado da auditoria da Fase Fiscal 3 (submitNfeHomologacao
  // nunca checava isso antes).
  if (SALE_STATUS_BLOCKS_EMISSION.has(ctx.saleStatus)) {
    errors.push(err('sale_status_not_emittable', `Venda está com status "${ctx.saleStatus}" — não é possível emitir NF-e nova pra uma venda cancelada ou devolvida.`, 'saleStatus'))
  }

  // ─── Integração Focus ────────────────────────────────────────────────────
  if (!ctx.focusIntegration.available) {
    if (ctx.focusIntegration.reason === 'integration_not_found') {
      errors.push(err('focus_integration_missing', 'Integração Focus NFe não cadastrada para esta empresa.'))
    } else if (ctx.focusIntegration.reason === 'integration_disabled') {
      errors.push(err('focus_integration_disabled', 'Integração Focus NFe cadastrada, mas não está ativa.'))
    } else if (ctx.focusIntegration.reason === 'token_missing') {
      errors.push(err('focus_token_missing', 'Integração Focus NFe ativa, mas sem token configurado.'))
    }
  }

  // ─── Cadastro fiscal da empresa (emitente) ──────────────────────────────
  const e = ctx.emitente
  if (!e.cnpj) errors.push(err('emitente_cnpj_missing', 'Empresa sem CNPJ cadastrado em company_fiscal_settings.', 'emitente.cnpj'))
  if (!e.razaoSocial) errors.push(err('emitente_razao_social_missing', 'Empresa sem razão social cadastrada.', 'emitente.razaoSocial'))
  if (!e.inscricaoEstadual) errors.push(err('emitente_ie_missing', 'Empresa sem inscrição estadual cadastrada.', 'emitente.inscricaoEstadual'))
  if (!e.crt) {
    errors.push(err('emitente_crt_missing', 'Empresa sem regime tributário (CRT) cadastrado.', 'emitente.crt'))
  } else if (!SUPPORTED_CRT.includes(e.crt)) {
    // Traz pra cá a mesma checagem que `taxRules.ts` (`assertSupportedCrt`)
    // já fazia — mas só dentro de `buildNfePayload`, tarde demais pro
    // usuário ver como um erro de validação estruturado. A defesa do
    // builder continua intocada (nunca confia cegamente em quem chama) —
    // esta é uma SEGUNDA camada, não uma substituição. CRT 2/3 (Lucro
    // Presumido/Real) não têm CFOP/CSOSN/PIS-COFINS implementados nesta
    // fase — não inventa regra, só reporta que ainda não é suportado.
    errors.push(err('emitente_crt_nao_suportado', `Regime tributário (CRT=${e.crt}) ainda não tem regra fiscal implementada nesta fase (só CRT 1 — Simples Nacional — e CRT 4 — MEI). Não é possível emitir NF-e pra este regime ainda.`, 'emitente.crt'))
  }
  if (!e.logradouro || !e.numero || !e.bairro || !e.municipio || !e.uf || !e.cep) {
    errors.push(err('emitente_endereco_incompleto', 'Endereço do emitente incompleto (logradouro/número/bairro/município/UF/CEP).', 'emitente.endereco'))
  }
  if (!e.municipioIbge) errors.push(err('emitente_municipio_ibge_missing', 'Código IBGE do município do emitente ausente.', 'emitente.municipioIbge'))

  // ─── Destinatário ────────────────────────────────────────────────────────
  const d = ctx.destinatario
  if (!d.nome) errors.push(err('destinatario_nome_missing', 'Destinatário sem nome.', 'destinatario.nome'))
  if (!d.cpf && !d.cnpj) errors.push(err('destinatario_documento_missing', 'Destinatário sem CPF nem CNPJ.', 'destinatario.cpf'))
  if (!d.logradouro || !d.numero || !d.bairro || !d.municipio || !d.uf || !d.cep) {
    errors.push(err('destinatario_endereco_incompleto', 'Endereço do destinatário incompleto (logradouro/número/bairro/município/UF/CEP).', 'destinatario.endereco'))
  }
  if (d.cep && !/^\d{8}$/.test(d.cep.replace(/\D/g, ''))) {
    errors.push(err('destinatario_cep_invalido', 'CEP do destinatário não tem 8 dígitos.', 'destinatario.cep'))
  }
  if (d.uf && !/^[A-Z]{2}$/.test(d.uf.toUpperCase())) {
    errors.push(err('destinatario_uf_invalida', 'UF do destinatário inválida.', 'destinatario.uf'))
  }
  if (!d.municipioIbge) {
    errors.push(err('destinatario_municipio_ibge_missing', 'Código IBGE do município do destinatário ausente — não há fonte desse dado no ERP hoje (débito técnico, ver relatório da fase).', 'destinatario.municipioIbge'))
  }

  // ─── Itens ───────────────────────────────────────────────────────────────
  if (ctx.items.length === 0) {
    errors.push(err('items_empty', 'Venda sem itens — nada para emitir.'))
  }

  // ─── CEST — auditado, NÃO validado nesta fase (decisão deliberada) ──────
  //
  // Auditoria feita antes de decidir: (1) `products.cest` é TEXT opcional,
  // sem CHECK de formato no banco — só validado no cadastro
  // (`src/lib/validators/index.ts:17-22`, regex `^\d{2}\.\d{3}\.\d{2}$`),
  // nunca revalidado na emissão. (2) Nenhuma regra de ICMS-ST existe no
  // projeto — `20260615_tax_simulator.sql` documenta explicitamente "Sem
  // ST, MVA, isenções..."; `resolveIcmsCsosn` (taxRules.ts) sempre devolve
  // CSOSN 102 ("sem permissão de crédito", nunca um CSOSN de ST como
  // 500/900). (3) A obrigação de preencher CEST (Convênio ICMS 142/2018) é
  // definida pelo NCM constar na tabela oficial de correlação NCM↔CEST —
  // NÃO pelo CSOSN da venda (um produto pode exigir CEST mesmo vendido sob
  // CSOSN 102, se o ST já foi recolhido antes na cadeia). (4) Determinar
  // "este NCM exige CEST" exige a tabela oficial NCM↔CEST (~29 segmentos,
  // mantida pelo governo) — este ERP não tem essa tabela importada em
  // lugar nenhum (é um dado de referência do mesmo porte do cache de
  // municípios do IBGE, nunca construído pra CEST). Não é determinável só
  // por NCM/operação/UF/regime SEM essa tabela.
  //
  // Decisão: NÃO inventar heurística (ex.: "todo NCM começando com X exige
  // CEST") sem essa fonte — arriscaria bloquear emissões válidas ou, pior,
  // dar falsa confiança nas que passam. Menor guardrail seguro pra
  // produção, proposto (não implementado nesta fase): deixar o guard
  // existente da Focus/SEFAZ ser a rede de segurança — uma rejeição por
  // CEST ausente já cai em `submission_error` (retentável, mesma
  // `provider_ref`, nunca autorização ambígua) pelo mecanismo de
  // reconciliação já testado contra Postgres real. Se/quando a tabela
  // NCM↔CEST for importada numa fase futura, esta validação pode ser
  // adicionada aqui com a mesma fonte única de verdade.
  for (const item of ctx.items) {
    const label = item.sku ?? `sale_item_id=${item.saleItemId}`
    // Presença E formato — o cadastro de produto (`/api/produtos`) já força
    // `^\d{8}$`, mas isso não cobre dado legado/importado direto no banco.
    // Revalida no momento da emissão, independente do que o cadastro já
    // fez (nunca confia que todo dado passou pelo formulário/schema atual).
    if (!item.ncm) {
      errors.push(err('item_ncm_missing', `Produto ${label} sem NCM cadastrado.`, `items[${item.saleItemId}].ncm`))
    } else if (!normalizeNcm(item.ncm)) {
      errors.push(err('item_ncm_invalido', `Produto ${label} com NCM inválido ("${item.ncm}") — esperado exatamente 8 dígitos numéricos (pontuação é normalizada, mas letras ou quantidade errada de dígitos não).`, `items[${item.saleItemId}].ncm`))
    }
    if (item.origem === null || item.origem === undefined) {
      errors.push(err('item_origem_missing', `Produto ${label} sem origem da mercadoria cadastrada.`, `items[${item.saleItemId}].origem`))
    }
    if (!item.unit) errors.push(err('item_unidade_missing', `Produto ${label} sem unidade de medida.`, `items[${item.saleItemId}].unit`))
    if (!item.description) errors.push(err('item_descricao_missing', `Produto ${label} sem descrição.`, `items[${item.saleItemId}].description`))
    if (item.quantity <= 0) errors.push(err('item_quantidade_invalida', `Produto ${label} com quantidade inválida (${item.quantity}).`, `items[${item.saleItemId}].quantity`))
  }

  // ─── Pagamentos (Fase Fiscal 3A) ─────────────────────────────────────────
  if (ctx.payments.length === 0) {
    errors.push(err('payments_missing', 'Venda sem nenhum pagamento registrado em sale_payments — não é possível montar formas_pagamento.'))
  } else {
    for (const payment of ctx.payments) {
      try {
        resolveFormaPagamento(payment.method)
      } catch (e) {
        const message = e instanceof FiscalRuleNotImplementedError ? e.message : `Método de pagamento "${payment.method}" não suportado.`
        errors.push(err('payment_method_unsupported', message, 'payments'))
      }
    }

    const paymentsSum = ctx.payments.reduce((sum, p) => sum + p.netAmount, 0)
    if (Math.abs(paymentsSum - ctx.saleTotal) > PAYMENT_TOTAL_TOLERANCE) {
      errors.push(err(
        'payments_total_mismatch',
        `Soma dos pagamentos (R$ ${paymentsSum.toFixed(2)}) diverge do total da venda (R$ ${ctx.saleTotal.toFixed(2)}).`,
        'payments',
      ))
    }
  }

  return errors
}
