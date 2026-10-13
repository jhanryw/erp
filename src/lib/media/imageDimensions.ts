import { isOptimizableImageUrl } from './optimizable'

export interface ImageSize { width: number; height: number }

/**
 * Dimensões reais de uma imagem do Storage público, para o layout reservar a proporção CERTA antes do
 * carregamento (sem CLS e sem barras). Arquivos do Media Hub têm nome UUID imutável, então o resultado é
 * memoizado por URL para sempre; falha (rede/formato) é lembrada só por 60 s.
 *
 * Só URLs da allowlist do otimizador são consultadas (nunca um host arbitrário → sem SSRF).
 * Lê os primeiros 256 KB (cabeçalho basta); se o `sharp` não conseguir, baixa o arquivo inteiro uma vez.
 */
const known = new Map<string, ImageSize>()
const failedUntil = new Map<string, number>()
const inflight = new Map<string, Promise<ImageSize | null>>()

const FAIL_TTL_MS = 60_000
const TIMEOUT_MS = 4_000
const HEAD_BYTES = 256 * 1024

async function readSize(buffer: Buffer): Promise<ImageSize | null> {
  const { default: sharp } = await import('sharp')
  const meta = await sharp(buffer).metadata()
  if (!meta.width || !meta.height) return null
  // EXIF 5–8 = imagem girada 90°: a proporção exibida troca largura/altura.
  const rotated = (meta.orientation ?? 1) >= 5
  return rotated ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height }
}

async function fetchBuffer(url: string, range: boolean): Promise<Buffer | null> {
  const response = await fetch(url, {
    headers: range ? { Range: `bytes=0-${HEAD_BYTES - 1}` } : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  })
  if (!response.ok) return null
  return Buffer.from(await response.arrayBuffer())
}

async function load(url: string): Promise<ImageSize | null> {
  try {
    const head = await fetchBuffer(url, true)
    if (head) {
      try {
        const size = await readSize(head)
        if (size) return size
      } catch { /* cabeçalho incompleto: tenta o arquivo inteiro */ }
    }
    const full = await fetchBuffer(url, false)
    return full ? await readSize(full) : null
  } catch {
    return null
  }
}

export async function getImageSize(url: string | null | undefined): Promise<ImageSize | null> {
  if (!url || !isOptimizableImageUrl(url)) return null

  const hit = known.get(url)
  if (hit) return hit
  if ((failedUntil.get(url) ?? 0) > Date.now()) return null

  const pending = inflight.get(url)
  if (pending) return pending

  const promise = load(url)
    .then((size) => {
      if (size) known.set(url, size)
      else failedUntil.set(url, Date.now() + FAIL_TTL_MS)
      return size
    })
    .finally(() => { inflight.delete(url) })

  inflight.set(url, promise)
  return promise
}

/** Só para testes. */
export function resetImageSizeCache(): void {
  known.clear(); failedUntil.clear(); inflight.clear()
}
