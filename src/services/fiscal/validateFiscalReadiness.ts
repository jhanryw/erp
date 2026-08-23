/**
 * Validações locais antes de qualquer emissão real (Fase Fiscal 2A, seção
 * 11 do pedido; separado por tipo de documento na Fase Fiscal 4). Módulo
 * PURO — só examina o `FiscalDocumentContext` já carregado, nenhuma
 * chamada de rede/banco, nunca lança (sempre devolve a lista de erros,
 * vazia quando tudo está pronto).
 *
 * Roda ANTES de `buildNfePayload`/`buildNfcePayload` na orquestração real
 * — `readyToTransmit` (nenhuma nota real deve ser enviada) depende só de
 * `validateNfeReadiness`/`validateNfceReadiness` retornar `[]`.
 *
 * ─── Split NF-e/NFC-e (Fase Fiscal 4) ────────────────────────────────────
 *
 * Auditoria (`docs/fiscal-fase4-nfce-arquitetura-proposta.md`, §4)
 * confirmou que o payload real de NFC-e da Focus não tem NENHUM campo de
 * endereço de destinatário, e todo campo de destinatário é opcional (nem
 * nome é exigido — venda de balcão sem CPF é o caminho feliz mais comum).
 * As regras de emitente/itens/pagamentos/estado da venda são IDÊNTICAS
 * pros dois documentos — só o bloco de destinatário diverge de verdade.
 * Por isso: `validateCommonFiscalReadiness` concentra tudo que é
 * compartilhado (nunca duplicado), e cada tipo de documento tem sua
 * própria função de destinatário, pequena e nomeada. `validateNfeReadiness`
 * reproduz EXATAMENTE o comportamento da antiga `validateFiscalReadiness`
 * (mesmos códigos de erro, mesma ordem, mesmo texto) — nenhuma regressão
 * de NF-e nesta revisão.
 */

import { resolveFormaPagamento } from '@/lib/fiscal/paymentRules'
import { FiscalRuleNotImplementedError, SUPPORTED_CRT } from '@/lib/fiscal/taxRules'
import { normalizeNcm } from '@/lib/fiscal/ncmRules'
import { validateCPF } from '@/lib/utils/cpf'
import type { FiscalDocumentContext, FiscalValidationError } from './types'

/** sales.status que nunca deveriam gerar documento fiscal novo — Fase Fiscal 3A. */
const SALE_STATUS_BLOCKS_EMISSION = new Set(['cancelled', 'returned'])

/** Tolerância de arredondamento pra comparação de centavos — Fase Fiscal 3A. */
const PAYMENT_TOTAL_TOLERANCE = 0.01

function err(code: string, message: string, field?: string): FiscalValidationError {
  return { code, field, message }
}

/**
 * Regras compartilhadas por NF-e E NFC-e: estado da venda, integração
 * Focus, cadastro fiscal do emitente (incl. CRT suportado), itens
 * (NCM/origem/unidade/descrição/quantidade), pagamentos. Nunca inclui
 * nada de destinatário — isso é específico por tipo de documento, ver
 * `validateNfeDestinatario`/`validateNfceDestinatario` abaixo.
 */
