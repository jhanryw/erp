import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { verifyChatwootWebhookSignature, CHATWOOT_REPLAY_WINDOW_SECONDS } from './signature'

const SECRET = 'test-webhook-secret'

function sign(rawBody: string, timestamp: number, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`
}

describe('verifyChatwootWebhookSignature — casos obrigatórios (seção 40 do pedido)', () => {
  const rawBody = JSON.stringify({ event: 'contact_created', id: 1, account: { id: 1 } })
  const now = 1_700_000_000

  it('assinatura válida', () => {
    const timestamp = now
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: sign(rawBody, timestamp),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: true })
  })

  it('assinatura errada (mesmo secret, hash diferente)', () => {
    const timestamp = now
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: 'sha256=' + '0'.repeat(64),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('body adulterado depois de assinado', () => {
    const timestamp = now
    const validSignature = sign(rawBody, timestamp)
    const tamperedBody = JSON.stringify({ event: 'contact_created', id: 999, account: { id: 1 } })
    const result = verifyChatwootWebhookSignature({
      rawBody: tamperedBody,
      timestampHeader: String(timestamp),
      signatureHeader: validSignature,
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('timestamp ausente', () => {
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: null,
      signatureHeader: sign(rawBody, now),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('signature ausente', () => {
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(now),
      signatureHeader: null,
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('timestamp expirado (além da janela no passado)', () => {
    const timestamp = now - CHATWOOT_REPLAY_WINDOW_SECONDS - 1
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: sign(rawBody, timestamp),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window' })
  })

  it('timestamp futuro além da janela (relógio adiantado/replay planejado)', () => {
    const timestamp = now + CHATWOOT_REPLAY_WINDOW_SECONDS + 1
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: sign(rawBody, timestamp),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window' })
  })

  it('timestamp exatamente na borda da janela ainda é aceito', () => {
    const timestamp = now - CHATWOOT_REPLAY_WINDOW_SECONDS
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: sign(rawBody, timestamp),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: true })
  })

  it('secret errado', () => {
    const timestamp = now
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: sign(rawBody, timestamp, 'secret-errado'),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('timestamp não-numérico é rejeitado antes de tentar comparar assinatura', () => {
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: 'não-é-um-número',
      signatureHeader: sign(rawBody, now),
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_timestamp' })
  })

  it('assinatura de tamanho diferente do esperado é rejeitada sem lançar exceção (timingSafeEqual exige mesmo tamanho)', () => {
    const timestamp = now
    const result = verifyChatwootWebhookSignature({
      rawBody,
      timestampHeader: String(timestamp),
      signatureHeader: 'sha256=curto',
      secret: SECRET,
      nowSeconds: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})
