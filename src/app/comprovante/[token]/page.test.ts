// Auditoria/regressão da página pública de verificação — decisão
// definitiva: /comprovante/[token] é a página do CLIENTE, sempre
// read-only, nunca mostra ação administrativa (nem "Registrar troca", nem
// qualquer outra), mesmo com sessão ERP autenticada aberta no navegador.
// sales.receipt_token completo (UUID) também nunca pode aparecer aqui, nem
// como texto, nem como label "token"/"receipt_token".
//
// Sem Testing Library/jsdom neste repo, a forma direta de travar isso é
// inspecionar o próprio código-fonte.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

// Só o código (sem comentários `//...`) — os comentários deste arquivo
// DOCUMENTAM deliberadamente o que NÃO deve aparecer/existir (ex.: "NUNCA
// CPF de cliente", "botão Registrar Troca" citado em prosa explicando a
// decisão), o que faria uma checagem ingênua de texto contra o arquivo
// inteiro disparar falso positivo.
const CODE_ONLY = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '') // comentários de bloco (inclusive JSX {/* ... */})
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

describe('página pública /comprovante/[token] — sempre read-only, nunca ação administrativa', () => {
  it('nenhum botão/link de "Registrar troca" existe no código (nem condicional, nem incondicional)', () => {
    expect(CODE_ONLY).not.toMatch(/Registrar\s+[Tt]roca/)
  })

  it('nenhum link para /vendas/[id]/troca (ou qualquer rota administrativa do ERP) existe nesta página', () => {
    expect(CODE_ONLY).not.toMatch(/\/vendas\/\$\{sale\.id\}\/troca/)
    expect(CODE_ONLY).not.toMatch(/\/troca/)
  })

  it('nenhum resquício de checagem de sessão/autorização ficou órfão (showExchangeButton, canRegisterExchange, etc.)', () => {
    expect(CODE_ONLY).not.toMatch(/showExchangeButton/)
    expect(CODE_ONLY).not.toMatch(/canRegisterExchange/)
    expect(CODE_ONLY).not.toMatch(/hasMinRole/)
    expect(CODE_ONLY).not.toMatch(/getUserProfile/)
    // createClient (sessão Supabase) não é mais importado/usado nesta
    // página — ela só lê via getReceiptByToken, nunca verifica quem está
    // olhando.
    expect(CODE_ONLY).not.toMatch(/createClient/)
  })

  it('não importa componentes de ação (Button, Link) que só fariam sentido para uma ação administrativa', () => {
    expect(CODE_ONLY).not.toMatch(/from '@\/components\/ui\/button'/)
    expect(CODE_ONLY).not.toMatch(/from 'next\/link'/)
  })

  it('é estritamente read-only — nenhum POST/fetch/mutação/form em todo o arquivo', () => {
    expect(CODE_ONLY).not.toMatch(/method:\s*['"]POST['"]/)
    expect(CODE_ONLY).not.toMatch(/<form/)
    expect(CODE_ONLY).not.toMatch(/\.rpc\(/)
    expect(CODE_ONLY).not.toMatch(/\.insert\(|\.update\(|\.delete\(/)
  })

  it('receipt.sale.receipt_token (ou qualquer variação) nunca é lido/renderizado nesta página', () => {
    expect(CODE_ONLY).not.toMatch(/receipt\.sale\.receipt_token/)
    expect(CODE_ONLY).not.toMatch(/sale\.receipt_token/)
  })

  it('nenhum label "token"/"receipt_token" é renderizado como texto pro visitante', () => {
    expect(CODE_ONLY).not.toMatch(/>Token[:\s]/)
    expect(CODE_ONLY).not.toMatch(/receipt_token[:\s]*</)
  })

  it('não busca/renderiza CPF, telefone ou nome de cliente (getReceiptByToken já não retorna isso)', () => {
    expect(CODE_ONLY).not.toMatch(/\bcpf\b/i)
    expect(CODE_ONLY).not.toMatch(/customer\.name|receipt\.customer/)
  })

  it('continua mostrando elegibilidade de troca de forma só informativa (já trocada/elegível), sem virar ação', () => {
    // A informação de elegibilidade (requisito original da página pública)
    // continua — é dado, não ação. Só a AÇÃO (botão/link) foi removida.
    expect(CODE_ONLY).toMatch(/já trocada|elegível/)
  })
})
