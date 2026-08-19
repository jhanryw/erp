/**
 * Fixture compartilhada de teste — Fase Fiscal 2A, seção 10 do pedido.
 *
 * Cenário conceitual: venda Nuvemshop, consumidor final, operação não
 * presencial pela Internet, destinatário pessoa física, entrega
 * interestadual (RN → SP), mercadoria de revenda. Nenhum dado pessoal
 * real — nome/CPF/endereço são valores claramente fictícios.
 *
 * Não é um arquivo `*.test.ts` — é importado pelos testes de
 * `buildNfePayload`/`buildFiscalDocumentSnapshot`/`validateFiscalReadiness`,
 * evitando duplicar o fixture em 3 arquivos.
 */

import type { FiscalDocumentContext } from './types'

export function baseFiscalContext(overrides: Partial<FiscalDocumentContext> = {}): FiscalDocumentContext {
  return {
    saleId: 9001,
    companyId: 1,
    providerRef: 'teste-preview-ref-0001',
    environment: 'homologacao',
    emitente: {
      cnpj: '11222333000181',
      razaoSocial: 'Empresa Teste Fiscal LTDA',
      inscricaoEstadual: '203456789',
      crt: 4, // MEI — cenário atual real da empresa
      logradouro: 'Rua das Testadas',
      numero: '100',
      complemento: null,
      bairro: 'Centro',
      municipio: 'Natal',
      municipioIbge: '2408102',
      uf: 'RN',
      cep: '59000000',
    },
    destinatario: {
      nome: 'Cliente Teste — APAGAR',
      isAnonymous: false,
      cpf: '11144477735', // CPF sintético só de exemplo, formato válido, não real
      cnpj: null,
      inscricaoEstadual: null,
      telefone: '11999990000',
      email: null,
      logradouro: 'Avenida Teste',
      numero: '500',
      complemento: 'Apto 10',
      bairro: 'Bairro Teste',
      municipio: 'São Paulo',
      municipioIbge: '3550308', // resolvido via resolveMunicipioIbge (Fase 2B) — código IBGE real do município de São Paulo/SP
      uf: 'SP',
      cep: '01000000',
    },
    items: [
      {
        saleItemId: 1,
        productId: 10,
        variationId: 100,
        description: 'Calcinha sem costura — TESTE',
        sku: 'TESTE-CAL-M',
        quantity: 2,
        unitPrice: 39.9,
        discountAmount: 0,
        unit: 'UN',
        ncm: '61082200',
        cest: null,
        origem: 2,
      },
    ],
    operation: {
      naturezaOperacao: 'Venda de Mercadoria',
      presencaComprador: 2, // não presencial, pela Internet
      modalidadeFrete: 1, // FOB — por conta do destinatário (cenário Nuvemshop mais comum)
      consumidorFinal: 1, // confirmado no XML real de referência
      indicadorIntermediador: 0, // confirmado no XML real de referência (sem marketplace)
    },
    focusIntegration: { available: true, reason: null },
    ...overrides,
  }
}
