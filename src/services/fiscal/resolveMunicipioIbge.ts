/**
 * Resolução de código IBGE de município — Fase Fiscal 2B.
 *
 * Arquitetura: cache-first contra `public.ibge_municipios`, com fallback
 * pra API pública do IBGE (`servicodados.ibge.gov.br`) na primeira vez que
 * um (uf, nome) aparece. NUNCA uma lista de cidades hardcoded no código —
 * a única "lista" é o cache, que se popula sozinho a partir da fonte
 * oficial do governo.
 *
 * Falha (rede indisponível, UF inválida, nome sem correspondência) nunca
 * lança — devolve `null`, e quem chama (`loadSaleFiscalContext`) já trata
 * `municipioIbge: null` como campo ausente normal, sinalizado por
 * `validateFiscalReadiness`.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeMunicipioName } from '@/lib/fiscal/normalizeMunicipioName'

const IBGE_API_TIMEOUT_MS = 8_000

interface IbgeMunicipioApiResult {
  id: number
  nome: string
}

async function fetchMunicipiosFromIbgeApi(uf: string): Promise<IbgeMunicipioApiResult[] | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), IBGE_API_TIMEOUT_MS)
  try {
    const response = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(uf)}/municipios`, {
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = await response.json()
    if (!Array.isArray(data)) return null
    return data
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Resolve o código IBGE (7 dígitos) de um município a partir de UF + nome.
 * Consulta o cache primeiro; em cache-miss, busca na API pública do IBGE,
 * grava o cache pra próxima vez, e devolve o código encontrado.
 */
export async function resolveMunicipioIbge(uf: string | null, municipio: string | null): Promise<string | null> {
  if (!uf || !municipio) return null

  const ufNormalizado = uf.trim().toUpperCase()
  const nomeNormalizado = normalizeMunicipioName(municipio)
  if (!ufNormalizado || !nomeNormalizado) return null

  const admin = createAdminClient()

  const { data: cached } = await (admin as any)
    .from('ibge_municipios')
    .select('codigo_ibge')
    .eq('uf', ufNormalizado)
    .eq('nome_normalizado', nomeNormalizado)
    .maybeSingle() as { data: { codigo_ibge: string } | null }

  if (cached) return cached.codigo_ibge

  const municipios = await fetchMunicipiosFromIbgeApi(ufNormalizado)
  if (!municipios) return null

  const match = municipios.find((m) => normalizeMunicipioName(m.nome) === nomeNormalizado)
  if (!match) return null

  const codigoIbge = String(match.id)

  // Cache best-effort — se o INSERT falhar (ex.: corrida entre duas
  // requisições simultâneas resolvendo o mesmo município), não é motivo
  // pra falhar a resolução em si; o valor já foi encontrado pela API.
  await (admin as any)
    .from('ibge_municipios')
    .upsert(
      { codigo_ibge: codigoIbge, uf: ufNormalizado, nome: match.nome, nome_normalizado: nomeNormalizado },
      { onConflict: 'codigo_ibge' },
    )

  return codigoIbge
}
