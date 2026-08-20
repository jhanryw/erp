/**
 * Regras de forma de pagamento — Fase Fiscal 3A.
 *
 * Módulo PURO: nenhuma chamada de rede, nenhum acesso a banco. Recebe o
 * método de pagamento interno (`sale_payments.method`) e a bandeira (texto
 * livre) e devolve os códigos que a Focus/SEFAZ esperam.
 *
 * Fontes (ver relatório da Fase Fiscal 3A pro detalhe completo):
 *   - `forma_pagamento` (tPag): tabela nacional confirmada via HTML bruto
 *     de campos.focusnfe.com.br + cross-check contra o XSD oficial
 *     `leiauteNFe_v4.00.xsd` (não resumo de IA).
 *   - `pix` → '20' (Pagamento Instantâneo PIX – Estático) — CONFIRMADO
 *     EMPIRICAMENTE pelos 2 XMLs reais autorizados usados como golden
 *     sample (Fase 2B): ambos usam `<tPag>20</tPag>`, não '17' (dinâmico).
 *     Reproduz o que a empresa realmente usa, não uma suposição.
 *   - `cash` → '01' (Dinheiro), `credit_card` → '03', `debit_card` → '04'
 *     — valores diretos da tabela oficial, sem ambiguidade.
 *   - `card` (legado): explicitamente NÃO suportado — o comentário do
 *     schema (`sale_payments.method`) já diz "nunca gerado pelo novo
 *     fluxo", e não há como saber se era crédito ou débito sem inventar.
 *     Lança `FiscalRuleNotImplementedError` (mesma classe de
 *     `taxRules.ts` — um único ponto de captura no service layer, não
 *     dois tipos de erro pra tratar).
 *
 * `bandeira_operadora` (tBand): mapa de texto livre (`sale_payments.
 * card_brand`) pra código numérico — só os nomes reconhecidos com certeza
 * mapeiam pro código real; qualquer coisa não reconhecida mapeia pra '99'
 * (Outros) — é o valor oficial da tabela pra exatamente esse caso ("sei
 * que é uma bandeira, não sei qual"), nunca inventamos um código
 * específico sem certeza.
 *
 * NUNCA implementado aqui (por instrução explícita, Fase Fiscal 3A):
 * `tipo_integracao`/`cnpj_credenciadora`/`numero_autorizacao`/
 * `cnpj_beneficiario`/`id_terminal_pagamento` — este ERP não tem dado
 * fiscal confiável de credenciadora/integração (`sale_payments.acquirer`
 * é texto livre, nunca um CNPJ real), e `cnpj_credenciadora` só é exigido
 * quando `tipo_integracao='1'` — o caminho seguro é nunca enviar esse
 * sub-bloco, não inventar `tipo_integracao='2'` só pra evitar a exigência.
 *
 * `installments` (`sale_payments.installments`): NUNCA vai pro payload
 * fiscal — confirmado no XSD oficial que não existe campo de parcelas em
 * `formas_pagamento`/`detPag`. Fica só como dado interno do ERP.
 */

import { FiscalRuleNotImplementedError } from './taxRules'

export type SalePaymentMethod = 'pix' | 'cash' | 'credit_card' | 'debit_card' | 'card'

const FORMA_PAGAMENTO_MAP: Partial<Record<SalePaymentMethod, string>> = {
  pix: '20',
  cash: '01',
  credit_card: '03',
  debit_card: '04',
}

/** tPag — lança FiscalRuleNotImplementedError pra 'card' (legado) ou qualquer método desconhecido. */
export function resolveFormaPagamento(method: string): string {
  const code = FORMA_PAGAMENTO_MAP[method as SalePaymentMethod]
  if (!code) {
    throw new FiscalRuleNotImplementedError(
      `resolveFormaPagamento: método de pagamento "${method}" não tem regra fiscal implementada (só pix/cash/credit_card/debit_card têm mapeamento confirmado). 'card' é legado e nunca deve chegar numa venda nova — não presuma crédito ou débito.`,
    )
  }
  return code
}

/**
 * indPag — sempre "à vista" (0). Este ERP não modela nenhuma forma de
 * pagamento "a prazo" no sentido fiscal (duplicata/boleto com vencimento
 * futuro) — pix/dinheiro/cartão são todos liquidação imediata do ponto de
 * vista do lojista, mesmo quando o cliente parcela no cartão (isso não é
 * "a prazo" pra este campo — é uma condição entre cliente e emissor do
 * cartão, sem campo fiscal correspondente, confirmado no XSD).
 */
export function resolveIndicadorPagamento(): '0' {
  return '0'
}

const BANDEIRA_OPERADORA_MAP: Record<string, string> = {
  visa: '01',
  mastercard: '02',
  amex: '03',
  'american express': '03',
  sorocred: '04',
  diners: '05',
  'diners club': '05',
  elo: '06',
  hipercard: '07',
  aura: '08',
  cabal: '09',
  alelo: '10',
  banescard: '11',
  'banes card': '11',
  calcard: '12',
  credz: '13',
  discover: '14',
  goodcard: '15',
  greencard: '16',
  hiper: '17',
  jcb: '18',
  mais: '19',
  maxvan: '20',
  policard: '21',
  redecompras: '22',
  sodexo: '23',
  valecard: '24',
  verocheque: '25',
  vr: '26',
  ticket: '27',
}

/**
 * tBand — texto livre normalizado (minúsculo, aparado) contra o mapa
 * conhecido; bandeira reconhecida mas fora do mapa (ou ausente) devolve
 * `null` (campo omitido no payload, nunca um código chutado) — '99'
 * (Outros) só quando sabemos que HÁ uma bandeira mas o texto não bate com
 * nenhuma conhecida, nunca como default silencioso pra "sem dado".
 */
export function resolveBandeiraOperadora(cardBrand: string | null): string | null {
  if (!cardBrand || !cardBrand.trim()) return null
  const key = cardBrand.trim().toLowerCase()
  return BANDEIRA_OPERADORA_MAP[key] ?? '99'
}
