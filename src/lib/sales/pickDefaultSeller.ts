import type { Seller } from '@/app/api/sellers/route'

/**
 * Velocidade operacional de balcão (2026-08-28) — default inicial é a
 * vendedora "Alexa" quando ela existe entre os vendedores ATIVOS da empresa
 * atual. `sellers` já chega aqui escopado por company_id via GET
 * /api/sellers — nunca por posição do array, e esta função nunca sabe de
 * vendedor de outra empresa, só do que recebe. Se já houver um valor
 * selecionado, ou se não houver "Alexa" nesta empresa, não inventa outro
 * default.
 */
export function pickDefaultSeller(sellers: Seller[], currentValue: number | null): number | null {
  if (currentValue != null) return currentValue
  const alexa = sellers.find((s) => s.name.trim().toLowerCase() === 'alexa')
  return alexa ? alexa.id : null
}
