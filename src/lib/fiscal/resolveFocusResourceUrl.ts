/**
 * Resolução CENTRAL de qualquer recurso (DANFE, XML, XML de cancelamento,
 * etc.) devolvido pela Focus — `caminho_danfe`/`caminho_xml_nota_fiscal`/
 * `caminho_xml_cancelamento` são sempre CAMINHOS RELATIVOS (confirmado nas
 * respostas reais, ver docs/fiscal-fase2b-transmissao-homologacao.md:
 * `/notas_fiscais_consumidor/NFe....html`, `/arquivos/.../danfe.pdf`) —
 * `qrcode_url` é a exceção confirmada, sempre absoluta, e não passa por
 * esta função (usada direto).
 *
 * Achado real (auditoria pós-autorização, venda 703, 2026-09-06): antes
 * desta função existir, `<a href={result.danfePath}>`/`<a
 * href={result.xmlPath}>` usavam o caminho relativo cru como href — o
 * browser resolvia contra a origem da PÁGINA (`https://santtorini.qarvon.
 * com/arquivos_development/...`), nunca contra a Focus, resultando em 404
 * do Next.js. Esta função é o ÚNICO lugar que combina o caminho com o
 * host correto — `FOCUS_BASE_URLS[environment]`, a MESMA configuração
 * central já usada por `httpClient.ts`/`resolveFocusIntegration.ts` pra
 * chamadas de API, nunca um host hardcoded à parte (`environment` decide
 * homologação vs. produção, nunca "santtorini.qarvon.com").
 *
 * Nunca aceita um caminho vindo de fora deste processo — só o que já está
 * persistido em `fiscal_documents.danfe_path`/`xml_path` pelo próprio
 * serviço de emissão, nunca editável pelo usuário nem vindo de querystring
 * do cliente.
 */

import { FOCUS_BASE_URLS, type FocusEnvironment } from '@/lib/integrations/focus/types'

export interface ResolveFocusResourceUrlParams {
  path: string | null | undefined
  environment: FocusEnvironment
}

export function resolveFocusResourceUrl({ path, environment }: ResolveFocusResourceUrlParams): string | null {
  if (!path) return null

  // Já absoluta (http/https) — devolve como está. Nenhum campo hoje
  // (`caminho_danfe`/`caminho_xml_nota_fiscal`) é documentado como
  // absoluto, mas se a Focus algum dia mudar isso, o dado já vem do
  // nosso próprio banco (nunca do cliente) — seguro repassar sem
  // reescrever.
  if (/^https?:\/\//i.test(path)) return path

  // Protocol-relative (`//host/...`) ou uma URL de outro esquema
  // embutida no meio do caminho (`/redirect?u=http://...`) nunca são
  // resolvidos — rejeitam explicitamente em vez de arriscar apontar pra
  // um host arbitrário.
  if (path.startsWith('//')) return null
  if (path.includes('://')) return null

  // Caminho relativo simples — o único formato realmente documentado
  // pela Focus pra estes campos.
  if (!path.startsWith('/')) return null

  const base = FOCUS_BASE_URLS[environment]
  if (!base) return null

  return `${base}${path}`
}
