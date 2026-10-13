import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import sharp from 'sharp'
import { getImageSize, resetImageSizeCache } from './imageDimensions'

const HOST = 'https://qarvon-supabase.uxxkgy.easypanel.host'
const URL_OK = `${HOST}/storage/v1/object/public/media-public/1/banner.png`

async function png(width: number, height: number, orientation?: number) {
  let img = sharp({ create: { width, height, channels: 3, background: '#a71818' } }).png()
  if (orientation) img = img.withMetadata({ orientation })
  return img.toBuffer()
}

const respond = (buffer: Buffer, ok = true) => ({ ok, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) })

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = HOST
  resetImageSizeCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('getImageSize', () => {
  it('lê as dimensões reais e memoiza por URL (um único download)', async () => {
    const fetchMock = vi.fn(async () => respond(await png(1580, 700)))
    vi.stubGlobal('fetch', fetchMock)
    expect(await getImageSize(URL_OK)).toEqual({ width: 1580, height: 700 })
    expect(await getImageSize(URL_OK)).toEqual({ width: 1580, height: 700 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('chamadas simultâneas compartilham a mesma busca', async () => {
    const fetchMock = vi.fn(async () => respond(await png(800, 1000)))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([getImageSize(URL_OK), getImageSize(URL_OK)])
    expect(a).toEqual(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('EXIF girado (5–8) troca largura e altura, como o navegador exibe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(await png(1000, 500, 6))))
    expect(await getImageSize(URL_OK)).toEqual({ width: 500, height: 1000 })
  })

  it('só consulta hosts da allowlist (sem SSRF) e nunca chama fetch para eles', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await getImageSize('https://evil.example.com/a.png')).toBeNull()
    expect(await getImageSize('http://169.254.169.254/latest/meta-data')).toBeNull()
    expect(await getImageSize(`${HOST}/storage/v1/object/public/media-private/1/a.png`)).toBeNull()
    expect(await getImageSize(null)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falha de rede/HTTP/arquivo inválido → null, sem lançar (a proporção de reserva assume)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(Buffer.from('não é imagem'))))
    expect(await getImageSize(URL_OK)).toBeNull()
    resetImageSizeCache()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect(await getImageSize(URL_OK)).toBeNull()
    resetImageSizeCache()
    vi.stubGlobal('fetch', vi.fn(async () => respond(Buffer.alloc(0), false)))
    expect(await getImageSize(URL_OK)).toBeNull()
  })
})
