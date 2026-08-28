// Regressão — velocidade operacional de balcão (2026-08-28). Sem
// jsdom/plugin de React no vitest deste repo (confirmado: importar um
// .tsx quebra o parse) — inspeção de código-fonte é o padrão já usado pra
// outros componentes/páginas. A lógica de escolha em si (pickDefaultSeller)
// é testada isoladamente em src/lib/sales/pickDefaultSeller.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'SellerPicker.tsx'), 'utf-8')
const ROUTE_SOURCE = readFileSync(
  join(process.cwd(), 'src/app/api/sellers/route.ts'),
  'utf-8',
)

describe('SellerPicker — fiação do default de vendedor', () => {
  it('usa o helper centralizado pickDefaultSeller (nenhuma lógica de default duplicada aqui)', () => {
    expect(SOURCE).toMatch(/import \{ pickDefaultSeller \} from '@\/lib\/sales\/pickDefaultSeller'/)
  })

  it('o efeito de carregar vendedores roda uma única vez (deps vazias) — nunca re-seleciona Alexa depois que o usuário já escolheu outra pessoa', () => {
    const effectMatch = SOURCE.match(/useEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[\]\)/)
    expect(effectMatch).not.toBeNull()
    expect(effectMatch![0]).toMatch(/pickDefaultSeller\(json\.sellers, value\)/)
  })

  it('trocar de vendedor continua chamando onChange(seller.id) direto no clique — nunca bloqueado', () => {
    expect(SOURCE).toMatch(/onClick=\{\(\) => onChange\(seller\.id\)\}/)
  })

  it('GET /api/sellers continua escopando por company_id da sessão (nunca confia em valor do cliente)', () => {
    expect(ROUTE_SOURCE).toMatch(/\.eq\('company_id', user\.company_id\)/)
  })
})
