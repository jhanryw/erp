// Regressão — simplificação da arquitetura de impressão fiscal (decisão
// do usuário pós-testes reais de emissão): o botão principal de
// impressão da venda passa a abrir sempre o DANFE OFICIAL da Focus pra
// qualquer documento autorizado (NFC-e ou NF-e, qualquer ambiente), nunca
// mais /vendas/[id]/nfce como destino padrão. Sem jsdom/Testing Library
// neste repo — inspeção de código-fonte é o padrão já usado em
// documento-fiscal-card.test.ts/comprovante/page.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('vendas/[id]/page — printAction considera QUALQUER documento autorizado (não só produção), sempre via Focus', () => {
  it('NFC-e OU NF-e autorizada (qualquer environment) conta como authorizedDoc — nunca mais filtrado só por produção aqui', () => {
    expect(SOURCE).toMatch(/const authorizedNfce = sale\.fiscalDocuments\?\.nfce\?\.status === 'authorized' \? sale\.fiscalDocuments\.nfce : null/)
    expect(SOURCE).toMatch(/const authorizedNfe = sale\.fiscalDocuments\?\.nfe\?\.status === 'authorized' \? sale\.fiscalDocuments\.nfe : null/)
  })

  it('resolve o DANFE via resolveFocusResourceUrl (danfe_path + environment do documento), nunca concatenação manual', () => {
    expect(SOURCE).toMatch(/resolveFocusResourceUrl\(\{ path: authorizedDoc\.danfe_path, environment: authorizedDoc\.environment \}\)/)
  })

  it('nunca usa /vendas/[id]/nfce como destino do botão principal (DANFE local não é mais o padrão)', () => {
    const codeOnly = SOURCE.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    expect(codeOnly).not.toMatch(/href:\s*`\/vendas\/\$\{sale\.id\}\/nfce/)
  })

  it('autorizado sem danfe_path válido → estado "missing_danfe" com erro explícito visível, nunca cai pro comprovante em silêncio', () => {
    expect(SOURCE).toMatch(/kind: 'missing_danfe'/)
    expect(SOURCE).toMatch(/DANFE \{printAction\.label\} indisponível/)
  })

  it('sem nenhum documento autorizado → comprovante não fiscal (kind comprovante)', () => {
    expect(SOURCE).toMatch(/const printAction: PrintAction = !authorizedDoc\s*\n\s*\? \{ kind: 'comprovante' \}/)
  })

  it('mostra EnvironmentBadge junto do botão quando o DANFE aberto é de homologação — nunca esconde que é teste', () => {
    expect(SOURCE).toMatch(/printAction\.environment !== 'producao' && <EnvironmentBadge environment=\{printAction\.environment\}/)
  })
})

describe('vendas/[id]/page — auditoria de acesso fiscal: DocumentoFiscalCard liberado pra qualquer usuário autenticado da empresa', () => {
  it('não existe mais gate por role (admin) escondendo DocumentoFiscalCard — decisão de produto: operação fiscal de venda nunca foi pra ser admin-only', () => {
    const codeOnly = SOURCE.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    expect(codeOnly).not.toMatch(/profile\??\.role === 'admin'/)
  })

  it('usa requirePageRole(\'usuario\') — menor nível autenticado do ERP, nunca um gate maior', () => {
    expect(SOURCE).toMatch(/requirePageRole\('usuario'\)/)
    expect(SOURCE).not.toMatch(/requirePageRole\('admin'\)/)
    expect(SOURCE).not.toMatch(/requirePageRole\('gerente'\)/)
  })

  it('DocumentoFiscalCard é renderizado sem condicional de role — mesmo componente, mesmo estado, pra qualquer acesso autenticado', () => {
    const cardIdx = SOURCE.indexOf('<DocumentoFiscalCard')
    expect(cardIdx).toBeGreaterThan(-1)
    const before = SOURCE.slice(Math.max(0, cardIdx - 120), cardIdx)
    expect(before).not.toMatch(/&&\s*\($/)
    expect(before).not.toMatch(/role/)
  })

  it('isolamento multi-tenant: getSale é chamado com profile.company_id (nunca de params/query string) — achado real, auditoria de acesso fiscal: a query de sales não filtrava por empresa antes', () => {
    expect(SOURCE).toMatch(/getSale\(params\.id, profile\.company_id\)/)
    expect(SOURCE).toMatch(/\.from\('sales'\)\s*\n\s*\.select\('\*'\)\s*\n\s*\.eq\('id', saleId\)\s*\n\s*\.eq\('company_id', companyId\)/)
  })

  it('getSale recebe companyId como parâmetro explícito (nunca lido de dentro da função a partir de params/query)', () => {
    expect(SOURCE).toMatch(/async function getSale\(id: string, companyId: number\)/)
  })
})
