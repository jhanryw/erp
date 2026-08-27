import { describe, it, expect } from 'vitest'
import forge from 'node-forge'
import { parsePkcs12, Pkcs12ParseError } from './parsePkcs12'

const PASSWORD = 'senha-de-teste-123'

/**
 * Gera um certificado autoassinado + PKCS#12 de teste, 100% em memória via
 * node-forge (sem shell-out a `openssl`, sem arquivo no disco) — nunca um
 * certificado real (item 68 do pedido: "use certificados de teste
 * seguros apropriados", "não exponha PFX nos fixtures/logs").
 */
// Achado real desta sessão: caracteres não-ASCII (ex. "—") em atributos do
// subject/issuer aqui na GERAÇÃO do fixture quebram o MAC do PKCS#12 que o
// próprio node-forge produz (bug/limitação de `toPkcs12Asn1`, não de
// `parsePkcs12.ts` — um certificado real emitido por uma AC ICP-Brasil já
// vem corretamente codificado independente de acento na razão social).
// Por isso os fixtures aqui usam só ASCII.
function buildTestPfx(commonName: string, password = PASSWORD): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(1024) // pequeno de propósito — só teste, velocidade
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01a2b3'
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z')
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z')
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'ICP-Brasil Teste (apagar)' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })
  const der = forge.asn1.toDer(p12Asn1).getBytes()
  return Buffer.from(der, 'binary')
}

describe('parsePkcs12 — caminho feliz', () => {
  it('extrai subject/issuer/serial/validade/fingerprint/CNPJ de um PFX válido', () => {
    const pfx = buildTestPfx('EMPRESA TESTE LTDA:11222333000181')
    const meta = parsePkcs12(pfx, PASSWORD)

    expect(meta.subject).toContain('CN=EMPRESA TESTE LTDA:11222333000181')
    expect(meta.issuer).toContain('CN=EMPRESA TESTE LTDA:11222333000181')
    expect(meta.serialNumber).toBeTruthy()
    expect(meta.validFrom).toBe('2026-01-01T00:00:00.000Z')
    expect(meta.validUntil).toBe('2027-01-01T00:00:00.000Z')
    expect(meta.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(meta.cnpj).toBe('11222333000181')
    expect(meta.hasPrivateKey).toBe(true)
  })

  it('CN sem formato ICP-Brasil e-CNPJ → cnpj null, nunca inventa', () => {
    const pfx = buildTestPfx('Fulano de Tal — certificado pessoal')
    const meta = parsePkcs12(pfx, PASSWORD)
    expect(meta.cnpj).toBeNull()
  })
})

describe('parsePkcs12 — falhas tratadas explicitamente, nunca lançam erro genérico', () => {
  it('senha incorreta → Pkcs12ParseError, nunca ecoa a senha na mensagem', () => {
    const pfx = buildTestPfx('EMPRESA TESTE:11222333000181')
    let thrown: unknown
    try {
      parsePkcs12(pfx, 'senha-completamente-errada')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Pkcs12ParseError)
    expect((thrown as Error).message).not.toContain('senha-completamente-errada')
    expect((thrown as Error).message).not.toContain(PASSWORD)
  })

  it('arquivo que não é PKCS#12 (buffer arbitrário) → Pkcs12ParseError', () => {
    const garbage = Buffer.from('isto não é um certificado, é só texto solto', 'utf8')
    expect(() => parsePkcs12(garbage, PASSWORD)).toThrow(Pkcs12ParseError)
  })

  it('buffer vazio → Pkcs12ParseError, nunca lança um erro não tratado do node-forge', () => {
    expect(() => parsePkcs12(Buffer.alloc(0), PASSWORD)).toThrow(Pkcs12ParseError)
  })
})
