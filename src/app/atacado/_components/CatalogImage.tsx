import Image from 'next/image'
import { isOptimizableImageUrl } from '@/lib/media/optimizable'

interface Props {
  src: string
  alt: string
  /** Largura real de exibição por breakpoint — define qual tamanho o otimizador entrega. Obrigatório. */
  sizes: string
  /** Só para a imagem do LCP (primeira tela). */
  priority?: boolean
  className?: string
}

/**
 * Imagem do catálogo preenchendo o contêiner (que precisa ser `relative`). URLs do Storage público passam
 * pelo otimizador do Next (redimensiona e converte para WebP; cache longo); URLs externas seguem como <img>
 * nativo. Nunca esconde nem troca imagem quebrada — falha de origem continua visível/diagnosticável.
 */
export function CatalogImage({ src, alt, sizes, priority = false, className = '' }: Props) {
  if (isOptimizableImageUrl(src)) {
    return <Image src={src} alt={alt} fill sizes={sizes} priority={priority} className={className} />
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} sizes={sizes} loading={priority ? 'eager' : 'lazy'} decoding="async" className={`absolute inset-0 h-full w-full ${className}`} />
  )
}
