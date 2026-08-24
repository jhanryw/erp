// Regressão: sales.receipt_token NUNCA pode aparecer visualmente pro
// cliente — nem no comprovante impresso, nem na página pública. Sem
// Testing Library/jsdom configurado neste repo, a forma direta de travar
// isso é inspecionar o próprio código-fonte: todo uso de
// receipt.sale.receipt_token neste arquivo precisa estar OU dentro de
// formatShortReceiptCode(...) (representação visual derivada, nunca o
// token cru) OU dentro de buildVerificationUrl(...) (URL interna do QR —
// nunca renderizada como texto, só codificada no SVG do QR).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('comprovante (impressão interna) — receipt_token nunca renderizado cru', () => {
  it('a representação visual do código usa formatShortReceiptCode(...)', () => {
    expect(SOURCE).toContain('formatShortReceiptCode(receipt.sale.receipt_token)')
  })

  it('nenhum uso de receipt.sale.receipt_token aparece fora de formatShortReceiptCode(...)/buildVerificationUrl(...)', () => {
    const occurrences = [...SOURCE.matchAll(/receipt\.sale\.receipt_token/g)]
    expect(occurrences.length).toBeGreaterThan(0) // sanity: token ainda é usado em algum lugar (QR + código curto)

    for (const match of occurrences) {
      const start = match.index!
      const before = SOURCE.slice(Math.max(0, start - 80), start)
      const wrappedByShortCode = before.includes('formatShortReceiptCode(')
      const wrappedByUrlBuilder = before.includes('buildVerificationUrl(')
      expect(wrappedByShortCode || wrappedByUrlBuilder).toBe(true)
    }
  })

  it('a palavra "receipt_token" nunca aparece como texto visível dentro de uma tag JSX (só em comentários/código)', () => {
    // Não existe forma barata de parsear JSX aqui — mas confirmamos que o
    // texto exibido ao cliente é sempre "Código: {formatShortReceiptCode(...)}",
    // nunca "Código: {receipt.sale.receipt_token}" cru.
    expect(SOURCE).not.toMatch(/Código: \{receipt\.sale\.receipt_token\}/)
  })
})

// Regressão do crash real de produção (digest 655379705, em
// vendas/[id]/imprimir — feature irmã que compartilha exatamente este
// padrão de Server Component + botão de imprimir): "Event handlers cannot
// be passed to Client Component props". Este arquivo (comprovante/page.tsx)
// já nasceu correto (onClick sempre isolado em PrintButton.tsx), mas ganha
// o mesmo guard estrutural pra nunca regredir.
describe('comprovante (impressão interna) — Server Component nunca passa onClick', () => {
  const PAGE_CODE_ONLY = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

  it('page.tsx é Server Component (sem "use client")', () => {
    expect(SOURCE.trimStart().startsWith("'use client'")).toBe(false)
  })

  it('page.tsx não contém nenhum onClick — a interatividade fica em PrintButton/PrintTrigger', () => {
    expect(PAGE_CODE_ONLY).not.toMatch(/onClick/)
  })

  it('usa <PrintButton /> e <PrintTrigger /> (Client Components dedicados) em vez de handler inline', () => {
    expect(PAGE_CODE_ONLY).toMatch(/<PrintButton\s*\/>/)
    expect(PAGE_CODE_ONLY).toMatch(/<PrintTrigger\s*\/>/)
  })

  it('PrintButton.tsx e PrintTrigger.tsx são Client Components', () => {
    const printButtonSource = readFileSync(join(__dirname, 'PrintButton.tsx'), 'utf-8')
    const printTriggerSource = readFileSync(join(__dirname, 'PrintTrigger.tsx'), 'utf-8')
    expect(printButtonSource.trimStart().startsWith("'use client'")).toBe(true)
    expect(printTriggerSource.trimStart().startsWith("'use client'")).toBe(true)
  })
})
