/**
 * Normalização de nome de município pra casar com o cache IBGE — pura,
 * sem I/O. Minúsculo, sem acento, espaços colapsados/aparados. Não é uma
 * lista de cidades — só uma função de string.
 */
const COMBINING_DIACRITICS = /[̀-ͯ]/g

export function normalizeMunicipioName(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}
