import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { decryptSecret, summarizeEmpresa } from './focus-empresa-consulta-container.mjs'
import { encryptSecret } from '../src/lib/security/secretCipher'

describe('focus-empresa-consulta-container (credenciais FICTÍCIAS)', () => {
  it('decifra exatamente o que secretCipher.encryptSecret cifra (mesmo formato)', () => {
    process.env.INTEGRATION_SECRETS_MASTER_KEY_V1 = randomBytes(32).toString('base64')
    process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION = '1'
    const { ciphertext, keyVersion } = encryptSecret('token-ficticio-123')
    expect(decryptSecret(ciphertext, keyVersion)).toBe('token-ficticio-123')
  })
  it('chave errada falha sem vazar o conteúdo', () => {
    process.env.INTEGRATION_SECRETS_MASTER_KEY_V1 = randomBytes(32).toString('base64')
    process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION = '1'
    const { ciphertext } = encryptSecret('segredo-ficticio')
    const other = { INTEGRATION_SECRETS_MASTER_KEY_V1: randomBytes(32).toString('base64') }
    expect(() => decryptSecret(ciphertext, 1, other)).toThrow()
    try { decryptSecret(ciphertext, 1, other) } catch (e) { expect(String(e.message)).not.toContain('segredo-ficticio') }
  })
  it('resumo expõe só razão social, CRT, série e próximo número', () => {
    const s = summarizeEmpresa({ nome: 'Santtorini Lingerie Ltda', regime_tributario: 1, serie_nfe_producao: '1', proximo_numero_nfe_producao: '7', cnpj: '123', token_producao: 'x', email: 'a@b' })
    expect(Object.keys(s).sort()).toEqual(['crt', 'proximo_numero_nfe_producao', 'razao_social', 'razao_social_confere', 'serie_nfe_producao'])
    expect(s.razao_social_confere).toBe(true)
  })
})

import { diffCadastro } from './focus-empresa-consulta-container.mjs'
describe('diffCadastro', () => {
  it('aponta só os campos que diferem (razão social e fantasia), ignorando máscara/caixa', () => {
    const erp = { razao_social: 'SANTTORINI LINGERIE LTDA', nome_fantasia: 'Santtorini Lingerie', inscricao_estadual: '207161780', crt: 1, logradouro: 'AVENIDA X', numero_endereco: '449', complemento: null, bairro: 'ALECRIM', municipio: 'NATAL', uf: 'RN', cep: '59031200', email: null, telefone: null }
    const focus = { nome: '61.523.225 FULANO', nome_fantasia: null, inscricao_estadual: '207161780', regime_tributario: '1', logradouro: 'Avenida X', numero: '449', bairro: 'Alecrim', municipio: 'Natal', uf: 'RN', cep: '59031-200' }
    expect(diffCadastro(erp, focus).map((d) => d.campo)).toEqual(['razao_social', 'nome_fantasia'])
  })
})
