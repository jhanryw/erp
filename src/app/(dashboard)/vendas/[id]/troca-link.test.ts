// Regressão: o fluxo administrativo de troca continua exclusivamente
// dentro do ERP autenticado (/vendas/[id] → "Registrar Troca" →
// /vendas/[id]/troca) — garante que a remoção do botão de troca da página
// PÚBLICA (/comprovante/[token]) não levou junto, por engano, o link
// interno equivalente na página da venda.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('vendas/[id] — link administrativo de troca continua disponível no ERP', () => {
  it('contém o link para /vendas/[id]/troca', () => {
    expect(SOURCE).toMatch(/\/vendas\/\$\{sale\.id\}\/troca/)
  })

  it('contém o texto "Registrar Troca"', () => {
    expect(SOURCE).toMatch(/Registrar Troca/)
  })

  it('continua tendo o botão "Imprimir Comprovante" (segunda via, comercial independente do fiscal)', () => {
    expect(SOURCE).toMatch(/\/vendas\/\$\{sale\.id\}\/comprovante/)
    expect(SOURCE).toMatch(/Imprimir Comprovante/)
  })
})
