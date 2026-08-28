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
