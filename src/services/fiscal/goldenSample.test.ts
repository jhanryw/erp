/**
 * Golden sample fiscal — Fase Fiscal 2B, seção 2 do pedido.
 *
 * 2 XMLs de NF-e modelo 55 REAIS, autorizados pela SEFAZ (protocolo real,
 * cStat=100), emitidos pela própria empresa em CRT=4 (MEI), servem de
 * referência empírica. Estes testes comparam SEMANTICAMENTE (valores
 * fiscais — CST/CSOSN/CFOP/origem/alíquotas) o payload que `buildNfePayload`
 * produz contra o comportamento observado nesses XMLs — nunca a assinatura
 * digital, a chave de acesso ou o número da nota, que são específicos de
 * cada documento e não fazem sentido reproduzir aqui.
 *
 * Fixtures abaixo espelham os 2 XMLs reais (chaves
 * 24260861523225000117550010000000041006759001 e
 * ...031006758873) com nomes de cliente/endereço já ofuscados — os dados
 * fiscais (NCM/CFOP/CSOSN/origem/valores) são os reais dos XMLs.
 */

import { describe, it, expect } from 'vitest'
import { buildNfePayload } from './buildNfePayload'
import type { FiscalDocumentContext } from './types'

const EMITENTE_REAL: FiscalDocumentContext['emitente'] = {
  cnpj: '61523225000117',
  razaoSocial: '61.523.225 YASMIM PEREIRA ARAUJO LUCAS FREIRE',
  inscricaoEstadual: '207161780',
  crt: 4,
  logradouro: 'AVENIDA PRESIDENTE BANDEIRA',
  numero: '449',
  complemento: null,
  bairro: 'ALECRIM',
  municipio: 'NATAL',
  municipioIbge: '2408102',
  uf: 'RN',
  cep: '59031200',
}

function baseOperation(): FiscalDocumentContext['operation'] {
  return {
    naturezaOperacao: 'Venda de Mercadoria',
    presencaComprador: 2, // indPres=2 no XML real
    modalidadeFrete: 0, // modFrete=0 no XML real
    consumidorFinal: 1, // indFinal=1 no XML real
    indicadorIntermediador: 0, // indIntermed=0 no XML real
  }
}

// ─── Golden sample 1 — chave ...041006759001 (RN → PR, 2 itens, origem 0) ──

function goldenSample1(): FiscalDocumentContext {
  return {
    saleId: 90041,
    companyId: 1,
    providerRef: 'golden-sample-1',
    environment: 'homologacao',
    saleStatus: 'paid',
    saleTotal: 170.98, // vNF real do XML
    saleDiscountAmount: 0,
    saleSurchargeAmount: 0,
    saleShippingCharged: 0,
    emitente: EMITENTE_REAL,
    destinatario: {
      nome: 'Cliente Golden Sample 1 — ofuscado',
      isAnonymous: false,
      cpf: '58088830915',
      cnpj: null,
      inscricaoEstadual: null,
      indicadorIe: null,
      telefone: '46999308169',
      email: 'golden1@example.com',
      logradouro: 'Avenida Macali',
      numero: '2100',
      complemento: 'Cx postal 23',
      bairro: 'Passarela',
      municipio: 'Marmeleiro',
      municipioIbge: '4115408',
      uf: 'PR',
      cep: '85615630',
    },
    items: [
      { saleItemId: 1, productId: 1, variationId: 1, description: 'Camisola Secret Rosa com Branco Rosa GG', sku: '0503050426', quantity: 1, unitPrice: 104.99, discountAmount: 5.24, unit: 'UNDS', ncm: '61083200', cest: null, origem: 0 },
      { saleItemId: 2, productId: 2, variationId: 2, description: 'Camisola Secret Verde Militar Verde Militar GG', sku: '0503440426', quantity: 1, unitPrice: 74.99, discountAmount: 3.76, unit: 'UNDS', ncm: '61083200', cest: null, origem: 0 },
    ],
    // <pag><detPag><tPag>20</tPag><vPag>170.98</vPag></detPag></pag> no XML real — PIX estático, valor = vNF.
    payments: [{ method: 'pix', netAmount: 170.98, cardBrand: null }],
    operation: baseOperation(),
    focusIntegration: { available: true, reason: null },
  }
}

// ─── Golden sample 2 — chave ...031006758873 (RN → RJ, 3 itens, origem 0 e 2 misturados) ──

