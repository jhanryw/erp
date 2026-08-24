import { describe, it, expect, vi, afterEach } from 'vitest'
import QRCode from 'qrcode'
import { logError } from '@/lib/errors/log'
import { generateReceiptQr, formatShortReceiptCode } from './generateReceiptQr'

vi.mock('qrcode', () => ({ default: { toString: vi.fn() } }))
vi.mock('@/lib/errors/log', () => ({ logError: vi.fn() }))

const URL = 'https://erp.example.com/comprovante/a1b2c3d4-e5f6-4789-a012-3456789abcde'

describe('generateReceiptQr', () => {
  afterEach(() => vi.resetAllMocks())

  it('happy path — QR válido retorna o SVG', async () => {
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('<svg>fake-qr</svg>')

    const result = await generateReceiptQr(URL, 42)

    expect(result).toBe('<svg>fake-qr</svg>')
  })

  it('happy path — o SVG gerado contém a URL completa com o receipt_token (é o payload codificado)', async () => {
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (text: string) => `<svg data-payload="${text}"></svg>`)

    const result = await generateReceiptQr(URL, 42)

    expect(result).toContain(URL)
    expect(result).toContain('a1b2c3d4-e5f6-4789-a012-3456789abcde')
  })

  it('QRCode.toString rejeitando — generateReceiptQr NUNCA lança, retorna null', async () => {
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    await expect(generateReceiptQr(URL, 42)).resolves.toBeNull()
  })

  it('QRCode.toString lançando de forma síncrona — também não propaga', async () => {
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('synchronous boom')
    })

    await expect(generateReceiptQr(URL, 42)).resolves.toBeNull()
  })

  it('em falha, loga o evento com sale_id/error.name mas NUNCA o token/URL completa', async () => {
    const err = new Error('some qrcode internal failure')
    err.name = 'QrEncodeError'
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err)

    await generateReceiptQr(URL, 42)

    expect(logError).toHaveBeenCalledTimes(1)
    const call = (logError as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]

    expect(call.context).toMatchObject({
      event: 'receipt_qr_generation_failed',
      sale_id: 42,
      error_name: 'QrEncodeError',
    })

    // Nada no contexto logado pode conter o token ou a URL completa.
    const contextStr = JSON.stringify(call.context)
    expect(contextStr).not.toContain('a1b2c3d4-e5f6-4789-a012-3456789abcde')
    expect(contextStr).not.toContain(URL)
  })

  it('erro que não é instância de Error — error_name vira o typeof, não quebra o log', async () => {
    ;(QRCode.toString as unknown as ReturnType<typeof vi.fn>).mockRejectedValue('string error')

    await generateReceiptQr(URL, 42)

    const call = (logError as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.context.error_name).toBe('string')
  })
})

describe('formatShortReceiptCode', () => {
  it('deriva um código curto de 8 caracteres agrupados (XXXX-XXXX) do token completo', () => {
    expect(formatShortReceiptCode('a1b2c3d4-e5f6-4789-a012-3456789abcde')).toBe('A1B2-C3D4')
  })

  it('é determinístico — o mesmo token sempre produz o mesmo código curto', () => {
    const token = 'f0e0d0c0-1111-4222-8333-444455556666'
    expect(formatShortReceiptCode(token)).toBe(formatShortReceiptCode(token))
  })

  it('nunca inclui o token completo — é estritamente uma representação curta', () => {
    const token = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
    const short = formatShortReceiptCode(token)
    expect(short.length).toBeLessThan(token.length)
    expect(token).not.toBe(short)
  })
})
