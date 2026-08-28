/**
 * `fiscal_documents.danfe_path` guarda o `caminho_danfe` bruto devolvido
 * pela Focus — confirmado nas respostas reais (ver
 * docs/fiscal-fase2b-transmissao-homologacao.md) que é sempre um CAMINHO
 * RELATIVO (ex. `/notas_fiscais_consumidor/NFe....html`,
 * `/arquivos/.../danfe.pdf`), nunca uma URL absoluta. Esta função é o
 * ÚNICO lugar que combina esse caminho com o host correto
 * (`FOCUS_BASE_URLS[environment]`) — nunca hardcoded, nunca aceita um
 * caminho vindo de fora deste processo (só o que já está persistido em
 * `fiscal_documents.danfe_path`, nunca editável pelo usuário).
 *
 * Rejeita qualquer coisa que não seja um caminho relativo simples —
 * bloqueia URL absoluta embutida (`http://`/`https://`) e
 * protocol-relative (`//host/...`), que redirecionariam pra um host
 * arbitrário se esse valor algum dia viesse de uma fonte não confiável.
 */

import { FOCUS_BASE_URLS, type FocusEnvironment } from '@/lib/integrations/focus/types'

export function buildFocusDanfeUrl(environment: FocusEnvironment, danfePath: string | null | undefined): string | null {
  if (!danfePath) return null
  if (!danfePath.startsWith('/') || danfePath.startsWith('//')) return null
  if (danfePath.includes('://')) return null

  const base = FOCUS_BASE_URLS[environment]
  if (!base) return null

  return `${base}${danfePath}`
}
