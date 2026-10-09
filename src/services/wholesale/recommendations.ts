/**
 * Ordem determinística "aleatória" para as recomendações do carrinho.
 *
 * Cada produto recebe uma pontuação `hash(seed, productId)`; a ordenação por essa pontuação
 * parece aleatória entre sessões (seeds diferentes), mas é ESTÁVEL dentro de uma sessão: tirar
 * um produto do conjunto elegível (porque entrou no carrinho ou acabou o estoque) não embaralha
 * os demais — só o próximo da fila ocupa a vaga. Sem estado no servidor, sem cache.
 */

/** FNV-1a 32 bits — suficiente para dispersão; não é criptográfico (e não precisa ser). */
export function seededScore(seed: string, productId: number): number {
  let hash = 0x811c9dc5
  const input = `${seed}:${productId}`
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** Ids na ordem da seed (empate → menor id, para ser total e determinístico). */
export function rankBySeed(productIds: number[], seed: string): number[] {
  return [...productIds].sort((a, b) => seededScore(seed, a) - seededScore(seed, b) || a - b)
}

export const RECOMMENDATION_MAX = 6
export const RECOMMENDATION_MIN = 4
