/**
 * Regressão dedicada — "o preço fiscal é o preço efetivamente registrado
 * na venda, não o preço atual do cadastro" (Fase Fiscal 7, itens 39-42 e
 * 68 do pedido de implementação final do fiscal no PDV).
 *
 * `loadSaleFiscalContext.ts` (confirmado por auditoria, linhas 96-99/154)
 * só lê `sale_items.unit_price` — nunca `products.price`/
 * `product_variations.price_override`. Este arquivo não re-testa esse I/O
 * (isso é uma propriedade estática do SELECT, não de lógica), mas prova
 * que, uma vez que `unitPrice` entra no `FiscalDocumentContext`, ele
 * atravessa intacto até o snapshot e o payload Focus, e que nada aqui
 * reintroduz uma segunda leitura de preço a partir de um "cadastro atual".
 */
import { describe, it, expect } from 'vitest'
import { buildFiscalDocumentSnapshot } from './buildFiscalSnapshot'
import { buildNfcePayload } from './buildNfcePayload'
import { baseFiscalContext } from './testFixtures'

describe('Integridade de preço PDV → fiscal — "Conjunto X" (cenário do pedido, item 68)', () => {
  it('cadastro R$50,00, vendido a R$45,00 (2 un.) → total fiscal = R$90,00, nunca R$100,00', () => {
    const ctx = baseFiscalContext({
      saleTotal: 90,
      operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
      items: [{
        saleItemId: 1, productId: 10, variationId: 100,
        description: 'Conjunto X', sku: 'CONJUNTO-X',
        quantity: 2,
        unitPrice: 45, // preço EFETIVO da venda — o cadastro (50) nunca entra aqui
        discountAmount: 0, unit: 'UN', ncm: '61082200', cest: null, origem: 2,
      }],
      payments: [{ method: 'pix', netAmount: 90, cardBrand: null }],
    })

    const snapshot = buildFiscalDocumentSnapshot(ctx)
    expect(snapshot.items[0].total_amount).toBe(90)

    const payload = buildNfcePayload(ctx)
    const item = payload.items[0]
    expect(item.valor_unitario_comercial).toBe(45)
    expect(item.valor_unitario_tributavel).toBe(45)
    expect(item.valor_bruto).toBe(90)
    // O preço de cadastro (50) não aparece em nenhum campo de valor do item —
    // checagem por campo, não por regex no JSON inteiro (um regex genérico
    // colide com timestamps/protocolos que também contêm "50", ex.
    // `data_emissao` gerado com `new Date().toISOString()` — achado real
    // desta sessão, corrigido aqui).
    for (const value of Object.values(item)) {
      if (typeof value === 'number') expect(value).not.toBe(50)
    }
  })

  it('sem alteração de preço no PDV (cadastro = vendido = R$49,90) → fiscal reflete o mesmo valor, sem flag especial', () => {
    const ctx = baseFiscalContext({
      saleTotal: 99.8,
      operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
      items: [{
        saleItemId: 1, productId: 10, variationId: 100,
        description: 'SKU TESTE-001', sku: 'TESTE-001',
        quantity: 2, unitPrice: 49.9, discountAmount: 0,
        unit: 'UN', ncm: '61082200', cest: null, origem: 2,
      }],
      payments: [{ method: 'pix', netAmount: 99.8, cardBrand: null }],
    })

    const snapshot = buildFiscalDocumentSnapshot(ctx)
    expect(snapshot.items[0].total_amount).toBe(99.8)
    expect(buildNfcePayload(ctx).items[0].valor_unitario_comercial).toBe(49.9)
  })

  it('alteração de cadastro DEPOIS da venda nunca alcança o snapshot/payload — contexto é imutável por construção', () => {
    // Simula: venda concluída com unitPrice=44.90 (preço negociado); "amanhã"
    // alguém muda products.price para 59.90. O snapshot fiscal já construído
    // nunca é recalculado a partir de um contexto novo — ele é montado uma
    // vez, no momento da emissão, a partir do que já está congelado em
    // sale_items. Aqui isso é provado construindo o snapshot e então
    // criando um contexto NOVO só com o preço "futuro" — o snapshot antigo
        // continua intacto, prova de que nada o recalcula em segundo plano.
    const ctxNaEpocaDaVenda = baseFiscalContext({
      saleTotal: 89.8,
      operation: { ...baseFiscalContext().operation, presencaComprador: 1, modalidadeFrete: 9 },
      items: [{
        saleItemId: 1, productId: 10, variationId: 100,
        description: 'Calcinha X', sku: 'CALCINHA-X',
        quantity: 2, unitPrice: 44.9, discountAmount: 0,
        unit: 'UN', ncm: '61082200', cest: null, origem: 2,
      }],
      payments: [{ method: 'pix', netAmount: 89.8, cardBrand: null }],
    })
    const snapshotHistorico = buildFiscalDocumentSnapshot(ctxNaEpocaDaVenda)

    const ctxComCadastroFuturo = baseFiscalContext({
      items: [{ ...ctxNaEpocaDaVenda.items[0], unitPrice: 59.9 }],
    })
    buildFiscalDocumentSnapshot(ctxComCadastroFuturo) // simula reimpressão/nova consulta com dado "futuro" hipotético

    // O snapshot histórico já produzido nunca muda — é um objeto imutável,
    // não uma view recalculada.
    expect(snapshotHistorico.items[0].total_amount).toBe(89.8)
    expect(buildNfcePayload(ctxNaEpocaDaVenda).items[0].valor_unitario_comercial).toBe(44.9)
  })
})