export function validateCommonFiscalReadiness(ctx: FiscalDocumentContext): FiscalValidationError[] {
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

/**
 * Destinatário — NF-e modelo 55. Idêntico byte-a-byte ao bloco que existia
 * dentro da antiga `validateFiscalReadiness` (mesmos códigos/mensagens) —
 * NF-e exige destinatário identificável e endereço completo porque o
 * documento se destina a operações com entrega/destino determinado.
 */
export function validateNfeDestinatario(ctx: FiscalDocumentContext): FiscalValidationError[] {
  const errors: FiscalValidationError[] = []
  const d = ctx.destinatario

  // Fase Fiscal 5C — erros granulares por campo (antes: um único código
  // `destinatario_endereco_incompleto` para qualquer combinação de campo
  // de endereço ausente). A UI agora consegue apontar exatamente qual
  // campo falta, em vez de "endereço incompleto" genérico.
  if (!d.nome) errors.push(err('destinatario_nome_missing', 'Destinatário sem nome.', 'destinatario.nome'))
  if (!d.cpf && !d.cnpj) errors.push(err('destinatario_documento_missing', 'Destinatário sem CPF nem CNPJ.', 'destinatario.cpf'))
  if (!d.cep) errors.push(err('destinatario_cep_missing', 'CEP do destinatário ausente.', 'destinatario.cep'))
  else if (!/^\d{8}$/.test(d.cep.replace(/\D/g, ''))) {
    errors.push(err('destinatario_cep_invalido', 'CEP do destinatário não tem 8 dígitos.', 'destinatario.cep'))
  }
  if (!d.logradouro) errors.push(err('destinatario_logradouro_missing', 'Logradouro do destinatário ausente.', 'destinatario.logradouro'))
  if (!d.numero) errors.push(err('destinatario_numero_missing', 'Número do destinatário ausente.', 'destinatario.numero'))
  if (!d.bairro) errors.push(err('destinatario_bairro_missing', 'Bairro do destinatário ausente.', 'destinatario.bairro'))
  if (!d.municipio) errors.push(err('destinatario_municipio_missing', 'Município do destinatário ausente.', 'destinatario.municipio'))
  if (!d.uf) errors.push(err('destinatario_uf_missing', 'UF do destinatário ausente.', 'destinatario.uf'))
  else if (!/^[A-Z]{2}$/.test(d.uf.toUpperCase())) {
    errors.push(err('destinatario_uf_invalida', 'UF do destinatário inválida.', 'destinatario.uf'))
  }
  if (!d.municipioIbge) {
    errors.push(err('destinatario_municipio_ibge_missing', 'Código IBGE do município do destinatário ausente — não foi possível resolver automaticamente (ViaCEP/API do IBGE); corrija o CEP/município ou informe manualmente.', 'destinatario.municipioIbge'))
  }
  return errors
}

/**
 * Destinatário — NFC-e modelo 65. Auditoria confirmou (`docs/fiscal-fase4-
 * nfce-arquitetura-proposta.md`, §4-5): o payload real da Focus pra NFC-e
 * não tem NENHUM campo de endereço de destinatário, e nome/documento são
 * OPCIONAIS (consumidor não identificado é o caminho feliz mais comum de
 * balcão). Nunca reutiliza as regras rígidas de `validateNfeDestinatario`
 * — exigir endereço/IBGE aqui seria uma exigência artificial que a Focus
 * nem aceita como campo. Única validação: SE um CPF foi informado
 * (cliente pediu nota com CPF), o formato precisa ser um CPF válido
 * (dígitos verificadores) — nunca exige, só valida quando presente.
 */
export function validateNfceDestinatario(ctx: FiscalDocumentContext): FiscalValidationError[] {
  const errors: FiscalValidationError[] = []
  const d = ctx.destinatario
  if (d.cpf && !validateCPF(d.cpf)) {
    errors.push(err('destinatario_cpf_invalido', `CPF do destinatário inválido ("${d.cpf}").`, 'destinatario.cpf'))
  }
  return errors
}

/** Readiness completo pra NF-e modelo 55 — comum + destinatário NF-e. Substitui a antiga `validateFiscalReadiness`, mesmo comportamento. */
export function validateNfeReadiness(ctx: FiscalDocumentContext): FiscalValidationError[] {
  return [...validateCommonFiscalReadiness(ctx), ...validateNfeDestinatario(ctx)]
}

/** Readiness completo pra NFC-e modelo 65 — comum + destinatário NFC-e (nunca exige endereço/IBGE/nome). */
export function validateNfceReadiness(ctx: FiscalDocumentContext): FiscalValidationError[] {
  return [...validateCommonFiscalReadiness(ctx), ...validateNfceDestinatario(ctx)]
}
