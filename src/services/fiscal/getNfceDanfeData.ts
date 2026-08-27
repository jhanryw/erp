// DANFE NFC-e real — leitura consolidada de uma NFC-e JÁ AUTORIZADA pra
// impressão térmica (Fase Fiscal 7). Puro GET/leitura: nunca chama Focus,
// nunca cria/altera fiscal_documents (ver regra "GET nunca emite", item 60
// do pedido). Sempre escopado por companyId da sessão — nunca por
// parâmetro de URL sozinho (item 59).
//
// ─── Fontes por campo (auditoria dirigida, correção de bug real) ───────────
//
// ITENS: `fiscal_document_items` (snapshot imutável gravado ANTES da
// transmissão) — nunca `sale_items`/`products` diretamente.
//
// EMITENTE/DESTINATÁRIO/PAGAMENTOS: `fiscal_documents.fiscal_context_snapshot`
// (JSONB) — o MESMO `FiscalDocumentContext` que foi usado pra montar o
// payload realmente enviado à Focus, congelado em `rpc_begin_fiscal_
// transmission` ANTES do POST (ver `submitNfceHomologacao.ts`,
// `beginFiscalTransmission({ fiscalContextSnapshot: context })`).
//
// ACHADO DESTA AUDITORIA (corrigido aqui, versão anterior deste arquivo
// tinha o bug): a versão anterior lia emitente de `company_fiscal_settings`
// (config ATUAL, mutável) e pagamentos de `sale_payments` (tabela ATUAL,
// mutável) em vez do snapshot — violava o item 10 do pedido original
// ("uma venda antiga deve reproduzir exatamente o documento autorizado
// naquela data... cadastro da empresa/consumidor não pode alterar uma NFC-e
// antiga"). Não existe uma tabela `fiscal_document_payments` separada — o
// snapshot já cumpre esse papel, então não foi criada uma nova.

import { createAdminClient } from '@/lib/supabase/admin'
import { logQueryError, type PgErrorLike } from '@/lib/errors/pgResult'
import { logError } from '@/lib/errors/log'
import type { FiscalDocumentContext } from './types'

const ROUTE = 'getNfceDanfeData'

export interface NfceDanfeItem {
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_amount: number
  total_amount: number
}

export interface NfceDanfePayment {
  method: string
  net_amount: number
  amount_tendered: number
  change_amount: number
}

export interface NfceDanfeData {
  sale: { id: number; sale_number: string; created_at: string }
  fiscalDocument: {
    id: number
    environment: string
    number: string | null
    series: string | null
    accessKey: string | null
    authorizationProtocol: string | null
    authorizedAt: string | null
    qrcodeUrl: string | null
  }
  emitente: {
    cnpj: string | null
    razaoSocial: string | null
    inscricaoEstadual: string | null
    logradouro: string | null
    numero: string | null
    complemento: string | null
    bairro: string | null
    municipio: string | null
    uf: string | null
    cep: string | null
  }
  destinatario: { nome: string | null; cpf: string | null; cnpj: string | null } | null
  items: NfceDanfeItem[]
  payments: NfceDanfePayment[]
  total: number
}

export type NfceDanfeResult =
  | { ok: true; data: NfceDanfeData }
  | { ok: false; reason: 'not_found' }
  /** status='authorized' mas dados locais insuficientes pra montar um DANFE confiável — nunca renderizado como se fosse válido (item 8 do pedido). */
  | { ok: false; reason: 'incomplete'; missing: string[] }

/**
 * Só devolve `ok:true` quando existe uma NFC-e com `status='authorized'`
 * pra esta venda, nesta empresa, E os dados locais necessários pro DANFE
 * estão todos presentes. Qualquer outro caso (não emitida, pendente,
 * rejeitada, cancelada, venda de outra empresa) devolve `not_found`; um
 * documento autorizado mas com dado local faltando devolve `incomplete`
 * explicitamente — nunca um DANFE parcial/enganoso.
 */
