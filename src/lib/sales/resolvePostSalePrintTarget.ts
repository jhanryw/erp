/**
 * Regra definitiva de impressão/QR Code — decide, logo após criar uma
 * venda, qual ÚNICA aba de impressão pré-aberta deve receber (nunca as
 * duas: ver comentário em vendas/nova/page.tsx sobre por que só uma aba
 * about:blank é pré-aberta por clique).
 *
 * Módulo PURO e testável — extraído de vendas/nova/page.tsx pra poder
 * cobrir a regra de precedência sem precisar de jsdom/Testing Library
 * (não configurado neste repo).
 *
 * Precedência (ordem que importa): documento fiscal AUTORIZADO nesta
 * mesma requisição SEMPRE vence sobre o comprovante não fiscal —
 * `printNonFiscalReceipt` (config estática da policy) só é consultado
 * quando NENHUM documento acabou de ser autorizado. Isso garante que uma
 * NFC-e/NF-e recém-autorizada nunca resulta em impressão do comprovante
 * interno, mesmo que a policy estivesse inconsistente (auto_issue e
 * print_non_fiscal_receipt ambos true) — hoje bloqueado na origem por
 * validação (Zod em /api/configuracoes/fiscal/policies), mas nunca
 * confiado cegamente aqui, em runtime.
 */

export interface PostSaleFiscalResult {
  status: string
  requested: 'nfce' | 'nfe'
}

export interface PostSaleFiscalPrintPolicy {
  autoPrint: boolean
  printNonFiscalReceipt: boolean
}

export interface ResolvePostSalePrintTargetInput {
  saleId: number
  fiscal: PostSaleFiscalResult | null | undefined
  fiscalPrint: PostSaleFiscalPrintPolicy | null | undefined
}

export interface PostSalePrintTarget {
  url: string | null
  /** `fiscal_authorized` — abriu o DANFE NFC-e local. `non_fiscal_receipt` — abriu o comprovante interno (QR Qarvon). `none` — nada a imprimir automaticamente. */
  reason: 'fiscal_authorized' | 'non_fiscal_receipt' | 'none'
}

export function resolvePostSalePrintTarget(input: ResolvePostSalePrintTargetInput): PostSalePrintTarget {
  const fiscalJustAuthorized = input.fiscal?.status === 'authorized'

  // Auto-impressão automática do DANFE só existe hoje pra NFC-e (página
  // local /vendas/[id]/nfce) — NF-e autorizada não abre nada aqui sozinha
  // (o DANFE oficial é hospedado pela Focus, ver resolveFocusResourceUrl; não
  // há auto-open dele nesta fase, só o botão contextual na tela da venda).
  const autoPrintedFiscal = !!input.fiscalPrint?.autoPrint && fiscalJustAuthorized && input.fiscal?.requested === 'nfce'

  // Nunca avalia a policy estática quando um documento acabou de ser
  // autorizado — esse é o ponto central da regra de precedência.
  const shouldPrintReceipt = !fiscalJustAuthorized && (input.fiscalPrint?.printNonFiscalReceipt ?? true)

  if (autoPrintedFiscal) return { url: `/vendas/${input.saleId}/nfce`, reason: 'fiscal_authorized' }
  if (shouldPrintReceipt) return { url: `/vendas/${input.saleId}/comprovante`, reason: 'non_fiscal_receipt' }
  return { url: null, reason: 'none' }
}
