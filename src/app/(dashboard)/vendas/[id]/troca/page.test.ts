// Regressão — liberação pontual de autorização de gerente pra troca (pedido
// do usuário 2026-08-28). Sem jsdom/Testing Library neste repo — inspeção de
// código-fonte é o padrão já usado em vendas/[id]/page.test.ts.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('vendas/[id]/troca/page — seller UUID liberado não recebe modal de autorização de gerente', () => {
  it('importa o helper centralizado de exceção (não um UUID solto no arquivo)', () => {
    expect(SOURCE).toMatch(
      /import \{ isExemptFromExchangeAuthorization \} from '@\/lib\/auth\/exchangeAuthorizationExemptions'/
    )
    expect(SOURCE).not.toMatch(/f9065bc1-7f6d-49bb-b192-f044d31541ca/)
  })

  it('requiresAuth continua exigindo autorização pra role usuario, exceto quando o helper exempta o profile.id', () => {
    expect(SOURCE).toMatch(
      /const requiresAuth = profile\?\.role === 'usuario' && !isExemptFromExchangeAuthorization\(profile\.id\)/
    )
  })

  it('não abriu nenhuma outra permissão — a única mudança no arquivo é a condição de requiresAuth', () => {
    // continua exigindo autenticação (nenhum bypass de sessão) e continua
    // buscando o profile real via getUserProfile — nenhum "role admin
    // simulado" foi introduzido.
    expect(SOURCE).toMatch(/getUserProfile\(authUser\.id, authUser\.email\)/)
    expect(SOURCE).not.toMatch(/role:\s*'admin'/)
  })
})