export async function getNfceDanfeData(params: { saleId: number; companyId: number }): Promise<NfceDanfeResult> {
  const { saleId, companyId } = params
  const admin = createAdminClient()

  const { data: sale, error: saleError } = await (admin as any)
    .from('sales')
    .select('id, sale_number, created_at')
    .eq('id', saleId)
    .eq('company_id', companyId)
    .maybeSingle() as { data: { id: number; sale_number: string; created_at: string } | null; error: PgErrorLike | null }
  logQueryError(saleError, `${ROUTE} (sales)`, { sale_id: saleId, company_id: companyId })
  if (!sale) return { ok: false, reason: 'not_found' }

  const { data: fiscalDoc, error: fiscalDocError } = await (admin as any)
    .from('fiscal_documents')
    .select('id, environment, number, series, access_key, authorization_protocol, authorized_at, qrcode_url, fiscal_context_snapshot')
    .eq('sale_id', saleId)
    .eq('company_id', companyId)
    .eq('document_type', 'nfce')
    .eq('status', 'authorized')
    .maybeSingle() as {
      data: {
        id: number; environment: string; number: string | null; series: string | null
        access_key: string | null; authorization_protocol: string | null
        authorized_at: string | null; qrcode_url: string | null
        fiscal_context_snapshot: FiscalDocumentContext | null
      } | null
      error: PgErrorLike | null
    }
  logQueryError(fiscalDocError, `${ROUTE} (fiscal_documents)`, { sale_id: saleId, company_id: companyId })
  // Não há NFC-e autorizada pra esta venda nesta empresa — inclusive o caso
  // de a venda ter NF-e em vez de NFC-e, ou a NFC-e estar pending/rejeitada/
  // cancelada (todas essas condições falham o `.eq('status','authorized')`
  // acima, nunca chegam aqui). Item 11 do pedido.
  if (!fiscalDoc) return { ok: false, reason: 'not_found' }

  const { data: items, error: itemsError } = await (admin as any)
    .from('fiscal_document_items')
    .select('description, quantity, unit, unit_price, discount_amount, total_amount')
    .eq('fiscal_document_id', fiscalDoc.id)
    .order('id', { ascending: true })
  logQueryError(itemsError as PgErrorLike, `${ROUTE} (fiscal_document_items)`, { fiscal_document_id: fiscalDoc.id })

  // ─── Integridade — item 8 do pedido: documento autorizado com dado local
  // incompleto NUNCA produz um DANFE aparentemente válido. Verifica
  // exatamente os campos que o DANFE realmente usa. ──────────────────────
  const missing: string[] = []
  if (!fiscalDoc.access_key) missing.push('access_key')
  if (!fiscalDoc.authorization_protocol) missing.push('authorization_protocol')
  if (!fiscalDoc.qrcode_url) missing.push('qrcode_url')
  if (!fiscalDoc.number) missing.push('number')
  if (!fiscalDoc.series) missing.push('series')
  if (!fiscalDoc.fiscal_context_snapshot) missing.push('fiscal_context_snapshot')
  if (!items || items.length === 0) missing.push('fiscal_document_items')

  if (missing.length > 0) {
    logError({
      route: ROUTE,
      err: new Error('Documento fiscal autorizado com dados locais incompletos.'),
      context: { sale_id: saleId, company_id: companyId, fiscal_document_id: fiscalDoc.id, missing },
    })
    return { ok: false, reason: 'incomplete', missing }
  }

  const snapshot = fiscalDoc.fiscal_context_snapshot as FiscalDocumentContext

  const danfeItems: NfceDanfeItem[] = (items as any[]).map((row) => ({
    description: row.description,
    quantity: Number(row.quantity),
    unit: row.unit,
    unit_price: Number(row.unit_price),
    discount_amount: Number(row.discount_amount ?? 0),
    total_amount: Number(row.total_amount),
  }))

  return {
    ok: true,
    data: {
      sale: { id: sale.id, sale_number: sale.sale_number, created_at: sale.created_at },
      fiscalDocument: {
        id: fiscalDoc.id,
        environment: fiscalDoc.environment,
        number: fiscalDoc.number,
        series: fiscalDoc.series,
        accessKey: fiscalDoc.access_key,
        authorizationProtocol: fiscalDoc.authorization_protocol,
        authorizedAt: fiscalDoc.authorized_at,
        qrcodeUrl: fiscalDoc.qrcode_url,
      },
      // Congelado no momento da transmissão (snapshot) — NUNCA
      // `company_fiscal_settings` atual. Uma alteração posterior no
      // cadastro da empresa não pode alterar uma NFC-e já autorizada.
      emitente: {
        cnpj: snapshot.emitente.cnpj,
        razaoSocial: snapshot.emitente.razaoSocial,
        inscricaoEstadual: snapshot.emitente.inscricaoEstadual,
        logradouro: snapshot.emitente.logradouro,
        numero: snapshot.emitente.numero,
        complemento: snapshot.emitente.complemento,
        bairro: snapshot.emitente.bairro,
        municipio: snapshot.emitente.municipio,
        uf: snapshot.emitente.uf,
        cep: snapshot.emitente.cep,
      },
      // Mesma lógica: congelado no snapshot (que já reflete a prioridade
      // "sale_recipients vence, mesmo pra cliente avulso" resolvida por
      // loadSaleFiscalContext no momento da emissão) — nunca `sale_recipients`
      // relido ao vivo, nunca `customers` atual.
      destinatario: (snapshot.destinatario.nome || snapshot.destinatario.cpf || snapshot.destinatario.cnpj)
        ? { nome: snapshot.destinatario.nome, cpf: snapshot.destinatario.cpf, cnpj: snapshot.destinatario.cnpj }
        : null,
      items: danfeItems,
      // Congelado no snapshot — NUNCA `sale_payments` relido ao vivo. Não
      // existe hoje uma tabela `fiscal_document_payments` separada; este
      // snapshot já cumpre exatamente esse papel (mesmo array que virou o
      // payload `formas_pagamento` enviado à Focus).
      payments: snapshot.payments.map((p) => ({
        method: p.method,
        net_amount: Number(p.netAmount),
        amount_tendered: Number(p.amountTendered ?? p.netAmount),
        change_amount: Number(p.changeAmount ?? 0),
      })),
      total: danfeItems.reduce((sum, item) => sum + item.total_amount, 0),
    },
  }
}

/** Formata a chave de acesso em 11 grupos de 4 dígitos, como no DANFE oficial. Devolve a string crua se não tiver exatamente 44 dígitos (nunca lança). */
export function formatAccessKey(accessKey: string | null): string | null {
  if (!accessKey || !/^\d{44}$/.test(accessKey)) return accessKey
  return accessKey.match(/.{1,4}/g)!.join(' ')
}
