// Regressão — velocidade operacional de balcão (2026-08-28): "Alexa" passa
// a ser o vendedor padrão em /vendas/nova quando existe na empresa atual.
// Fonte de vendedores (`sellers`) já chega aqui escopada por company_id via
// GET /api/sellers — a função nunca sabe de outra empresa, só do array que
// recebe.
import { describe, it, expect } from 'vitest'
import { pickDefaultSeller } from './pickDefaultSeller'
import type { Seller } from '@/app/api/sellers/route'

const ALEXA: Seller     = { id: 42, name: 'Alexa' }
const YASMIM: Seller    = { id: 7,  name: 'Yasmim' }
const ALEXANDRE: Seller = { id: 9,  name: 'Alexandre' }

describe('pickDefaultSeller', () => {
  it('retorna o id de Alexa quando ela existe na lista e nada foi selecionado ainda', () => {
    expect(pickDefaultSeller([YASMIM, ALEXA], null)).toBe(42)
  })

  it('match é case-insensitive e tolera espaços', () => {
    expect(pickDefaultSeller([{ id: 5, name: '  ALEXA  ' }], null)).toBe(5)
    expect(pickDefaultSeller([{ id: 6, name: 'alexa' }], null)).toBe(6)
  })

  it('não confunde "Alexandre"/nomes parecidos com "Alexa" — match é exato, nunca substring', () => {
    expect(pickDefaultSeller([ALEXANDRE], null)).toBeNull()
  })

  it('nunca sobrescreve uma seleção já feita pelo usuário, mesmo que Alexa exista', () => {
    expect(pickDefaultSeller([ALEXA, YASMIM], 7)).toBe(7)
  })

  it('se Alexa não existe na empresa atual, não inventa outro vendedor — retorna null (sem seleção)', () => {
    expect(pickDefaultSeller([YASMIM, ALEXANDRE], null)).toBeNull()
  })

  it('lista vazia → null, nunca escolhe por posição do array', () => {
    expect(pickDefaultSeller([], null)).toBeNull()
  })

  it('vendedor de outra empresa não pode virar default: a função só enxerga o array recebido — se a "Alexa" de outra company não está nele, ela não é escolhida', () => {
    // Simula o array já filtrado por company_id como GET /api/sellers
    // devolve — a "Alexa" de outra empresa nunca chega até aqui.
    const sellersDestaEmpresaSemAlexa: Seller[] = [YASMIM, ALEXANDRE]
    expect(pickDefaultSeller(sellersDestaEmpresaSemAlexa, null)).toBeNull()
  })
})
