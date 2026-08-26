/**
 * Mescla o destinatário fiscal (Fase Fiscal 6, pode ser parcial — só
 * CNPJ/IE, por exemplo) por CIMA do destinatário de entrega (Fase Fiscal
 * 5C, quando a venda é `delivery_mode='delivery'`) — nunca o contrário.
 *
 * Extraído de `POST /api/vendas` pra ser testável isoladamente: é a peça
 * que evita perder o endereço que `rpc_create_sale` já gravou atomicamente
 * em `sale_recipients` pra vendas de entrega. Se o formulário do PDV
 * mandasse só `{cnpj, indicador_ie}` (o operador só quis ADICIONAR dados
 * de PJ a uma venda que já tinha endereço de entrega) e a rota chamasse
 * `upsertSaleRecipient` (REPLACE, não PATCH) só com esses dois campos, o
 * endereço gravado segundos antes seria substituído por NULL. Mesclar
 * aqui, no servidor, torna a rota segura independente do que o cliente
 * mandar — nunca confia que o frontend sempre pré-preenche tudo
 * corretamente.
 */

import type { FiscalRecipientInput } from './upsertSaleRecipient'

export interface FiscalRecipientPayload {
  nome?: string | null
  cpf?: string | null
  cnpj?: string | null
  inscricao_estadual?: string | null
  indicador_ie?: 1 | 2 | 9 | null
  telefone?: string | null
  cep?: string | null
  logradouro?: string | null
  numero?: string | null
  complemento?: string | null
  bairro?: string | null
  municipio?: string | null
  uf?: string | null
  municipio_ibge?: string | null
  ibge_source?: 'viacep' | 'resolve_municipio_ibge' | 'manual_confirmado' | null
}

export interface DeliveryRecipientPayload {
  nome: string
  cpf?: string | null
  cnpj?: string | null
  telefone?: string | null
  cep: string
  logradouro: string
  numero: string
  complemento?: string | null
  bairro: string
  municipio: string
  uf: string
  municipio_ibge?: string | null
  ibge_source?: string | null
}

const EMPTY: FiscalRecipientInput = {
  nome: null, cpf: null, cnpj: null, inscricaoEstadual: null, indicadorIe: null, telefone: null,
  cep: null, logradouro: null, numero: null, complemento: null, bairro: null, municipio: null,
  municipioIbge: null, uf: null, ibgeSource: null,
}

export function buildFiscalRecipientInput(
  fiscalRecipient: FiscalRecipientPayload | null | undefined,
  deliveryRecipient: DeliveryRecipientPayload | null | undefined,
): FiscalRecipientInput | null {
  const base: FiscalRecipientInput = deliveryRecipient
    ? {
        nome: deliveryRecipient.nome, cpf: deliveryRecipient.cpf ?? null, cnpj: deliveryRecipient.cnpj ?? null,
        inscricaoEstadual: null, indicadorIe: null, telefone: deliveryRecipient.telefone ?? null,
        cep: deliveryRecipient.cep, logradouro: deliveryRecipient.logradouro, numero: deliveryRecipient.numero,
        complemento: deliveryRecipient.complemento ?? null, bairro: deliveryRecipient.bairro, municipio: deliveryRecipient.municipio,
        municipioIbge: deliveryRecipient.municipio_ibge ?? null, uf: deliveryRecipient.uf,
        ibgeSource: (deliveryRecipient.ibge_source as FiscalRecipientInput['ibgeSource']) ?? null,
      }
    : { ...EMPTY }

  if (!fiscalRecipient) return deliveryRecipient ? base : null

  return {
    nome:               fiscalRecipient.nome ?? base.nome,
    cpf:                fiscalRecipient.cpf ?? base.cpf,
    cnpj:               fiscalRecipient.cnpj ?? base.cnpj,
    inscricaoEstadual:  fiscalRecipient.inscricao_estadual ?? base.inscricaoEstadual,
    indicadorIe:        fiscalRecipient.indicador_ie ?? base.indicadorIe,
    telefone:           fiscalRecipient.telefone ?? base.telefone,
    cep:                fiscalRecipient.cep ?? base.cep,
    logradouro:         fiscalRecipient.logradouro ?? base.logradouro,
    numero:             fiscalRecipient.numero ?? base.numero,
    complemento:        fiscalRecipient.complemento ?? base.complemento,
    bairro:             fiscalRecipient.bairro ?? base.bairro,
    municipio:          fiscalRecipient.municipio ?? base.municipio,
    municipioIbge:      fiscalRecipient.municipio_ibge ?? base.municipioIbge,
    uf:                 fiscalRecipient.uf ?? base.uf,
    ibgeSource:         (fiscalRecipient.ibge_source as FiscalRecipientInput['ibgeSource']) ?? base.ibgeSource,
  }
}
