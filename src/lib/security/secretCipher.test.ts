import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encryptSecret, decryptSecret } from './secretCipher'

// 32 bytes (AES-256) em base64, só pra teste — nunca uma chave real.
const KEY_V1 = Buffer.alloc(32, 1).toString('base64')
const KEY_V2 = Buffer.alloc(32, 2).toString('base64')

beforeEach(() => {
  vi.stubEnv('INTEGRATION_SECRETS_CURRENT_KEY_VERSION', '1')
  vi.stubEnv('INTEGRATION_SECRETS_MASTER_KEY_V1', KEY_V1)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('encryptSecret / decryptSecret — roundtrip', () => {
  it('decifra exatamente o que foi cifrado', () => {
    const { ciphertext, keyVersion } = encryptSecret('meu-token-super-secreto')
    expect(decryptSecret(ciphertext, keyVersion)).toBe('meu-token-super-secreto')
  })

  it('duas cifragens do mesmo plaintext produzem ciphertexts diferentes (IV aleatório)', () => {
    const a = encryptSecret('mesmo-valor')
    const b = encryptSecret('mesmo-valor')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(decryptSecret(a.ciphertext, a.keyVersion)).toBe('mesmo-valor')
    expect(decryptSecret(b.ciphertext, b.keyVersion)).toBe('mesmo-valor')
  })

  it('nunca é igual ao plaintext nem contém o plaintext em base64 puro', () => {
    const plaintext = 'chatwoot-api-token-xyz'
    const { ciphertext } = encryptSecret(plaintext)
    expect(ciphertext).not.toBe(plaintext)
    expect(Buffer.from(plaintext).toString('base64')).not.toBe(ciphertext)
  })

  it('grava a keyVersion corrente no resultado', () => {
    const { keyVersion } = encryptSecret('x')
    expect(keyVersion).toBe(1)
  })
})

describe('decryptSecret — autenticação (AEAD) rejeita adulteração', () => {
  it('ciphertext adulterado (1 byte alterado) lança erro em vez de decifrar lixo silenciosamente', () => {
    const { ciphertext, keyVersion } = encryptSecret('valor-original')
    const buf = Buffer.from(ciphertext, 'base64')
    buf[buf.length - 1] ^= 0xff // inverte o último byte (dentro dos dados cifrados)
    const tampered = buf.toString('base64')

    expect(() => decryptSecret(tampered, keyVersion)).toThrow()
  })

  it('ciphertext malformado (menor que iv+authTag) lança erro claro', () => {
    expect(() => decryptSecret(Buffer.from('abc').toString('base64'), 1)).toThrow(/malformado/)
  })
})

describe('rotação de chave', () => {
  it('segredo cifrado com a versão antiga continua decifrável depois de trocar a versão corrente', () => {
    const { ciphertext, keyVersion: oldVersion } = encryptSecret('segredo-antes-da-rotacao')

    // Simula rotação: versão 2 vira a corrente, versão 1 continua disponível.
    vi.stubEnv('INTEGRATION_SECRETS_CURRENT_KEY_VERSION', '2')
    vi.stubEnv('INTEGRATION_SECRETS_MASTER_KEY_V2', KEY_V2)

    expect(decryptSecret(ciphertext, oldVersion)).toBe('segredo-antes-da-rotacao')

    const { keyVersion: newVersion } = encryptSecret('segredo-depois-da-rotacao')
    expect(newVersion).toBe(2)
  })

  it('decifrar com a keyVersion errada (chave diferente) lança erro em vez de devolver lixo', () => {
    const { ciphertext } = encryptSecret('valor')
    vi.stubEnv('INTEGRATION_SECRETS_MASTER_KEY_V2', KEY_V2)
    expect(() => decryptSecret(ciphertext, 2)).toThrow()
  })
})

describe('configuração ausente/inválida', () => {
  it('encryptSecret sem INTEGRATION_SECRETS_CURRENT_KEY_VERSION lança erro', () => {
    vi.stubEnv('INTEGRATION_SECRETS_CURRENT_KEY_VERSION', '')
    expect(() => encryptSecret('x')).toThrow(/CURRENT_KEY_VERSION/)
  })

  it('encryptSecret sem a master key da versão corrente lança erro', () => {
    vi.stubEnv('INTEGRATION_SECRETS_MASTER_KEY_V1', '')
    expect(() => encryptSecret('x')).toThrow(/MASTER_KEY_V1/)
  })

  it('master key com tamanho errado (não 32 bytes) lança erro', () => {
    vi.stubEnv('INTEGRATION_SECRETS_MASTER_KEY_V1', Buffer.alloc(16).toString('base64'))
    expect(() => encryptSecret('x')).toThrow(/32 bytes/)
  })

  it('encryptSecret com plaintext vazio lança erro', () => {
    expect(() => encryptSecret('')).toThrow(/vazio/)
  })
})
