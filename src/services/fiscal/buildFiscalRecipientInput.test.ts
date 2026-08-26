import { describe, it, expect } from 'vitest'
import { buildFiscalRecipientInput } from './buildFiscalRecipientInput'

const DELIVERY = {
  nome: 'Maria Cliente', cpf: '11144477735', cnpj: null, telefone: '11999990000',
  cep: '01000000', logradouro: 'Avenida Teste', numero: '500', complemento: 'Apto 10',
  bairro: 'Bairro Teste', municipio: 'São Paulo', uf: 'SP', municipio_ibge: '3550308', ibge_source: 'viacep',
}

describe('buildFiscalRecipientInput', () => {
  it('sem fiscal_recipient nem delivery_recipient → null (nada pra salvar)', () => {
    expect(buildFiscalRecipientInput(null, null)).toBeNull()
  })

  it('só delivery_recipient (NF-e numa venda de entrega, operador não editou nada) → usa o endereço de entrega integralmente', () => {
    const result = buildFiscalRecipientInput(null, DELIVERY)
    expect(result).toEqual({
      nome: 'Maria Cliente', cpf: '11144477735', cnpj: null, inscricaoEstadual: null, indicadorIe: null,
      telefone: '11999990000', cep: '01000000', logradouro: 'Avenida Teste', numero: '500',
      complemento: 'Apto 10', bairro: 'Bairro Teste', municipio: 'São Paulo', municipioIbge: '3550308',
      uf: 'SP', ibgeSource: 'viacep',
    })
  })

  it('só fiscal_recipient (NFC-e de balcão, só CPF, sem delivery_recipient) → nunca inventa endereço', () => {
    const result = buildFiscalRecipientInput({ cpf: '11144477735' }, null)
    expect(result?.cpf).toBe('11144477735')
    expect(result?.cep).toBeNull()
    expect(result?.logradouro).toBeNull()
  })

  it('CRÍTICO: fiscal_recipient parcial (só CNPJ/IE) sobre uma venda de entrega NUNCA apaga o endereço já gravado pela RPC', () => {
    const result = buildFiscalRecipientInput({ cnpj: '11222333000181', indicador_ie: 1 }, DELIVERY)
    // Endereço de entrega preservado integralmente — não foi substituído por null.
    expect(result?.cep).toBe('01000000')
    expect(result?.logradouro).toBe('Avenida Teste')
    expect(result?.numero).toBe('500')
    expect(result?.municipio).toBe('São Paulo')
    expect(result?.uf).toBe('SP')
    expect(result?.municipioIbge).toBe('3550308')
    // E os dados novos de PJ foram adicionados por cima.
    expect(result?.cnpj).toBe('11222333000181')
    expect(result?.indicadorIe).toBe(1)
    // Nome/CPF originais da entrega preservados (fiscal_recipient não os mencionou).
    expect(result?.nome).toBe('Maria Cliente')
    expect(result?.cpf).toBe('11144477735')
  })

  it('fiscal_recipient pode sobrescrever campos que delivery_recipient também tinha (operador corrigiu o nome pra razão social)', () => {
    const result = buildFiscalRecipientInput({ nome: 'Loja X LTDA', cnpj: '11222333000181' }, DELIVERY)
    expect(result?.nome).toBe('Loja X LTDA')
    expect(result?.cpf).toBe(DELIVERY.cpf) // cpf não mencionado no override, preservado
    expect(result?.cnpj).toBe('11222333000181')
  })
})
