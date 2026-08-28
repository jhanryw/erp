// Regressão — velocidade operacional de balcão (2026-08-28): /vendas/nova
// abre com Alexa + VAREJO + RETIRADA como defaults, mas os três continuam
// 100% editáveis, e a escolha manual do operador nunca é sobrescrita.
// Sem jsdom/Testing Library neste repo — inspeção de código-fonte é o
// padrão já usado em outras páginas (ver vendas/[id]/page.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf-8')

describe('/vendas/nova — abre com VAREJO já selecionado', () => {
  it('sale_type nasce "retail" no defaultValues do form', () => {
    expect(SOURCE).toMatch(/sale_type:\s*'retail',/)
  })

  it('saleTypeChosen nasce true — botão VAREJO aparece ativo desde a abertura, sem exigir clique', () => {
    expect(SOURCE).toMatch(/const \[saleTypeChosen, setSaleTypeChosen\] = useState\(true\)/)
  })

  it('usuário continua podendo trocar pra ATACADO — handleSaleTypeChange não está bloqueado por padrão', () => {
    expect(SOURCE).toMatch(/function handleSaleTypeChange\(next: 'retail' \| 'wholesale'\)/)
    expect(SOURCE).toMatch(/setValue\('sale_type', next\)/)
  })
})

describe('/vendas/nova — abre com RETIRADA já selecionada', () => {
  it('delivery_mode nasce "pickup" no defaultValues do form', () => {
    expect(SOURCE).toMatch(/delivery_mode:\s*'pickup',/)
  })

  it('usuário continua podendo trocar pra Envio — botão de entrega não tem condição de bloqueio', () => {
    const deliveryButtonBlock = SOURCE.match(/\{\[\s*\{ value: 'delivery'[\s\S]*?<\/div>\s*<\/div>/)
    expect(deliveryButtonBlock).not.toBeNull()
    expect(deliveryButtonBlock![0]).toMatch(/onClick=\{\(\) => setValue\('delivery_mode', value as 'pickup' \| 'delivery'\)\}/)
    expect(deliveryButtonBlock![0]).not.toMatch(/disabled/)
  })
})

describe('/vendas/nova — defaults não sobrescrevem escolha manual (re-render/carregamento assíncrono)', () => {
  it('setValue de delivery_mode só existe em UM lugar: o clique do botão (nenhum useEffect reseta depois)', () => {
    const matches = SOURCE.match(/setValue\('delivery_mode'/g) ?? []
    expect(matches.length).toBe(1)
  })

  it('setSaleTypeChosen(true) só existe dentro de handleSaleTypeChange — nenhum useEffect força Alexa/Varejo/Retirada de novo', () => {
    const matches = SOURCE.match(/setSaleTypeChosen\(true\)/g) ?? []
    // uma ocorrência no useState inicial (já coberta acima) + uma dentro do handler de clique
    expect(matches.length).toBe(1) // dentro de handleSaleTypeChange — a do useState usa a mesma string "useState(true)" != "setSaleTypeChosen(true)"
  })

  it('responsibleSellerId só é setado via SellerPicker.onChange (setResponsibleSellerId) — nenhum outro setState o sobrescreve depois de escolhido', () => {
    const matches = SOURCE.match(/setResponsibleSellerId/g) ?? []
    // 1x na declaração do useState + 1x passado como onChange pro SellerPicker
    expect(matches.length).toBe(2)
  })
})

describe('/vendas/nova — payload final reflete a escolha atual, nunca os defaults originais', () => {
  it('POST /api/vendas envia ...data (valores atuais do form) e responsibleSellerId (estado atual), nunca um literal fixo', () => {
    const bodyBlock = SOURCE.match(/body: JSON\.stringify\(\{\s*\.\.\.data,[\s\S]*?\}\),/)
    expect(bodyBlock).not.toBeNull()
    expect(bodyBlock![0]).toMatch(/responsible_seller_id:\s*responsibleSellerId,/)
    expect(bodyBlock![0]).not.toMatch(/'retail'|'pickup'|Alexa/)
  })
})
