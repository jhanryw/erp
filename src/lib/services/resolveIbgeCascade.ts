/**
 * Cascata de resolução do código IBGE de município — Fase Fiscal 5C.
 *
 * Nunca pede ao vendedor para digitar o código IBGE. Duas camadas, nesta
 * ordem:
 *   1. ViaCEP — a consulta de CEP já traz o campo `ibge` na resposta (ver
 *      `cepService.ts`); usado direto quando presente e no formato correto
 *      (7 dígitos), sem nenhuma chamada de rede extra.
 *   2. `resolveMunicipioIbge` (Fase Fiscal 2B, já existente) — fallback por
 *      UF + nome do município, via cache local (`ibge_municipios`) + API
 *      pública do IBGE. Usado quando o CEP não tem `ibge` (raro) ou quando
 *      a resolução não veio de um CEP (ex.: usuário digitou UF/cidade sem
 *      CEP, ou correção manual).
 *
 * Nunca inventa/aproxima um código — se as duas camadas falharem, devolve
 * `{ codigo: null, source: null }` e quem chama trata como campo ausente
 * (mesmo padrão já usado em toda a Fase Fiscal 2B/4).
 */

import { resolveMunicipioIbge } from '@/services/fiscal/resolveMunicipioIbge'

export type IbgeSource = 'viacep' | 'resolve_municipio_ibge'

export interface IbgeCascadeResult {
  codigo: string | null
  source: IbgeSource | null
}

const IBGE_FORMAT = /^\d{7}$/

/**
 * Valida o formato de um código IBGE (7 dígitos numéricos). Não valida se
 * o código corresponde a um município real — só o formato.
 */
export function isValidIbgeFormat(value: string | null | undefined): value is string {
  return value != null && IBGE_FORMAT.test(value)
}

/**
 * Resolve o código IBGE a partir de um valor já retornado pelo ViaCEP
 * (camada 1) com fallback para `resolveMunicipioIbge` por UF+município
 * (camada 2). `viaCepIbge` deve ser o campo `ibge` bruto da resposta do
 * ViaCEP, quando disponível (ou `null`/`undefined` se a consulta não veio
 * de um CEP).
 */
export async function resolveIbgeCascade(input: {
  viaCepIbge?: string | null
  uf: string | null
  municipio: string | null
}): Promise<IbgeCascadeResult> {
  if (isValidIbgeFormat(input.viaCepIbge)) {
    return { codigo: input.viaCepIbge, source: 'viacep' }
  }

  const codigo = await resolveMunicipioIbge(input.uf, input.municipio)
  if (isValidIbgeFormat(codigo)) {
    return { codigo, source: 'resolve_municipio_ibge' }
  }

  return { codigo: null, source: null }
}
