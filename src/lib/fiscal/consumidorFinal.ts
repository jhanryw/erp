/**
 * Resolve o indicador `consumidorFinal` (indFinal — 0=não é consumidor
 * final/revenda, 1=consumidor final) a partir de dado FISCAL real do
 * destinatário — nunca da modalidade comercial da venda (sale_type).
 *
 * Decisão de negócio explícita (fundação varejo/atacado, 2026-08-31):
 * `sale_type='wholesale'` NÃO implica automaticamente `indFinal=0`, nem
 * `sale_type='retail'` implica `indFinal=1` — retail/wholesale é uma
 * classificação COMERCIAL; indFinal é um conceito FISCAL sobre o
 * destinatário da operação. Uma venda de atacado pode ser pra uma pessoa
 * física (consumidor final) e uma venda de varejo pode ser pra uma
 * empresa — são independentes.
 *
 * Sinal usado: presença de CNPJ no destinatário (`sale_recipients.cnpj`,
 * já capturado por venda desde 20260828_sale_recipients.sql). CNPJ
 * presente é o único sinal FISCAL real disponível hoje neste ERP para
 * inferir "não é consumidor final" — não é uma regra SEFAZ documentada de
 * forma centralizada, é a melhor aproximação disponível sem inventar um
 * campo novo. Ausência de CNPJ (só CPF, ou nenhum documento) mantém o
 * comportamento anterior (sempre 1) — não piora nada que já funcionava.
 */
export function resolveConsumidorFinal(destinatarioCnpj: string | null | undefined): 0 | 1 {
  return destinatarioCnpj ? 0 : 1
}
