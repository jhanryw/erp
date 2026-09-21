/** Remove caracteres que quebrariam a sintaxe do filtro `.or()` do PostgREST (`,` `(` `)` e curingas). */
export function sanitizePostgrestSearch(search: string): string {
  return search.replace(/[,()%*\\]/g, ' ').trim()
}
