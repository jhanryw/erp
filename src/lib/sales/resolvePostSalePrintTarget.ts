import { resolveFocusResourceUrl } from '@/lib/fiscal/resolveFocusResourceUrl'
import type { FocusEnvironment } from '@/lib/integrations/focus/types'

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
 *
 * ─── SIMPLIFICAÇÃO DA ARQUITETURA DE IMPRESSÃO (decisão do usuário,
 * pós-testes reais de emissão) ────────────────────────────────────────────
 *
 * O DANFE NFC-e LOCAL (`/vendas/[id]/nfce`) deixou de ser o destino
 * padrão pra qualquer documento autorizado — NFC-e e NF-e agora abrem o
 * DANFE oficial da FOCUS (`fiscal_documents.danfe_path`, resolvido
 * EXCLUSIVAMENTE por `resolveFocusResourceUrl`, nunca concatenado à mão).
 * A página local continua existindo só como fallback/debug (não é mais
 * alcançada por este módulo).
 *
 * ─── `environment` — CORRIGIDO (achado real, pré-produção): não é mais um
 * literal 'homologacao' hardcoded ────────────────────────────────────────
 *
 * `input.fiscal.environment` é a identidade REAL do documento fiscal
 * (`fiscal_documents.environment`), propagada até aqui por
 * `executeFiscalPolicy.ts` a partir de `SubmitNfeResult.environment` (que
 * por sua vez vem de `rowToResult`/`claimFiscalEmission`/
 * `completeFiscalEmission` — ver comentário completo em
 * `FiscalDocumentRow.environment`, `submitNfeHomologacao.ts`). Nenhuma
 * inferência por host/token/status/config atual — o valor é o mesmo que
 * o serviço de emissão usou pra reclamar/persistir o documento. Se por
 * qualquer motivo ele vier ausente num documento "authorized" (nunca
 * deveria acontecer, dado o pipeline acima), trata como o MESMO estado
 * explícito de `danfe_path` ausente — nunca assume 'homologacao' como
 * fallback silencioso.
 */

export interface PostSaleFiscalResult {
  status: string
  requested: 'nfce' | 'nfe'
  /** Caminho RELATIVO devolvido pela Focus (`caminho_danfe`) — nunca uma URL pronta. `null`/ausente = documento autorizado sem DANFE local persistido ainda. */
  danfePath?: string | null
  /** Ambiente REAL do documento (`fiscal_documents.environment`) — nunca um literal fixo. `null`/ausente só é esperado quando `status !== 'authorized'` (aí não é usado). */
  environment?: FocusEnvironment | null
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
  /**
   * `fiscal_authorized` — abriu o DANFE oficial da Focus (NFC-e ou NF-e).
   * `fiscal_authorized_missing_danfe` — documento autorizado, mas sem
   * `danfe_path` e/ou `environment` real suficientes pra resolver a URL —
   * estado explícito, NUNCA cai silenciosamente pro comprovante não
   * fiscal nem assume um ambiente por suposição (o operador precisa saber
   * que falta algo, não ver um comprovante comercial normal como se nada
   * tivesse acontecido).
   * `non_fiscal_receipt` — abriu o comprovante interno (QR Qarvon).
   * `none` — nada a imprimir automaticamente.
   */
  reason: 'fiscal_authorized' | 'fiscal_authorized_missing_danfe' | 'non_fiscal_receipt' | 'none'
}

export function resolvePostSalePrintTarget(input: ResolvePostSalePrintTargetInput): PostSalePrintTarget {
  const fiscalJustAuthorized = input.fiscal?.status === 'authorized'

  if (fiscalJustAuthorized) {
    // Nunca avalia a policy estática de comprovante quando um documento
    // acabou de ser autorizado — esse é o ponto central da regra de
    // precedência. Só decide impressão automática do DANFE se a política
    // da empresa pedir (`autoPrint`) — nunca imprime nada mais nesse caso
    // (nem o comprovante, mesmo com a policy inconsistente pedindo isso).
    if (!input.fiscalPrint?.autoPrint) return { url: null, reason: 'none' }

    const danfePath = input.fiscal?.danfePath ?? null
    const environment = input.fiscal?.environment ?? null
    // Sem dado real suficiente (danfe_path e/ou environment) — nunca
    // inventa um ambiente pra tentar montar a URL mesmo assim.
    if (!danfePath || !environment) return { url: null, reason: 'fiscal_authorized_missing_danfe' }

    const focusUrl = resolveFocusResourceUrl({ path: danfePath, environment })
    if (focusUrl) return { url: focusUrl, reason: 'fiscal_authorized' }
    return { url: null, reason: 'fiscal_authorized_missing_danfe' }
  }

  const shouldPrintReceipt = input.fiscalPrint?.printNonFiscalReceipt ?? true
  if (shouldPrintReceipt) return { url: `/vendas/${input.saleId}/comprovante`, reason: 'non_fiscal_receipt' }
  return { url: null, reason: 'none' }
}
