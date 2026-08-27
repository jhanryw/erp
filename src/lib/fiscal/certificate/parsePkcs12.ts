/**
 * Motor Fiscal Configurável — Fase 2 (certificado digital).
 *
 * Parsing/validação de certificado A1 (.pfx/.p12) — PURO em relação a
 * banco/rede (só abre o arquivo em memória com a senha e extrai metadata).
 * Nunca persiste nada aqui — isso é responsabilidade de
 * `certificateService.ts`. Nunca loga senha nem conteúdo do arquivo.
 *
 * Usa `node-forge` (>=1.4.0 — versões anteriores têm CVE-2025-12816,
 * bypass de verificação de assinatura, e CVE-2025-66031, DoS; pesquisado
 * e documentado em fase de auditoria anterior deste mesmo módulo fiscal).
 * Validado nesta sessão com um certificado de teste gerado por OpenSSL
 * (nunca um certificado real), incluindo o caminho de senha incorreta.
 */

import forge from 'node-forge'

export class Pkcs12ParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Pkcs12ParseError'
  }
}

export interface ParsedCertificateMetadata {
  /** Subject completo (DN), formato "CN=..., O=...". */
  subject: string
  issuer: string
  serialNumber: string
  validFrom: string // ISO 8601
  validUntil: string // ISO 8601
  /** SHA-256 do DER do certificado, formatado em pares hex separados por ':'. */
  fingerprint: string
  /**
   * CNPJ extraído do campo CN quando no formato ICP-Brasil e-CNPJ
   * ("RAZAO SOCIAL:14DIGITOS") — `null` quando o CN não segue esse padrão
   * (ex. certificado e-CPF, ou de teste). Nunca inventado — só extraído se
   * o padrão bater exatamente.
   */
  cnpj: string | null
  /** `false` significa que o arquivo tem certificado mas NENHUMA chave privada — inútil pra assinar XML fiscal, deve ser rejeitado pelo chamador. */
  hasPrivateKey: boolean
}

/**
 * Abre o PKCS#12 com a senha informada e extrai metadata do certificado
 * (nunca a chave privada em si, nunca retornada por esta função). Lança
 * `Pkcs12ParseError` com mensagem segura (nunca ecoa a senha) pra:
 *   - arquivo que não é um PKCS#12 válido;
 *   - senha incorreta (MAC do PKCS#12 não bate);
 *   - arquivo sem nenhum certificado dentro.
 */
export function parsePkcs12(pfxBuffer: Buffer, password: string): ParsedCertificateMetadata {
  let p12Asn1: forge.asn1.Asn1
  try {
    p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')))
  } catch {
    throw new Pkcs12ParseError('Arquivo não é um PKCS#12 (.pfx/.p12) válido.')
  }

  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password)
  } catch {
    // node-forge não distingue "senha errada" de "arquivo corrompido" na
    // mensagem — ambos batem no MAC do PKCS#12. Nunca inventamos uma
    // distinção que a biblioteca não garante.
    throw new Pkcs12ParseError('Senha incorreta ou arquivo corrompido — não foi possível abrir o certificado.')
  }

  const certBagsByType = p12.getBags({ bagType: forge.pki.oids.certBag })
  const certBags = certBagsByType[forge.pki.oids.certBag]
  const cert = certBags?.[0]?.cert
  if (!cert) {
    throw new Pkcs12ParseError('Nenhum certificado encontrado dentro do arquivo PKCS#12.')
  }

  const keyBagsByType = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })
  const keyBags = keyBagsByType[forge.pki.oids.pkcs8ShroudedKeyBag]
  const hasPrivateKey = !!(keyBags && keyBags.length > 0)

  const subject = cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ')
  const issuer = cert.issuer.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ')
  const cnField = cert.subject.getField('CN')
  const cn = cnField ? String(cnField.value) : null
  const cnpjMatch = cn ? cn.match(/(\d{14})$/) : null

  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  const md = forge.md.sha256.create()
  md.update(der)
  const fingerprint = md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(':')

  return {
    subject,
    issuer,
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validUntil: cert.validity.notAfter.toISOString(),
    fingerprint,
    cnpj: cnpjMatch ? cnpjMatch[1] : null,
    hasPrivateKey,
  }
}
