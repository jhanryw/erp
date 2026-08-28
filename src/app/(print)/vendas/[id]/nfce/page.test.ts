// Regressão (auditoria pós-autorização, venda 703, 2026-09-06) — sem
// jsdom/Testing Library neste repo, inspeção de código-fonte é o padrão já
// usado em comprovante/page.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('DANFE NFC-e — ambiente explícito via querystring (item 9/10 dos testes obrigatórios)', () => {
  it('lê ?environment= da querystring, default homologacao (nunca ambíguo, nunca quebra links/bookmarks existentes)', () => {
    expect(SOURCE).toMatch(/searchParams\.environment === 'producao' \? 'producao' : 'homologacao'/)
  })

  it('continua mostrando o badge de homologação — SEM VALOR FISCAL', () => {
    expect(SOURCE).toMatch(/AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL/)
    expect(SOURCE).toMatch(/isHomologacao = danfe\.fiscalDocument\.environment !== 'producao'/)
  })

  it('nunca hardcoda um host do ERP pra montar link Focus (usa qrcode_url real, já absoluto, direto)', () => {
    expect(SOURCE).not.toMatch(/santtorini\.qarvon\.com/)
  })
})