function goldenSample2(): FiscalDocumentContext {
  return {
    saleId: 90031,
    companyId: 1,
    providerRef: 'golden-sample-2',
    environment: 'homologacao',
    saleStatus: 'paid',
    saleTotal: 156.72, // vNF real do XML
    saleDiscountAmount: 0,
    saleSurchargeAmount: 0,
    saleShippingCharged: 0,
    emitente: EMITENTE_REAL,
    destinatario: {
      nome: 'Cliente Golden Sample 2 — ofuscado',
      isAnonymous: false,
      cpf: '30916526968',
      cnpj: null,
      inscricaoEstadual: null,
      indicadorIe: null,
      telefone: '21998574887',
      email: 'golden2@example.com',
      logradouro: 'Rua Barão de Itambi',
      numero: '54',
      complemento: 'Cob 01',
      bairro: 'Botafogo',
      municipio: 'Rio de Janeiro',
      municipioIbge: '3304557',
      uf: 'RJ',
      cep: '22231000',
    },
    items: [
      { saleItemId: 1, productId: 1, variationId: 1, description: 'Camisola Secret Verde Militar Verde Militar G', sku: '0503440326', quantity: 1, unitPrice: 74.99, discountAmount: 3.75, unit: 'UNDS', ncm: '61083200', cest: null, origem: 0 },
      { saleItemId: 2, productId: 2, variationId: 2, description: 'Camisola Secret Branco com Preto Branco G', sku: '0503020326', quantity: 1, unitPrice: 74.99, discountAmount: 3.75, unit: 'UNDS', ncm: '61083200', cest: null, origem: 0 },
      { saleItemId: 3, productId: 3, variationId: 3, description: 'Calcinha Invisible High Marrom Marrom GGG', sku: '0204120826', quantity: 1, unitPrice: 14.99, discountAmount: 0.75, unit: 'UNDS', ncm: '61082200', cest: null, origem: 2 },
    ],
    // <pag><detPag><tPag>20</tPag><vPag>156.72</vPag></detPag></pag> no XML real.
    payments: [{ method: 'pix', netAmount: 156.72, cardBrand: null }],
    operation: baseOperation(),
    focusIntegration: { available: true, reason: null },
  }
}

describe('Golden sample 1 — chave ...041006759001 (RN → PR, interestadual, 2 itens origem 0)', () => {
  const payload = buildNfePayload(goldenSample1())

  it('cabeçalho: natureza, local_destino, indFinal, indPres, indIntermed', () => {
    expect(payload.natureza_operacao).toBe('Venda de Mercadoria')
    expect(payload.local_destino).toBe(2) // idDest=2 no XML (RN→PR)
    expect(payload.consumidor_final).toBe(1)
    expect(payload.presenca_comprador).toBe(2)
    expect(payload.indicador_intermediario).toBe(0)
  })

  it('emitente: CNPJ, CRT=4, regime_tributario_emitente espelha CRT', () => {
    expect(payload.cnpj_emitente).toBe('61523225000117')
    expect(payload.regime_tributario_emitente).toBe(4)
  })

  it('formas_pagamento: forma_pagamento="20" (PIX estático) reproduzindo o XML real, valor = vNF, sem bandeira (não é cartão)', () => {
    expect(payload.formas_pagamento).toEqual([
      { forma_pagamento: '20', valor_pagamento: 170.98, indicador_pagamento: '0' },
    ])
  })

  it('destinatário: CPF, indicador_ie=9 (PF não contribuinte), código IBGE presente', () => {
    expect(payload.cpf_destinatario).toBe('58088830915')
    expect(payload.indicador_inscricao_estadual_destinatario).toBe(9)
    expect(payload.codigo_municipio_destinatario).toBe('4115408')
    expect(payload.uf_destinatario).toBe('PR')
  })

  it('todo item: CFOP 6102, CSOSN 102, origem 0, GTIN "SEM GTIN"', () => {
    for (const item of payload.items) {
      expect(item.cfop).toBe('6102')
      expect(item.icms_situacao_tributaria).toBe('102')
      expect(item.icms_origem).toBe(0)
      expect(item.codigo_barras_comercial).toBe('SEM GTIN')
    }
  })

  it('todo item: PIS/COFINS CST 49 com base/alíquota/valor = 0', () => {
    for (const item of payload.items) {
      expect(item.pis_situacao_tributaria).toBe('49')
      expect(item.pis_base_calculo).toBe(0)
      expect(item.pis_aliquota_porcentual).toBe(0)
      expect(item.pis_valor).toBe(0)
      expect(item.cofins_situacao_tributaria).toBe('49')
      expect(item.cofins_base_calculo).toBe(0)
      expect(item.cofins_aliquota_porcentual).toBe(0)
      expect(item.cofins_valor).toBe(0)
    }
  })

  it('todo item: IPI CST 53, cEnq 999', () => {
    for (const item of payload.items) {
      expect(item.ipi_situacao_tributaria).toBe('53')
      expect(item.ipi_codigo_enquadramento_legal).toBe('999')
    }
  })

  it('todo item: IBS/CBS ano-teste 2026 (CST 000, cClassTrib 000001, alíquotas 0.10/0/0.90)', () => {
    for (const item of payload.items) {
      expect(item.ibs_cbs_situacao_tributaria).toBe('000')
      expect(item.ibs_cbs_classificacao_tributaria).toBe('000001')
      expect(item.ibs_uf_aliquota).toBe(0.1)
      expect(item.ibs_mun_aliquota).toBe(0)
      expect(item.cbs_aliquota).toBe(0.9)
    }
  })

  it('valor_bruto e valor_desconto batem com o XML real (item 1: R$104,99 bruto, R$5,24 desconto)', () => {
    expect(payload.items[0].valor_bruto).toBe(104.99)
    expect(payload.items[0].valor_desconto).toBe(5.24)
    expect(payload.items[1].valor_bruto).toBe(74.99)
    expect(payload.items[1].valor_desconto).toBe(3.76)
  })

  it('NCM 61083200 (camisola, malha) em todos os itens, como no XML', () => {
    for (const item of payload.items) expect(item.codigo_ncm).toBe('61083200')
  })
})

