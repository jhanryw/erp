/**
 * Upsert do destinatário fiscal de uma venda — Fase Fiscal 6 (PDV —
 * comprovante/NFC-e/NF-e na venda).
 *
 * Único ponto do projeto que ESCREVE em `sale_recipients` fora da própria
 * transação de `rpc_create_sale` (que só cobre `delivery_mode='delivery'`,
 * ver POST /api/vendas). Usado em dois pontos, ambos DEPOIS da venda já
 * existir:
 *   1. Fechamento do PDV, quando o operador escolhe NFC-e (com CPF) ou
 *      NF-e e a venda NÃO é uma entrega (balcão/retirada) — sem isso,
 *      `sale_recipients` nunca seria criada pra essas vendas (achado da
 *      auditoria curta desta fase, requisito 9 do pedido).
 *   2. "Completar dados fiscais" na tela da venda (emissão posterior),
 *      quando o destinatário estava incompleto no fechamento.
 *
 * Deliberadamente NÃO atômico com a criação da venda (mesmo padrão já
 * aceito neste projeto pra `shipments`: "erro é não-fatal, a venda já foi
 * criada") — ver `202609021000_fiscal_recipient_pj_fields.sql` pro racional
 * completo de por que reescrever `rpc_create_sale` (function de ~600
 * linhas) só pra isso seria desproporcional. Se este upsert falhar, a
 * venda continua válida — a emissão fiscal simplesmente fica pendente até
 * o operador tentar de novo (requisito 16 do pedido: "a venda já pode ter
 * sido concluída... emissão fica pendente").
 *
 * REPLACE, não PATCH: cada chamada grava exatamente os campos passados —
 * campos ausentes do input viram NULL na linha (nunca preserva um valor
 * anterior "por baixo dos panos"). Diferente da semântica PATCH do
 * importador de produtos (Fase 2) de propósito: aqui o chamador (UI de
 * "completar dados fiscais") sempre pré-carrega o formulário com o que já
 * existe antes de deixar o operador editar — cada submit representa o
 * estado COMPLETO pretendido do destinatário, não um diff. Evita a
 * complexidade de merge parcial pra um fluxo de baixa frequência (no
 * máximo duas gravações por venda: fechamento + uma complementação).
 *
 * Multi-tenant: `saleId` é sempre validado contra `companyId` ANTES de
 * qualquer escrita — nunca upsert cego por `sale_id` isolado.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { ServiceOutcome } from '@/services/produtos.service'

export interface FiscalRecipientInput {
  nome: string | null
  cpf: string | null
  cnpj: string | null
  inscricaoEstadual: string | null
  indicadorIe: 1 | 2 | 9 | null
  telefone: string | null
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  municipio: string | null
  municipioIbge: string | null
  uf: string | null
  ibgeSource: 'viacep' | 'resolve_municipio_ibge' | 'manual_confirmado' | null
}

export interface SaleRecipientRow extends FiscalRecipientInput {
  saleId: number
}

function success<T>(data: T): ServiceOutcome<T> {
  return { ok: true, data }
}

function failure(error: string, status = 500): ServiceOutcome<never> {
  return { ok: false, error, status }
}

/** Nada informado — não vale a pena criar/manter uma linha vazia em `sale_recipients`. */
function isEmptyInput(input: FiscalRecipientInput): boolean {
  return Object.entries(input).every(([key, value]) => key === 'ibgeSource' || value == null)
}

export async function upsertSaleRecipient(
  saleId: number,
  companyId: number,
  input: FiscalRecipientInput,
): Promise<ServiceOutcome<{ saleId: number } | null>> {
  const admin = createAdminClient()

  const { data: sale, error: saleError } = await (admin as any)
    .from('sales')
    .select('id')
    .eq('id', saleId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (saleError) return failure(`Falha ao validar venda: ${saleError.message}`)
  if (!sale) return failure('Venda não encontrada nesta empresa.', 404)

  if (isEmptyInput(input)) {
    // Nada pra salvar — não cria linha vazia. Não é erro (o operador pode
    // legitimamente estar emitindo NFC-e sem identificar o consumidor).
    return success(null)
  }

  const { error } = await (admin as any)
    .from('sale_recipients')
    .upsert(
      {
        sale_id: saleId,
        company_id: companyId,
        nome: input.nome,
        cpf: input.cpf,
        cnpj: input.cnpj,
        inscricao_estadual: input.inscricaoEstadual,
        indicador_ie: input.indicadorIe,
        telefone: input.telefone,
        cep: input.cep,
        logradouro: input.logradouro,
        numero: input.numero,
        complemento: input.complemento,
        bairro: input.bairro,
        municipio: input.municipio,
        municipio_ibge: input.municipioIbge,
        uf: input.uf ? input.uf.toUpperCase() : null,
        ibge_source: input.ibgeSource,
      },
      { onConflict: 'sale_id' },
    )

  if (error) return failure(`Falha ao salvar destinatário fiscal: ${error.message}`)
  return success({ saleId })
}

/** Carrega o destinatário fiscal atual de uma venda, pra pré-preencher o formulário de "completar dados". `null` quando não existe nenhum snapshot ainda. */
export async function getSaleRecipient(saleId: number, companyId: number): Promise<ServiceOutcome<SaleRecipientRow | null>> {
  const admin = createAdminClient()

  const { data: sale, error: saleError } = await (admin as any)
    .from('sales')
    .select('id')
    .eq('id', saleId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (saleError) return failure(`Falha ao validar venda: ${saleError.message}`)
  if (!sale) return failure('Venda não encontrada nesta empresa.', 404)

  const { data, error } = await (admin as any)
    .from('sale_recipients')
    .select('nome, cpf, cnpj, inscricao_estadual, indicador_ie, telefone, cep, logradouro, numero, complemento, bairro, municipio, municipio_ibge, uf, ibge_source')
    .eq('sale_id', saleId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) return failure(`Falha ao carregar destinatário fiscal: ${error.message}`)
  if (!data) return success(null)

  return success({
    saleId,
    nome: data.nome ?? null,
    cpf: data.cpf ?? null,
    cnpj: data.cnpj ?? null,
    inscricaoEstadual: data.inscricao_estadual ?? null,
    indicadorIe: (data.indicador_ie as 1 | 2 | 9 | null) ?? null,
    telefone: data.telefone ?? null,
    cep: data.cep ?? null,
    logradouro: data.logradouro ?? null,
    numero: data.numero ?? null,
    complemento: data.complemento ?? null,
    bairro: data.bairro ?? null,
    municipio: data.municipio ?? null,
    municipioIbge: data.municipio_ibge ?? null,
    uf: data.uf ?? null,
    ibgeSource: (data.ibge_source as SaleRecipientRow['ibgeSource']) ?? null,
  })
}
