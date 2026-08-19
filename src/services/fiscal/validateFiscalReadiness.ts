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

import type { FiscalDocumentContext, FiscalValidationError } from './types'

function err(code: string, message: string, field?: string): FiscalValidationError {
  return { code, field, message }
}

export function validateFiscalReadiness(ctx: FiscalDocumentContext): FiscalValidationError[] {
  const errors: FiscalValidationError[] = []

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
  if (!e.crt) errors.push(err('emitente_crt_missing', 'Empresa sem regime tributário (CRT) cadastrado.', 'emitente.crt'))
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

  for (const item of ctx.items) {
    const label = item.sku ?? `sale_item_id=${item.saleItemId}`
    if (!item.ncm) errors.push(err('item_ncm_missing', `Produto ${label} sem NCM cadastrado.`, `items[${item.saleItemId}].ncm`))
    if (item.origem === null || item.origem === undefined) {
      errors.push(err('item_origem_missing', `Produto ${label} sem origem da mercadoria cadastrada.`, `items[${item.saleItemId}].origem`))
    }
    if (!item.unit) errors.push(err('item_unidade_missing', `Produto ${label} sem unidade de medida.`, `items[${item.saleItemId}].unit`))
    if (!item.description) errors.push(err('item_descricao_missing', `Produto ${label} sem descrição.`, `items[${item.saleItemId}].description`))
    if (item.quantity <= 0) errors.push(err('item_quantidade_invalida', `Produto ${label} com quantidade inválida (${item.quantity}).`, `items[${item.saleItemId}].quantity`))
  }

  return errors
}
