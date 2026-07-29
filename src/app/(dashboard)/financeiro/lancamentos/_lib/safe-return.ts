// Só aceita caminhos internos que comecem por /financeiro/lancamentos — o
// parâmetro "from" chega via URL (compartilhável), então nunca é confiável
// por si só. Sem essa checagem, um link malicioso do tipo
// ".../editar?from=https://phish.example" causaria um redirect aberto após
// salvar ou cancelar a edição.
export function safeReturnPath(from: string | null): string {
  if (!from) return '/financeiro/lancamentos'
  // Bloqueia URLs absolutas e protocol-relative ("//host/...") disfarçadas
  // de caminho relativo.
  if (from.includes('://') || from.startsWith('//')) return '/financeiro/lancamentos'
  if (!from.startsWith('/financeiro/lancamentos')) return '/financeiro/lancamentos'
  return from
}
