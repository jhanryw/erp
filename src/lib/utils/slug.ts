/**
 * Normaliza texto em slug: minusculas, sem acento, hifens no lugar de
 * espacos/caracteres especiais. Mesma normalizacao ja usada localmente
 * em src/app/api/variacoes/valores/route.ts, extraida aqui como utilitario
 * compartilhado para novo codigo (ex.: marcas.service.ts).
 */
export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .trim()
}
