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

// Regressão: o shell inteiro do ERP (Sidebar/Topbar/BottomTabBar) aparecia
// na tela E na impressão de /vendas/[id]/comprovante porque a rota vivia
// sob o route group (dashboard), cujo layout.tsx renderiza esse shell pra
// TODA página filha. Corrigido movendo a rota pro route group (print),
// isolado, com layout.tsx próprio que só repassa children.
describe('comprovante (impressão interna) — isolado do shell do ERP', () => {
  it('a rota vive sob o route group (print), não (dashboard)', () => {
    // __dirname aqui é .../src/app/(print)/vendas/[id]/comprovante
    expect(__dirname).toContain(`${join('src', 'app', '(print)', 'vendas')}`)
    expect(__dirname).not.toContain(`${join('(dashboard)', 'vendas', '[id]', 'comprovante')}`)
  })

  it('(print)/layout.tsx existe e NÃO importa Sidebar/Topbar/BottomTabBar/UserRoleProvider', () => {
    const printLayoutPath = join(__dirname, '..', '..', '..', 'layout.tsx')
    const printLayoutSource = readFileSync(printLayoutPath, 'utf-8')
    // Só o código (sem comentários) — o próprio layout.tsx documenta em
    // prosa por que esses componentes NÃO estão aqui, o que faria uma
    // checagem de texto ingênua contra o arquivo inteiro dar falso positivo.
    const codeOnly = printLayoutSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    expect(codeOnly).not.toMatch(/Sidebar|Topbar|BottomTabBar|UserRoleProvider/)
  })
})

describe('comprovante (impressão interna) — QR usa a origem real da requisição', () => {
  it('resolve a URL de verificação a partir de headers() da requisição, não só de NEXT_PUBLIC_APP_URL', () => {
    expect(SOURCE).toMatch(/from 'next\/headers'/)
    expect(SOURCE).toMatch(/headers\(\)/)
    expect(SOURCE).toMatch(/x-forwarded-host/)
  })

  it('NEXT_PUBLIC_APP_URL agora é só fallback secundário (usado somente quando headers() não tem host)', () => {
    const idx = SOURCE.indexOf('NEXT_PUBLIC_APP_URL')
    expect(idx).toBeGreaterThan(-1)
    const before = SOURCE.slice(0, idx)
    expect(before).toContain('x-forwarded-host')
  })
})

describe('comprovante (impressão interna) — regra definitiva de impressão/QR Code (nunca mostra QR interno com documento fiscal autorizado)', () => {
  it('consulta findAuthorizedFiscalDocument ANTES de montar o comprovante (getReceiptForSalePrint)', () => {
    const authIdx = SOURCE.indexOf('findAuthorizedFiscalDocument(saleId')
    const receiptIdx = SOURCE.indexOf('getReceiptForSalePrint({')
    expect(authIdx).toBeGreaterThan(-1)
    expect(receiptIdx).toBeGreaterThan(-1)
    expect(authIdx).toBeLessThan(receiptIdx)
  })

  it('NFC-e autorizada redireciona pra /vendas/[id]/nfce, nunca renderiza o comprovante', () => {
    expect(SOURCE).toMatch(/authorizedDoc\?\.documentType === 'nfce'/)
    expect(SOURCE).toMatch(/redirect\(`\/vendas\/\$\{saleId\}\/nfce`\)/)
  })

  it('NF-e autorizada usa buildFocusDanfeUrl (nunca aceita danfe_path bruto/arbitrário)', () => {
    expect(SOURCE).toMatch(/authorizedDoc\?\.documentType === 'nfe'/)
    expect(SOURCE).toMatch(/buildFocusDanfeUrl\(authorizedDoc\.environment, authorizedDoc\.danfePath\)/)
  })

  it('nunca redireciona pra uma URL vinda direto do request/cliente — só pro que buildFocusDanfeUrl devolveu', () => {
    expect(SOURCE).not.toMatch(/redirect\(params\./)
    expect(SOURCE).not.toMatch(/redirect\(request\./)
  })
})

describe('comprovante (impressão interna) — conteúdo do modelo aprovado', () => {
  it('nome da loja não é mais lido de company_fiscal_settings/companies (removido do arquivo)', () => {
    expect(SOURCE).not.toMatch(/company_fiscal_settings|nome_fantasia|razao_social/)
  })

  it('contém a seção de Trocas com o texto literal informado', () => {
    expect(SOURCE).toMatch(/Trocas em até 7 dias mediante apresentação deste comprovante\./)
  })

  it('contém o disclaimer final em duas linhas (Comprovante não fiscal. / Não substitui NF-e\\/NFC-e.)', () => {
    expect(SOURCE).toMatch(/Comprovante não fiscal\./)
    expect(SOURCE).toMatch(/Não substitui NF-e\/NFC-e\./)
  })

  it('happy path do QR usa o rótulo "Código curto:"', () => {
    expect(SOURCE).toMatch(/Código curto: \{formatShortReceiptCode/)
  })
})
