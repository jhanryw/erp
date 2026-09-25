import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  addNuvemshopProductImage,
  createNuvemshopProductFull,
  getNuvemshopProduct,
  NuvemshopApiError,
  NuvemshopTransportError,
  nuvemshopHttpConfig,
  rateLimitWaitMs,
} from './nuvemshop'

const creds = { storeId: '111', accessToken: 'segredo-nao-pode-vazar' }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

let fetchMock: ReturnType<typeof vi.fn>
let sleeps: number[]
const original = { ...nuvemshopHttpConfig }

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  sleeps = []
  nuvemshopHttpConfig.sleep = async (ms: number) => { sleeps.push(ms) }
})
afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(nuvemshopHttpConfig, original)
})

describe('client Nuvemshop — transporte', () => {
  it('429 → espera x-rate-limit-reset e repete; sucesso na 2ª tentativa', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, { error: 'rate' }, { 'x-rate-limit-reset': '1500' }))
      .mockResolvedValueOnce(json(200, { id: 5, name: { pt: 'X' }, variants: [] }))
    const p = await getNuvemshopProduct('5', creds)
    expect(p?.id).toBe(5)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([1500])
  })

  it('429 persistente → no máximo 3 tentativas e erro 429 (sem loop infinito)', async () => {
    fetchMock.mockImplementation(async () => json(429, { error: 'rate' }, { 'x-rate-limit-reset': '99999' }))
    await expect(getNuvemshopProduct('5', creds)).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([nuvemshopHttpConfig.maxWaitMs, nuvemshopHttpConfig.maxWaitMs])
  })

  it('espera tem piso e teto; sem cabeçalho usa 1s', () => {
    expect(rateLimitWaitMs(new Headers({ 'x-rate-limit-reset': '10' }))).toBe(nuvemshopHttpConfig.minWaitMs)
    expect(rateLimitWaitMs(new Headers({ 'x-rate-limit-reset': '999999' }))).toBe(nuvemshopHttpConfig.maxWaitMs)
    expect(rateLimitWaitMs(new Headers())).toBe(1000)
  })

  it('timeout → NuvemshopTransportError e POST /products NÃO é repetido', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    const err = await createNuvemshopProductFull({ name: 'P', attributeNames: [], variants: [{ internalVariationId: 1, price: 10, stock: 1, sku: 'A', attributeValues: [] }] }, creds)
      .catch((e) => e)
    expect(err).toBeInstanceOf(NuvemshopTransportError)
    expect(err.kind).toBe('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('toda chamada leva AbortSignal (nunca fica pendurada)', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 5, name: {}, variants: [] }))
    await getNuvemshopProduct('5', creds)
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('token inválido (401) → erro sem retry e sem o token na mensagem', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'Invalid access token' }))
    const err = await getNuvemshopProduct('5', creds).catch((e) => e)
    expect(err).toBeInstanceOf(NuvemshopApiError)
    expect(err.status).toBe(401)
    expect(String(err.message)).not.toContain(creds.accessToken)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('client Nuvemshop — imagens', () => {
  it('POST /products envia images com src e position', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 9, name: {}, variants: [], images: [] }))
    await createNuvemshopProductFull({
      name: 'P', attributeNames: [], variants: [{ internalVariationId: 1, price: 10, stock: 1, sku: 'A', attributeValues: [] }],
      images: [{ src: 'https://s/a.jpg', position: 1 }, { src: 'https://s/b.jpg', position: 2 }],
    }, creds)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.images).toEqual([{ src: 'https://s/a.jpg', position: 1 }, { src: 'https://s/b.jpg', position: 2 }])
  })

  it('addNuvemshopProductImage → POST /products/{id}/images com src/position', async () => {
    fetchMock.mockResolvedValue(json(201, { id: 77, src: 'https://cdn/x.jpg', position: 10 }))
    const img = await addNuvemshopProductImage('9', { src: 'https://s/j.jpg', position: 10 }, creds)
    expect(img.id).toBe(77)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.tiendanube.com/v1/111/products/9/images')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ src: 'https://s/j.jpg', position: 10 })
  })

  it('imagem recusada (422) → NuvemshopApiError', async () => {
    fetchMock.mockResolvedValue(json(422, { src: ['inacessível'] }))
    await expect(addNuvemshopProductImage('9', { src: 'https://s/j.jpg', position: 10 }, creds)).rejects.toMatchObject({ status: 422 })
  })
})
