/**
 * Normalização/validação de NCM — fechamento de blocker de readiness
 * (antes da primeira emissão real).
 *
 * Módulo PURO: nenhuma chamada de rede, nenhum acesso a banco.
 *
 * Por que existe separado de `validateFiscalReadiness`/`buildNfePayload`:
 * o cadastro de produto (`/api/produtos`, `src/lib/validators/index.ts`)
 * já força NCM a bater com `^\d{8}$` — mas isso só protege dado que passa
 * por ESSE formulário/rota. Dado legado ou importado direto no banco pode
 * ter NCM ausente, com pontuação (`"6108.22.00"`), com menos/mais dígitos,
 * ou com letras — `validateFiscalReadiness` rodava só uma checagem de
 * PRESENÇA antes desta revisão, nunca revalidava formato no momento da
 * emissão. Esta função é a fonte única de normalização/validação,
 * reutilizada tanto por `validateFiscalReadiness` (decide se bloqueia)
 * quanto por `buildNfePayload` (decide o valor exato enviado à Focus —
 * nunca envia pontuação, mesmo que o cadastro tenha).
 */

/**
 * Remove qualquer caractere não-numérico (pontuação, espaços) e confirma
 * que o resultado tem exatamente 8 dígitos — formato exigido pela SEFAZ.
 * Devolve `null` se `raw` for vazio/ausente OU se, depois de normalizado,
 * não resultar em exatamente 8 dígitos (letras, 7 dígitos, 9 dígitos, etc.).
 * Nunca lança — quem chama decide o que fazer com `null`.
 */
export function normalizeNcm(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const digits = raw.replace(/\D/g, '')
  return /^\d{8}$/.test(digits) ? digits : null
}