describe('Golden sample 2 — chave ...031006758873 (RN → RJ, interestadual, 3 itens, origem 0 e 2 misturados)', () => {
  const payload = buildNfePayload(goldenSample2())

  it('cabeçalho: local_destino=2 (RN→RJ), demais indicadores iguais ao XML', () => {
    expect(payload.local_destino).toBe(2)
    expect(payload.consumidor_final).toBe(1)
    expect(payload.presenca_comprador).toBe(2)
  })

  it('destinatário: código IBGE do Rio de Janeiro (3304557), diferente do golden sample 1 — nunca hardcoded', () => {
    expect(payload.codigo_municipio_destinatario).toBe('3304557')
    expect(payload.uf_destinatario).toBe('RJ')
  })

  it('formas_pagamento: forma_pagamento="20" (PIX estático), valor = vNF real desta nota', () => {
    expect(payload.formas_pagamento).toEqual([
      { forma_pagamento: '20', valor_pagamento: 156.72, indicador_pagamento: '0' },
    ])
  })

  it('origem mista: 2 itens origem 0 (nacional), 1 item origem 2 (estrangeira, mercado interno) — reproduzido item a item, não uma origem fixa pra venda inteira', () => {
    expect(payload.items[0].icms_origem).toBe(0)
    expect(payload.items[1].icms_origem).toBe(0)
    expect(payload.items[2].icms_origem).toBe(2)
  })

  it('NCM difere por tipo de produto: 61083200 (camisola) vs 61082200 (calcinha) — cada item usa o NCM do seu próprio produto', () => {
    expect(payload.items[0].codigo_ncm).toBe('61083200')
    expect(payload.items[1].codigo_ncm).toBe('61083200')
    expect(payload.items[2].codigo_ncm).toBe('61082200')
  })

  it('CFOP 6102 e CSOSN 102 em todos os 3 itens, independente da origem da mercadoria', () => {
    for (const item of payload.items) {
      expect(item.cfop).toBe('6102')
      expect(item.icms_situacao_tributaria).toBe('102')
    }
  })

  it('todo item: PIS/COFINS/IPI/IBS-CBS idênticos ao golden sample 1 (regra não varia por produto)', () => {
    for (const item of payload.items) {
      expect(item.pis_situacao_tributaria).toBe('49')
      expect(item.cofins_situacao_tributaria).toBe('49')
      expect(item.ipi_situacao_tributaria).toBe('53')
      expect(item.ibs_cbs_classificacao_tributaria).toBe('000001')
    }
  })

  it('valores batem com o XML real do item 3 (calcinha, R$14,99 bruto, R$0,75 desconto)', () => {
    expect(payload.items[2].valor_bruto).toBe(14.99)
    expect(payload.items[2].valor_desconto).toBe(0.75)
  })
})

describe('Golden sample — não reproduz assinatura/chave/número (fora de escopo, por instrução explícita)', () => {
  it('payload não tem nenhum campo de chave de acesso, protocolo ou assinatura — isso é responsabilidade da SEFAZ/Focus na resposta, nunca do payload de envio', () => {
    const payload = buildNfePayload(goldenSample1()) as unknown as Record<string, unknown>
    expect(payload).not.toHaveProperty('chave_nfe')
    expect(payload).not.toHaveProperty('protocolo')
    expect(payload).not.toHaveProperty('assinatura')
    expect(payload).not.toHaveProperty('numero')
    expect(payload).not.toHaveProperty('serie')
  })
})
