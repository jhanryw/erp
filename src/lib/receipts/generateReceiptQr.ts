// Comprovante não fiscal — geração do QR de verificação, blindada.
//
// QRCode.toString() é a ÚNICA chamada no caminho de /vendas/[id]/comprovante
// capaz de lançar exceção não tratada (todo o resto do caminho — getReceiptData,
// sale_items/sale_payments/exchange_items — já retorna null/array vazio em
// vez de lançar). Sem proteção, qualquer falha aqui derruba o Server
// Component inteiro ("Application error: a server-side exception has
// occurred"). Este módulo isola essa chamada: nunca propaga exceção, nunca
// inventa um QR/URL alternativo — só retorna null e loga o suficiente pra
// investigar, sem PII nem o token completo no log.

import QRCode from 'qrcode'
import { logError } from '@/lib/errors/log'

const ROUTE = 'generateReceiptQr'

/**
 * Gera o SVG do QR de verificação. NUNCA lança — qualquer erro (runtime,
 * biblioteca, o que for) é capturado e vira null, deixando a página
 * renderizar normalmente sem QR (com o código textual como fallback visual).
 */
export async function generateReceiptQr(url: string, saleId: number): Promise<string | null> {
  try {
    return await QRCode.toString(url, { type: 'svg', margin: 0, width: 130 })
  } catch (err) {
    // Nunca logar receipt_token/URL completa (a URL contém o token) nem
    // dados de cliente — só o necessário pra investigar sem expor a chave
    // de verificação da venda em texto plano no log.
    logError({
      route: ROUTE,
      err,
      context: {
        event: 'receipt_qr_generation_failed',
        sale_id: saleId,
        error_name: err instanceof Error ? err.name : typeof err,
      },
    })
    return null
  }
}

/**
 * Representação curta do token, só para exibição amigável quando o QR não
 * pôde ser gerado (nunca usada como chave de busca — a busca real continua
 * sendo o token completo em sales.receipt_token). Determinística: sempre a
 * mesma venda produz o mesmo código curto.
 */
export function formatShortReceiptCode(token: string): string {
  const hex = token.replace(/-/g, '').toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`
}
