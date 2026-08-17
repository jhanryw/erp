/**
 * Criptografia autenticada (AES-256-GCM) para segredos de integração
 * (`integration_secrets.ciphertext`). FASE 2 (Integration Foundation).
 *
 * Threat model (ver relatório da Fase 2, seção B, para a versão completa):
 *   - Master key NUNCA fica no banco — só em variável de ambiente do
 *     processo Next.js, mesmo nível de confiança que `SUPABASE_SERVICE_ROLE_KEY`
 *     já tem hoje neste projeto. Um dump do banco (mesmo completo) nunca
 *     expõe segredo em texto puro, só ciphertext.
 *   - Nunca Base64 sozinho (não é criptografia, só ofuscação reversível por
 *     qualquer um). Nunca hash (segredo precisa ser recuperável — hash é
 *     unidirecional, serve pra senha, não pra token de API).
 *   - AES-256-GCM é cifra autenticada (AEAD) — detecta adulteração do
 *     ciphertext (`decryptSecret` lança erro se o auth tag não bater),
 *     diferente de um modo não autenticado (CBC puro) que decifraria dado
 *     corrompido silenciosamente em lixo.
 *   - `keyVersion` versiona a master key usada — permite rotação: gera nova
 *     chave, `INTEGRATION_SECRETS_CURRENT_KEY_VERSION` aponta pra ela,
 *     segredos NOVOS usam a chave nova; segredos ANTIGOS continuam
 *     decifráveis enquanto a env var da versão antiga existir. Não força
 *     re-cifrar tudo no mesmo instante da rotação.
 *   - Só código server-side importa este módulo (services em
 *     `src/services/integrations/**`, que já rodam exclusivamente via
 *     `createAdminClient()`) — nunca um client component, nunca exposto ao
 *     browser, nunca incluso em resposta JSON de API (reforçado por
 *     `getCompanyIntegration()` nunca retornar secret junto — ver
 *     `company-integrations.service.ts`).
 *   - Nunca logar o valor decifrado. Chamadores devem mascarar
 *     (`token.slice(0,4)+'…'`) se precisarem logar algo pra debug.
 *
 * Variáveis de ambiente esperadas (nenhuma tem valor de exemplo aqui —
 * nunca commitadas):
 *   INTEGRATION_SECRETS_CURRENT_KEY_VERSION=1
 *   INTEGRATION_SECRETS_MASTER_KEY_V1=<32 bytes em base64>
 *   (rotação futura: INTEGRATION_SECRETS_MASTER_KEY_V2=..., atualizar CURRENT_KEY_VERSION=2)
 *
 * Gerar uma chave nova: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12 // recomendado pro GCM (96 bits)
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32 // AES-256

export interface EncryptedSecret {
  ciphertext: string // base64(iv || authTag || dados)
  keyVersion: number
}

function getMasterKey(version: number): Buffer {
  const envVar = `INTEGRATION_SECRETS_MASTER_KEY_V${version}`
  const raw = process.env[envVar]
  if (!raw) {
    throw new Error(`${envVar} não configurada — necessária para cifrar/decifrar segredo na versão ${version}.`)
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${envVar} deve decodificar para ${KEY_LENGTH} bytes (AES-256) em base64 — tamanho atual: ${key.length} byte(s).`)
  }
  return key
}

function getCurrentKeyVersion(): number {
  const raw = process.env.INTEGRATION_SECRETS_CURRENT_KEY_VERSION
  const parsed = raw ? parseInt(raw, 10) : NaN
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('INTEGRATION_SECRETS_CURRENT_KEY_VERSION não configurada ou inválida (esperado inteiro >= 1).')
  }
  return parsed
}

/** Cifra `plaintext` com a master key CORRENTE (versão indicada por INTEGRATION_SECRETS_CURRENT_KEY_VERSION). */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (!plaintext) throw new Error('encryptSecret: plaintext vazio.')

  const keyVersion = getCurrentKeyVersion()
  const key = getMasterKey(keyVersion)
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const packed = Buffer.concat([iv, authTag, encrypted])
  return { ciphertext: packed.toString('base64'), keyVersion }
}

/**
 * Decifra `ciphertext` usando a master key da versão `keyVersion` (não
 * necessariamente a corrente — permite decifrar segredos cifrados antes de
 * uma rotação). Lança erro se a chave errada for usada ou se o ciphertext
 * foi adulterado (auth tag do GCM não bate).
 */
export function decryptSecret(ciphertext: string, keyVersion: number): string {
  const key = getMasterKey(keyVersion)
  const packed = Buffer.from(ciphertext, 'base64')

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('decryptSecret: ciphertext malformado (menor que iv+authTag).')
  }

  const iv = packed.subarray(0, IV_LENGTH)
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const data = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return decrypted.toString('utf8')
}
